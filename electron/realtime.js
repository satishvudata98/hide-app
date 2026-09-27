'use strict';

const WebSocket = require('ws');

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const CONNECT_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;

function isExpectedCommitError(error) {
  // Committing an empty buffer is expected when server VAD already committed it.
  return error?.code === 'input_audio_buffer_commit_empty' || /buffer only has/i.test(error?.message || '');
}

// Pure transcript bookkeeping for one recording. Segments are keyed by item_id
// and kept in commit order, so late or out-of-order completions still assemble
// correctly. handleEvent() returns what the caller should tell the UI.
function createTranscriptTracker() {
  let items = new Map(); // item_id → { text, done }
  let order = [];
  let awaitingCommit = false; // speech started (or manual commit sent) but not committed yet
  let vadSeen = false; // server VAD reported speech at least once this recording
  let hasUncommittedAudio = false;
  let acceptingEvents = true; // false until the server confirms a buffer clear

  const transcript = () => order.map((id) => items.get(id).text.trim()).filter(Boolean).join(' ');

  return {
    transcript,

    reset({ awaitClear = false } = {}) {
      items = new Map();
      order = [];
      awaitingCommit = false;
      vadSeen = false;
      hasUncommittedAudio = false;
      acceptingEvents = !awaitClear;
    },

    noteAudioAppended() {
      hasUncommittedAudio = true;
    },

    // With server VAD the buffer is usually already committed once the speaker
    // pauses; only commit when speech is still open (or VAD never reported).
    shouldCommitOnStop() {
      return awaitingCommit || (!vadSeen && hasUncommittedAudio);
    },

    markCommitSent() {
      awaitingCommit = true;
    },

    hasPending() {
      return awaitingCommit || order.some((id) => !items.get(id).done);
    },

    handleEvent(event) {
      if (!acceptingEvents) {
        if (event.type === 'input_audio_buffer.cleared') acceptingEvents = true;
        return null;
      }

      const item = items.get(event.item_id);

      switch (event.type) {
        case 'input_audio_buffer.speech_started':
          vadSeen = true;
          awaitingCommit = true;
          return { kind: 'state' };

        case 'input_audio_buffer.committed':
          awaitingCommit = false;
          hasUncommittedAudio = false;
          if (!item) {
            items.set(event.item_id, { text: '', done: false });
            order.push(event.item_id);
          }
          return { kind: 'state' };

        // Items are only created on commit; events for unknown items are
        // leftovers from before a clear and are ignored.
        case 'conversation.item.input_audio_transcription.delta':
          if (!item) return null;
          item.text += event.delta || '';
          return { kind: 'delta', text: transcript() };

        case 'conversation.item.input_audio_transcription.completed':
          if (!item) return null;
          item.text = event.transcript || '';
          item.done = true;
          return { kind: 'completed', text: transcript() };

        case 'conversation.item.input_audio_transcription.failed':
          if (!item) return null;
          item.done = true;
          console.warn('[realtime] transcription failed:', JSON.stringify(event.error));
          return { kind: 'state' };

        case 'error':
          awaitingCommit = false;
          if (isExpectedCommitError(event.error)) return { kind: 'state' };
          return { kind: 'error', message: event.error?.message || 'Realtime API error' };

        default:
          return null;
      }
    }
  };
}

// One WebSocket that stays open between recordings. Starting again on an open
// socket just clears the server-side buffer. `emit(channel, payload)` sends
// transcript updates to the renderer.
function createRealtimeSession(emit) {
  const tracker = createTranscriptTracker();
  let ws = null;
  let pendingAudio = []; // base64 chunks sent while the socket is still connecting
  let stopWaiter = null; // (force?) => void, re-checked whenever the tracker changes

  function onEvent(event) {
    const update = tracker.handleEvent(event);
    if (!update) return;
    if (update.kind === 'delta') emit('realtime:transcript-delta', { displayText: update.text });
    if (update.kind === 'completed') emit('realtime:transcript-done', { transcript: update.text });
    if (update.kind === 'error') {
      console.error('[realtime] API error:', update.message);
      emit('realtime:error', { message: update.message });
    }
    if (stopWaiter) stopWaiter();
  }

  function connect(apiKey) {
    pendingAudio = [];
    console.log('[realtime] connecting');

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(REALTIME_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
      ws = socket;

      const connectTimeout = setTimeout(() => {
        socket.terminate();
        reject(new Error('Realtime WebSocket connection timed out.'));
      }, CONNECT_TIMEOUT_MS);

      socket.on('open', () => {
        clearTimeout(connectTimeout);
        socket.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: { input: { transcription: { model: 'gpt-4o-transcribe', language: 'en' } } }
          }
        }));
        for (const audio of pendingAudio) socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
        pendingAudio = [];
        resolve({ ok: true });
      });

      socket.on('message', (data) => {
        if (ws !== socket) return; // late event from a replaced socket
        try { onEvent(JSON.parse(data.toString())); } catch { /* ignore malformed event */ }
      });

      socket.on('error', (error) => {
        console.error('[realtime] WebSocket error:', error.message);
        emit('realtime:error', { message: error.message });
        reject(error);
      });

      socket.on('close', () => {
        clearTimeout(connectTimeout);
        if (ws !== socket) return;
        ws = null;
        if (stopWaiter) stopWaiter(true);
      });
    });
  }

  return {
    start(apiKey) {
      if (ws?.readyState === WebSocket.OPEN) {
        // Ignore events until the server confirms the clear, so leftovers from
        // the previous recording can't leak into this one.
        tracker.reset({ awaitClear: true });
        ws.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
        return Promise.resolve({ ok: true });
      }
      tracker.reset();
      if (ws?.readyState === WebSocket.CONNECTING) return Promise.resolve({ ok: true });
      return connect(apiKey);
    },

    appendAudio(pcm) {
      if (!ws) return;
      const audio = Buffer.from(pcm).toString('base64');
      tracker.noteAudioAppended();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
      else if (ws.readyState === WebSocket.CONNECTING) pendingAudio.push(audio);
    },

    // Resolves once every committed segment has its final transcript, so the
    // tail of the question is not lost. Returns immediately when nothing is pending.
    stop() {
      return new Promise((resolve) => {
        let timeout = null;
        const finish = () => {
          clearTimeout(timeout);
          stopWaiter = null;
          resolve({ transcript: tracker.transcript() });
        };

        if (ws?.readyState !== WebSocket.OPEN) return finish();

        if (tracker.shouldCommitOnStop()) {
          tracker.markCommitSent();
          ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        }
        if (!tracker.hasPending()) return finish();

        timeout = setTimeout(finish, STOP_TIMEOUT_MS);
        stopWaiter = (force = false) => {
          if (force || !tracker.hasPending()) finish();
        };
      });
    },

    close() {
      if (ws) ws.close();
      ws = null;
    }
  };
}

module.exports = { createTranscriptTracker, createRealtimeSession };
