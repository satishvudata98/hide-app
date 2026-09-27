'use strict';

const { splitSseEvents, parseChatDelta } = require('./sse');
const { describeHttpError, describeNetworkError } = require('./errors');

const API_BASE = 'https://api.openai.com/v1';
const HEADERS_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 20_000;
const WHISPER_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 800;

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function abortError() {
  return Object.assign(new Error('Request aborted.'), { name: 'AbortError' });
}

// Retries once on a network error or a 429/5xx. This only covers the phase
// before any token is streamed, so a retry never duplicates visible output.
async function fetchWithRetry(url, options, onAttempt) {
  for (let attempt = 0; ; attempt++) {
    onAttempt();
    const isLastAttempt = attempt >= 1;
    try {
      const response = await fetch(url, options);
      if (isLastAttempt || !isRetryableStatus(response.status)) return response;
      console.warn(`[openai] ${response.status}, retrying once`);
    } catch (error) {
      if (error.name === 'AbortError' || isLastAttempt) throw error;
      console.warn(`[openai] network error, retrying once: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    if (options.signal?.aborted) throw abortError();
  }
}

async function readChatStream(response, onDelta, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) return text;
    onChunk();

    const { payloads, rest } = splitSseEvents(buffer + decoder.decode(value, { stream: true }));
    buffer = rest;

    for (const payload of payloads) {
      if (payload === '[DONE]') return text;
      const delta = parseChatDelta(payload);
      if (!delta) continue;
      text += delta;
      onDelta(text);
    }
  }
}

// Streams a chat completion, calling onDelta(fullTextSoFar) as tokens arrive.
// Aborting `controller` cancels it; stalls are turned into readable errors.
async function streamChatCompletion({ apiKey, body, controller, onDelta }) {
  // One timer, re-armed as the request progresses: first waiting for headers,
  // then waiting between stream chunks. Whichever fires records why.
  let timeoutReason = null;
  let timer = null;
  const armTimer = (ms, reason) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timeoutReason = reason; controller.abort(); }, ms);
  };

  try {
    const response = await fetchWithRetry(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal
    }, () => armTimer(HEADERS_TIMEOUT_MS, 'headers'));

    if (!response.ok) {
      const body = await response.text();
      console.error(`[openai] ${response.status}: ${body}`);
      throw new Error(describeHttpError(response.status, body));
    }

    const rearmIdle = () => armTimer(STREAM_IDLE_TIMEOUT_MS, 'idle');
    rearmIdle();
    return await readChatStream(response, onDelta, rearmIdle);
  } catch (error) {
    if (error.name === 'AbortError' && timeoutReason === 'headers') {
      throw new Error(`No response from OpenAI after ${HEADERS_TIMEOUT_MS / 1000}s. Check your network and try again.`);
    }
    if (error.name === 'AbortError' && timeoutReason === 'idle') {
      throw new Error(`Answer stream stalled for ${STREAM_IDLE_TIMEOUT_MS / 1000}s and was stopped. Try again.`);
    }
    if (error.name === 'TypeError') throw new Error(describeNetworkError(error));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeWithWhisper({ apiKey, wav }) {
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'question.wav');

  try {
    const response = await fetch(`${API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS)
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[whisper] ${response.status}: ${body}`);
      return { text: '', error: describeHttpError(response.status, body) };
    }
    const result = await response.json();
    return { text: result.text || '' };
  } catch (error) {
    if (error.name === 'TimeoutError') {
      return { text: '', error: `Whisper did not respond within ${WHISPER_TIMEOUT_MS / 1000}s.` };
    }
    return { text: '', error: describeNetworkError(error) || 'Whisper transcription error.' };
  }
}

module.exports = { streamChatCompletion, transcribeWithWhisper };
