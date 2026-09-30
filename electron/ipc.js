'use strict';

const path = require('node:path');
const { app, ipcMain } = require('electron');
const { readSettings, writeSettings } = require('./settings');
const { getContext, getContextStatus } = require('./context');
const { createTextRequestBody, createVisionRequestBody } = require('./prompts');
const { streamChatCompletion, transcribeWithWhisper } = require('./openai');
const { captureScreen } = require('./capture');
const { resizeHeight } = require('./window');
const { buildTraceRecord, appendTrace } = require('./trace');
const { createConversation } = require('./conversation');

const DEFAULT_ANSWER_MODEL = 'gpt-4o'; // override with "answerModel" in the settings file
// Used once when the answer model is rate-limited, erroring or silent. It has
// its own rate limit, so it usually answers right away. "fallbackModel": "" turns it off.
const DEFAULT_FALLBACK_MODEL = 'gpt-4o-mini';
const TURN_KINDS = ['interviewer', 'pasted', 'request'];

const activeRequests = new Map(); // requestId → AbortController
const conversation = createConversation(); // the interview so far; answers are added when they complete

// payload: { question, turnKind } or { imageBase64, imageType }.
function buildAnswerRequest(payload, settings, model) {
  const options = {
    model,
    style: settings.answerStyle === 'detailed' ? 'detailed' : 'brief',
    context: getContext(),
    history: conversation.messages()
  };
  if (payload.imageBase64) {
    const body = createVisionRequestBody({ ...options, imageBase64: payload.imageBase64, imageType: payload.imageType });
    return { body, turn: { kind: 'screen', text: '' } };
  }
  const question = payload.question?.trim();
  if (!question) throw new Error('No question to answer. Listen, paste text or analyze the screen first.');
  const kind = TURN_KINDS.includes(payload.turnKind) ? payload.turnKind : 'interviewer';
  const turn = conversation.prepareTurn({ kind, text: question });
  return { body: createTextRequestBody({ ...options, turn }), turn };
}

async function runAnswerRequest(sender, payload) {
  const { requestId } = payload;
  const apiKey = payload.apiKey?.trim();
  if (!apiKey) throw new Error('Enter your OpenAI API key before sending.');

  const settings = readSettings();
  const model = settings.answerModel?.trim() || DEFAULT_ANSWER_MODEL;
  const fallbackModel = (settings.fallbackModel ?? DEFAULT_FALLBACK_MODEL).trim();
  conversation.removeLast(payload.replaces); // regenerate: the answer being redone leaves the history
  const { body, turn } = buildAnswerRequest(payload, settings, model);
  const timing = { model };
  console.log(`[openai] ${requestId} started (${model})`);

  // A retryable failure always happens before the first token, so switching
  // models never duplicates text on screen. Only new text crosses IPC.
  const stream = (requestBody) => {
    const controller = new AbortController();
    activeRequests.set(requestId, controller);
    let sentLength = 0;
    return streamChatCompletion({
      apiKey,
      body: requestBody,
      controller,
      timing,
      onDelta: (textSoFar) => {
        sender.send('openai:delta', { requestId, delta: textSoFar.slice(sentLength) });
        sentLength = textSoFar.length;
      }
    });
  };

  try {
    let text;
    try {
      text = await stream(body);
    } catch (error) {
      const cancelled = !activeRequests.has(requestId);
      if (!error.retryable || cancelled || !fallbackModel || fallbackModel === model) throw error;
      console.warn(`[openai] ${requestId} ${error.message} Falling back to ${fallbackModel}.`);
      Object.assign(timing, { model: fallbackModel, fallback: true, fallbackReason: error.message });
      text = await stream(buildAnswerRequest(payload, settings, fallbackModel).body);
    }
    timing.doneAt = Date.now();
    console.log(`[openai] ${requestId} done: ${text.length} chars`);
    conversation.add(turn, text, requestId);
    sender.send('openai:done', { requestId, text, timing, exchanges: conversation.size });
  } catch (error) {
    error.timing = timing;
    throw error;
  } finally {
    activeRequests.delete(requestId);
  }
}

function getTracePath() {
  return path.join(app.getPath('userData'), 'traces.jsonl');
}

function registerIpcHandlers(realtime) {
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.on('app:resize-height', (_event, height) => resizeHeight(height));
  ipcMain.handle('app:capture-screen', () => captureScreen());

  ipcMain.handle('settings:get', (_event, key) => readSettings()[key] ?? null);
  ipcMain.handle('settings:set', (_event, key, value) => writeSettings({ [key]: value }));
  ipcMain.handle('context:status', () => getContextStatus());
  ipcMain.on('trace:write', (_event, raw) => appendTrace(getTracePath(), buildTraceRecord(raw)));

  ipcMain.on('openai:run', (event, payload) => {
    runAnswerRequest(event.sender, payload).catch((error) => {
      if (error.name === 'AbortError') return; // cancelled by the user
      console.error('[openai] error:', error.message);
      event.sender.send('openai:error', { requestId: payload.requestId, message: error.message, timing: error.timing });
    });
  });

  ipcMain.on('openai:cancel', (_event, requestId) => {
    activeRequests.get(requestId)?.abort();
    activeRequests.delete(requestId);
  });

  ipcMain.handle('conversation:clear', () => conversation.clear());

  ipcMain.handle('whisper:transcribe', (_event, { apiKey, wav }) => {
    if (!apiKey?.trim() || !wav) return { text: '', error: 'Missing API key or audio data.' };
    return transcribeWithWhisper({ apiKey: apiKey.trim(), wav });
  });

  // Always-on listening: start is idempotent (also applies setting changes),
  // take-block returns everything heard since the last send.
  ipcMain.handle('realtime:start', (_event, { apiKey }) => {
    const vadSilenceMs = Number(readSettings().vadSilenceMs) || undefined;
    return realtime.start(apiKey, { vadSilenceMs });
  });
  ipcMain.on('realtime:audio-chunk', (_event, pcm) => realtime.appendAudio(pcm));
  ipcMain.handle('realtime:take-block', () => realtime.takeBlock());
  ipcMain.handle('realtime:reset-block', () => realtime.resetBlock());
}

module.exports = { registerIpcHandlers };
