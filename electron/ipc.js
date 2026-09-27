'use strict';

const { app, ipcMain } = require('electron');
const { readSettings, writeSettings } = require('./settings');
const { getContext, getContextStatus } = require('./context');
const { createTextRequestBody, createVisionRequestBody } = require('./prompts');
const { streamChatCompletion, transcribeWithWhisper } = require('./openai');
const { captureScreen } = require('./capture');
const { resizeHeight } = require('./window');

const DEFAULT_ANSWER_MODEL = 'gpt-4o'; // override with "answerModel" in the settings file

const activeRequests = new Map(); // requestId → AbortController

function buildAnswerRequestBody(payload) {
  const settings = readSettings();
  const options = {
    model: settings.answerModel?.trim() || DEFAULT_ANSWER_MODEL,
    style: settings.answerStyle === 'detailed' ? 'detailed' : 'brief',
    context: getContext(),
    history: Array.isArray(payload.conversationHistory) ? payload.conversationHistory : []
  };
  if (payload.imageBase64) {
    return createVisionRequestBody({ ...options, imageBase64: payload.imageBase64, imageType: payload.imageType });
  }
  const question = payload.question?.trim();
  if (!question) throw new Error('No question to answer. Record, paste text or analyze the screen first.');
  return createTextRequestBody({ ...options, question, isFollowUp: !!payload.isFollowUp });
}

async function runAnswerRequest(sender, payload) {
  const { requestId } = payload;
  const apiKey = payload.apiKey?.trim();
  if (!apiKey) throw new Error('Enter your OpenAI API key before sending.');

  const body = buildAnswerRequestBody(payload);
  const controller = new AbortController();
  activeRequests.set(requestId, controller);
  console.log(`[openai] ${requestId} started (${body.model})`);

  try {
    const text = await streamChatCompletion({
      apiKey,
      body,
      controller,
      onDelta: (textSoFar) => sender.send('openai:delta', { requestId, text: textSoFar })
    });
    console.log(`[openai] ${requestId} done: ${text.length} chars`);
    sender.send('openai:done', { requestId, text });
  } finally {
    activeRequests.delete(requestId);
  }
}

function registerIpcHandlers(realtime) {
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.on('app:resize-height', (_event, height) => resizeHeight(height));
  ipcMain.handle('app:capture-screen', () => captureScreen());

  ipcMain.handle('settings:get', (_event, key) => readSettings()[key] ?? null);
  ipcMain.handle('settings:set', (_event, key, value) => writeSettings({ [key]: value }));
  ipcMain.handle('context:status', () => getContextStatus());

  ipcMain.on('openai:run', (event, payload) => {
    runAnswerRequest(event.sender, payload).catch((error) => {
      if (error.name === 'AbortError') return; // cancelled by the user
      console.error('[openai] error:', error.message);
      event.sender.send('openai:error', { requestId: payload.requestId, message: error.message });
    });
  });

  ipcMain.on('openai:cancel', (_event, requestId) => {
    activeRequests.get(requestId)?.abort();
    activeRequests.delete(requestId);
  });

  ipcMain.handle('whisper:transcribe', (_event, { apiKey, wav }) => {
    if (!apiKey?.trim() || !wav) return { text: '', error: 'Missing API key or audio data.' };
    return transcribeWithWhisper({ apiKey: apiKey.trim(), wav });
  });

  ipcMain.handle('realtime:start', (_event, { apiKey }) => realtime.start(apiKey));
  ipcMain.on('realtime:audio-chunk', (_event, pcm) => realtime.appendAudio(pcm));
  ipcMain.handle('realtime:stop', () => realtime.stop());
}

module.exports = { registerIpcHandlers };
