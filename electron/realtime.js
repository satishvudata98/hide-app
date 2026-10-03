'use strict';

const WebSocket = require('ws');
const { describeSocketError } = require('./errors');

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const CONNECT_TIMEOUT_MS = 10_000;
const BLOCK_WAIT_MS = 2_000; // max wait for the block's last transcript (normally <= 1.2s), then Whisper takes over
const ROTATE_AFTER_MS = 25 * 60_000; // reconnect in a quiet moment, before the server's session limit
const AUDIO_LOG_MS = 60_000; // audio kept per socket, replayed after an unexpected disconnect
const QUEUE_MAX_MS = 15_000; // audio queued while (re)connecting
const REPLAY_PAD_MS = 300; // replay a little before the speech start, like VAD's prefix padding
const BYTES_PER_MS = 48; // 24kHz mono PCM16
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000];
const DEFAULT_VAD_SILENCE_MS = 300;
const MAX_SEGMENTS = 400; // oldest unsent segments are dropped past this (hours without a send)
const MAX_BLOCK_CHARS = 6000; // ~5 minutes of speech; older text in one block is cut
const FORCED_TAIL_MS = 500; // leftover VAD segment after a mid-speech commit, dropped when shorter
// A send while speech is open first gives VAD this long past its silence
// window to commit by itself: our commit racing VAD's can hang the server.
const VAD_GRACE_EXTRA_MS = 150;
const STALL_MS = 4_000; // a committed segment without a transcript this long means the socket is stuck

function reconnectDelay(attempt) {
  return RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
}

function isExpectedCommitError(error) {
  // Committing an empty buffer is expected when server VAD already committed it.
  return error?.code === 'input_audio_buffer_commit_empty' || /buffer only has/i.test(error?.message || '');
}

function isFatalSocketError(error) {
  const status = Number(/Unexpected server response: (\d+)/.exec(error?.message || '')?.[1]);
  return status === 401 || status === 403;
}

// Keeps the end of an over-long block, starting at a word boundary.
function capBlockText(text) {
  if (text.length <= MAX_BLOCK_CHARS) return text;
  const tail = text.slice(-MAX_BLOCK_CHARS);
  return tail.slice(tail.indexOf(' ') + 1);
}

// Pure transcript bookkeeping for an always-on session. Server VAD commits a
// segment at every pause; segments are keyed by item_id and kept in commit
// order. `cursor` splits them: before it = already sent, from it on = the
// pending block, i.e. what the next send will answer.
function createTranscriptTracker() {
  let items = new Map(); // item_id → { text, done, startMs, committedAt }
  let order = [];
  let cursor = 0;
  let speechOpen = false; // speech started, not committed yet
  let openSpeechStartMs = null;
  let startedSinceCommit = false; // a speech_started arrived since the last commit
  let forcedCommitAtMs = null; // audio position of our last mid-speech commit
  let lastSpeechEndMs = null;
  let blockEnd; // while a send waits: where the block ends, or null until the forced commit lands
  let discardUntilCleared = false; // after resetBlock(), until the server confirms the buffer clear

  // After our mid-speech commit, VAD still thinks speech is open and later
  // commits the leftover tail (a few hundred ms, mostly silence) without a new
  // speech_started. Transcribing that tail gives nothing useful or, worse,
  // invented text, so it is dropped. Longer tails are real speech and kept.
  function isForcedCommitTail() {
    return !startedSinceCommit && forcedCommitAtMs !== null && Number.isFinite(lastSpeechEndMs) &&
      lastSpeechEndMs - forcedCommitAtMs < FORCED_TAIL_MS;
  }

  const textOf = (ids) => ids.map((id) => items.get(id).text.trim()).filter(Boolean).join(' ');
  const unsent = () => order.slice(cursor);

  function dropSent() {
    for (const id of order.slice(0, cursor)) items.delete(id);
    order = order.slice(cursor);
    if (blockEnd != null) blockEnd = Math.max(0, blockEnd - cursor);
    cursor = 0;
  }

  return {
    pendingText: () => textOf(unsent()),
    isSpeaking: () => speechOpen,
    isIdle: () => !speechOpen && blockEnd === undefined && unsent().every((id) => items.get(id).done),

    // The send hotkey was pressed. Returns true when speech is still open: the
    // block then ends at the next commit (VAD's, or ours via markForcedCommit).
    beginBlock() {
      blockEnd = speechOpen ? null : order.length;
      return speechOpen;
    },

    // True while a send waits for speech that VAD hasn't committed yet.
    needsCommit: () => blockEnd === null && speechOpen,

    // We committed mid-speech at audio position `audioMs`.
    markForcedCommit(audioMs) {
      forcedCommitAtMs = audioMs;
    },

    // Age of the oldest committed segment still waiting for its transcript.
    oldestUnfinishedMs(now = Date.now()) {
      const ages = unsent().filter((id) => !items.get(id).done).map((id) => now - items.get(id).committedAt);
      return ages.length ? Math.max(...ages) : 0;
    },

    blockReady() {
      return blockEnd != null && order.slice(cursor, blockEnd).every((id) => items.get(id).done);
    },

    // Moves the cursor past the block and returns its text. Segments still in
    // flight are included with whatever text has streamed so far.
    finishBlock() {
      const end = blockEnd ?? order.length;
      const ids = order.slice(cursor, end);
      const complete = ids.every((id) => items.get(id).done);
      const text = capBlockText(textOf(ids));
      cursor = end;
      blockEnd = undefined;
      dropSent();
      return { text, segments: ids.length, complete };
    },

    // Throws away the pending block. The caller also clears the server buffer,
    // so speech in progress is dropped too.
    resetBlock() {
      cursor = order.length;
      blockEnd = undefined;
      speechOpen = false;
      openSpeechStartMs = null;
      discardUntilCleared = true;
      dropSent();
    },

    // Where audio replay should start after an unexpected disconnect: the
    // start of the earliest unsent segment the old socket never finished.
    replayStartMs() {
      const starts = unsent().filter((id) => !items.get(id).done).map((id) => items.get(id).startMs);
      if (speechOpen) starts.push(openSpeechStartMs);
      const known = starts.filter(Number.isFinite);
      return known.length ? Math.min(...known) : null;
    },

    // The old socket is gone: its unfinished segments will never complete.
    // Their audio is replayed on the new socket, which makes new segments.
    dropUnfinished() {
      for (const id of unsent()) if (!items.get(id).done) items.delete(id);
      order = order.filter((id) => items.has(id));
      speechOpen = false;
      openSpeechStartMs = null;
      discardUntilCleared = false;
    },

    // Returns true when the pending text or speaking state changed.
    handleEvent(event) {
      const item = items.get(event.item_id);

      switch (event.type) {
        case 'input_audio_buffer.speech_started':
          startedSinceCommit = true;
          forcedCommitAtMs = null; // a new turn: no leftover tail is coming
          if (discardUntilCleared) return false;
          speechOpen = true;
          openSpeechStartMs = Number.isFinite(event.audio_start_ms) ? event.audio_start_ms : null;
          return true;

        case 'input_audio_buffer.speech_stopped':
          lastSpeechEndMs = Number.isFinite(event.audio_end_ms) ? event.audio_end_ms : null;
          return false;

        case 'input_audio_buffer.committed': {
          const tail = isForcedCommitTail();
          startedSinceCommit = false;
          if (tail) {
            forcedCommitAtMs = null;
            return false; // not tracked, so its transcription events are ignored
          }
          if (!item) {
            items.set(event.item_id, { text: '', done: false, startMs: openSpeechStartMs, committedAt: Date.now() });
            order.push(event.item_id);
          }
          if (discardUntilCleared) {
            cursor = order.length; // committed before the clear: part of the discarded block
            dropSent();
            return true;
          }
          speechOpen = false;
          openSpeechStartMs = null;
          if (blockEnd === null) blockEnd = order.length;
          if (order.length - cursor > MAX_SEGMENTS) {
            cursor = order.length - MAX_SEGMENTS;
            dropSent();
          }
          return true;
        }

        case 'input_audio_buffer.cleared':
          discardUntilCleared = false;
          return false;

        // Items only exist from their commit on; events for unknown items are
        // leftovers from sent or discarded segments and are ignored.
        case 'conversation.item.input_audio_transcription.delta':
          if (!item || item.done) return false;
          item.text += event.delta || '';
          return true;

        case 'conversation.item.input_audio_transcription.completed':
          if (!item) return false;
          item.text = event.transcript || '';
          item.done = true;
          return true;

        case 'conversation.item.input_audio_transcription.failed':
          if (!item) return false;
          item.done = true;
          console.warn('[realtime] transcription failed:', JSON.stringify(event.error));
          return true;

        case 'error':
          if (!isExpectedCommitError(event.error)) return false;
          if (blockEnd === null) blockEnd = order.length; // VAD had already committed everything
          speechOpen = false;
          return true;

        default:
          return false;
      }
    }
  };
}

// No vocabulary prompt: in replay tests it didn't improve accuracy, and the
// model turned near-silent segments into invented text built from it.
function sessionUpdate({ vadSilenceMs = DEFAULT_VAD_SILENCE_MS, model = 'gpt-4o-transcribe' } = {}) {
  const transcription = { model, language: 'en' };
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          transcription,
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: vadSilenceMs }
        }
      }
    }
  };
}

// One always-on transcription session. The socket reconnects by itself; the
// transcript lives in the tracker, so a reconnect loses nothing: audio of
// segments the old socket didn't finish is replayed on the new one.
// `emit(channel, payload)` sends updates to the renderer. `WebSocketImpl` is
// swappable for tests; `onServerEvent` sees every raw event (replay harness).
function createRealtimeSession(emit, { WebSocketImpl = WebSocket, onServerEvent } = {}) {
  const tracker = createTranscriptTracker();
  let ws = null;
  let apiKey = '';
  let config = {};
  let wanted = false; // start() was called and close() was not: keep a socket open
  let fatalError = ''; // bad key: stop reconnecting until start() is called again
  let lastError = '';
  let connectedAt = 0;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let healthTimer = null;
  let queue = []; // { audio, ms } waiting for the socket to open
  let audioLog = []; // { audio, ms, at } sent on the current socket
  let socketMs = 0; // audio ms appended on the current socket
  let whisperCoveredMs = -Infinity; // audio up to here went to Whisper with a degraded send
  let pendingBlock = null; // { check, finish } while a send waits for its last segment
  let status = 'offline';

  const isOpen = () => ws?.readyState === WebSocketImpl.OPEN;
  const send = (message) => ws.send(JSON.stringify(message));

  function setStatus(next, message = '') {
    if (next === status && !message) return;
    status = next;
    emit('realtime:status', { state: status, message });
  }

  function emitPending() {
    emit('realtime:pending', { text: tracker.pendingText(), speaking: tracker.isSpeaking() });
  }

  function onEvent(event) {
    onServerEvent?.(event, socketMs);
    if (event.type === 'error' && !isExpectedCommitError(event.error)) {
      console.error('[realtime] API error:', event.error?.message);
      emit('realtime:error', { message: `Live transcript: ${event.error?.message || 'Realtime API error'}` });
    }
    if (tracker.handleEvent(event)) emitPending();
    pendingBlock?.check();
  }

  function sendAudio(chunk) {
    send({ type: 'input_audio_buffer.append', audio: chunk.audio });
    audioLog.push({ ...chunk, at: socketMs });
    socketMs += chunk.ms;
    while (audioLog.length && audioLog[0].at < socketMs - AUDIO_LOG_MS) audioLog.shift();
  }

  function enqueue(chunks, { front = false } = {}) {
    queue = front ? [...chunks, ...queue] : [...queue, ...chunks];
    let total = queue.reduce((sum, chunk) => sum + chunk.ms, 0);
    while (total > QUEUE_MAX_MS && queue.length) total -= queue.shift().ms;
  }

  function openSocket() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    setStatus(reconnectAttempt ? 'reconnecting' : 'connecting', lastError);
    console.log('[realtime] connecting');

    const socket = new WebSocketImpl(REALTIME_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    ws = socket;
    socketMs = 0;
    whisperCoveredMs = -Infinity;
    audioLog = [];
    const connectTimeout = setTimeout(() => socket.terminate(), CONNECT_TIMEOUT_MS);

    socket.on('open', () => {
      clearTimeout(connectTimeout);
      if (ws !== socket) return;
      connectedAt = Date.now();
      reconnectAttempt = 0;
      lastError = '';
      send(sessionUpdate(config));
      const queued = queue;
      queue = [];
      for (const chunk of queued) sendAudio(chunk);
      setStatus('connected');
    });

    socket.on('message', (data) => {
      if (ws !== socket) return; // late event from a replaced socket
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }
      onEvent(event);
    });

    socket.on('error', (error) => {
      console.error('[realtime] WebSocket error:', error.message);
      if (ws !== socket) return;
      lastError = describeSocketError(error);
      if (isFatalSocketError(error)) fatalError = lastError;
    });

    socket.on('close', () => {
      clearTimeout(connectTimeout);
      if (ws !== socket) return;
      ws = null;
      onDrop();
    });
  }

  // The socket is gone. A send in progress can't complete (the renderer falls
  // back to Whisper); otherwise unfinished speech is replayed on the next socket.
  function onDrop({ immediate = false } = {}) {
    pendingBlock?.finish(true);
    const replayFrom = tracker.replayStartMs();
    tracker.dropUnfinished();
    if (replayFrom !== null) {
      // Audio a degraded send already gave to Whisper is never replayed, or
      // the same question would show up again in the next block.
      const from = Math.max(replayFrom - REPLAY_PAD_MS, whisperCoveredMs);
      const replay = audioLog.filter((chunk) => chunk.at + chunk.ms > from && chunk.at >= whisperCoveredMs);
      console.log(`[realtime] replaying ${replay.length} chunks after disconnect`);
      enqueue(replay.map(({ audio, ms }) => ({ audio, ms })), { front: true });
    }
    audioLog = [];
    emitPending();

    if (!wanted) return setStatus('offline');
    if (fatalError) {
      emit('realtime:error', { message: fatalError });
      return setStatus('offline', fatalError);
    }
    const delay = immediate ? 0 : reconnectDelay(reconnectAttempt++);
    setStatus('reconnecting', lastError);
    reconnectTimer = setTimeout(openSocket, delay);
  }

  // Detaches the current socket right away (no waiting for the close
  // handshake) and reconnects at once.
  function replaceSocket() {
    const old = ws;
    ws = null;
    old.close();
    onDrop({ immediate: true });
  }

  // Runs every second: reconnects a stuck socket (a transcript that never
  // arrives; the segment's audio is replayed) and rotates old sessions in a
  // quiet moment, before the server's session limit.
  function checkHealth() {
    if (!isOpen()) return;
    if (tracker.oldestUnfinishedMs() > STALL_MS) {
      console.warn('[realtime] transcription stalled, reconnecting');
      lastError = 'Live transcript stalled, reconnecting…';
      replaceSocket();
    } else if (Date.now() - connectedAt > ROTATE_AFTER_MS && tracker.isIdle()) {
      console.log('[realtime] rotating session');
      replaceSocket();
    }
  }

  return {
    // Idempotent: opens the socket if needed and applies config changes.
    start(key, nextConfig = {}) {
      const keyChanged = key !== apiKey;
      apiKey = key;
      config = nextConfig;
      wanted = true;
      fatalError = '';
      healthTimer ??= setInterval(checkHealth, 1_000);
      if (ws && keyChanged) replaceSocket();
      else if (isOpen()) send(sessionUpdate(config));
      else if (!ws && !reconnectTimer) openSocket();
      emitPending();
      return { ok: true };
    },

    appendAudio(pcm) {
      if (!wanted) return;
      const chunk = { audio: Buffer.from(pcm).toString('base64'), ms: pcm.byteLength / BYTES_PER_MS };
      if (isOpen()) sendAudio(chunk);
      else enqueue([chunk]);
    },

    // Everything heard since the last send, up to now. Speech still in
    // progress is closed without stopping (by VAD if the interviewer just
    // stopped, else by our commit), then the block's segments get up to
    // BLOCK_WAIT_MS for their final text. `degraded` means the transcript
    // can't be trusted (socket down, or a segment never finished) and the
    // caller should use Whisper on the audio instead.
    takeBlock() {
      pendingBlock?.finish(false);
      return new Promise((resolve) => {
        if (!isOpen()) {
          // Reconnecting: everything queued so far is covered by Whisper.
          queue = [];
          const block = tracker.finishBlock();
          emitPending();
          return resolve({ ...block, degraded: true });
        }

        const pressedAtMs = socketMs;
        let timeout = null;
        let commitTimer = null;
        const finish = (dropped) => {
          clearTimeout(timeout);
          clearTimeout(commitTimer);
          pendingBlock = null;
          const block = tracker.finishBlock();
          const degraded = dropped || !block.complete;
          if (degraded) whisperCoveredMs = pressedAtMs;
          emitPending();
          resolve({ ...block, degraded });
          // A segment that never finished usually means a stuck socket; the
          // watchdog can't see it any more once it's sent, so replace it now.
          if (!dropped && !block.complete && isOpen()) {
            console.warn('[realtime] block incomplete, reconnecting');
            replaceSocket();
          }
        };

        if (tracker.beginBlock()) {
          const graceMs = (config.vadSilenceMs || DEFAULT_VAD_SILENCE_MS) + VAD_GRACE_EXTRA_MS;
          commitTimer = setTimeout(() => {
            if (!isOpen() || !tracker.needsCommit()) return;
            tracker.markForcedCommit(socketMs);
            send({ type: 'input_audio_buffer.commit' });
          }, graceMs);
        }
        if (tracker.blockReady()) return finish(false);
        timeout = setTimeout(() => finish(false), BLOCK_WAIT_MS);
        pendingBlock = { check: () => tracker.blockReady() && finish(false), finish };
      });
    },

    resetBlock() {
      pendingBlock?.finish(false);
      tracker.resetBlock();
      if (isOpen()) send({ type: 'input_audio_buffer.clear' });
      emitPending();
    },

    close() {
      wanted = false;
      clearTimeout(reconnectTimer);
      clearInterval(healthTimer);
      reconnectTimer = null;
      healthTimer = null;
      const old = ws;
      ws = null;
      old?.close();
    }
  };
}

module.exports = { createTranscriptTracker, createRealtimeSession, reconnectDelay, sessionUpdate, capBlockText };
