'use strict';

const { splitSseEvents, parseChatChunk } = require('./sse');
const { describeHttpError, describeNetworkError } = require('./errors');

const API_BASE = 'https://api.openai.com/v1';
const HEADERS_TIMEOUT_MS = 12_000;
const FIRST_TOKEN_TIMEOUT_MS = 8_000; // after headers; normally < 1.5s
const STREAM_IDLE_TIMEOUT_MS = 20_000;
const WHISPER_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 800;
// The app retries once and only for a short wait: during an interview a fast
// fallback beats a long pause. Scripts pass a bigger budget.
const DEFAULT_RETRY = { attempts: 2, maxWaitMs: 3_000 };

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function abortError() {
  return Object.assign(new Error('Request aborted.'), { name: 'AbortError' });
}

// How long OpenAI asks us to wait: the retry-after-ms / retry-after headers,
// or the "try again in 1.4s" hint in a rate-limit message.
function retryDelayMs(headers, body = '') {
  const ms = Number(headers?.get?.('retry-after-ms'));
  if (ms > 0) return ms;
  const seconds = Number(headers?.get?.('retry-after'));
  if (seconds > 0) return seconds * 1000;
  const hint = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(body);
  if (hint) return Math.ceil(Number(hint[1]) * (hint[2].toLowerCase() === 'ms' ? 1 : 1000));
  return RETRY_DELAY_MS;
}

// Retries network errors and 429/5xx, waiting as long as OpenAI suggests, but
// gives up when that wait is longer than maxWaitMs (the caller can then fall
// back to another model). A used-up quota is never retried. This only covers
// the phase before any token is streamed, so a retry never duplicates output.
async function fetchWithRetry(url, options, onAttempt, { attempts, maxWaitMs } = DEFAULT_RETRY) {
  for (let attempt = 1; ; attempt++) {
    onAttempt();
    const isLastAttempt = attempt >= attempts;
    let delay = RETRY_DELAY_MS;
    try {
      const response = await fetch(url, options);
      if (isLastAttempt || !isRetryableStatus(response.status)) return response;
      const body = await response.text();
      delay = retryDelayMs(response.headers, body) + 100;
      if (/insufficient_quota/.test(body) || delay > maxWaitMs) {
        return new Response(body, { status: response.status, headers: response.headers });
      }
      console.warn(`[openai] ${response.status}, retrying in ${delay}ms`);
    } catch (error) {
      if (error.name === 'AbortError' || isLastAttempt) throw error;
      console.warn(`[openai] network error, retrying: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (options.signal?.aborted) throw abortError();
  }
}

async function readChatStream(response, onDelta, onChunk, timing) {
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
      const { text: delta, usage } = parseChatChunk(payload);
      if (usage) timing.usage = usage;
      if (!delta) continue;
      timing.firstTokenAt ??= Date.now();
      text += delta;
      onDelta(text);
    }
  }
}

const failure = (message, props) => Object.assign(new Error(message), props);

// Streams a chat completion, calling onDelta(fullTextSoFar) as tokens arrive.
// Aborting `controller` cancels it; stalls are turned into readable errors.
// Errors worth retrying on another model (rate limit, server error, network,
// no first token in time) carry `retryable: true`. `timing` is filled in as
// the request progresses: requestSentAt, attempts, firstTokenAt and usage.
async function streamChatCompletion({ apiKey, body, controller, onDelta, timing = {}, retry = DEFAULT_RETRY }) {
  // One timer, re-armed as the request progresses: waiting for headers, then
  // for the first token, then between chunks. Whichever fires records why.
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
    }, () => {
      timing.requestSentAt ??= Date.now();
      timing.attempts = (timing.attempts || 0) + 1;
      armTimer(HEADERS_TIMEOUT_MS, 'headers');
    }, retry);

    if (!response.ok) {
      const text = await response.text();
      console.error(`[openai] ${response.status}: ${text}`);
      const retryable = isRetryableStatus(response.status) && !/insufficient_quota/.test(text);
      throw failure(describeHttpError(response.status, text), { status: response.status, retryable });
    }

    armTimer(FIRST_TOKEN_TIMEOUT_MS, 'first-token');
    const onChunk = () => { if (timing.firstTokenAt) armTimer(STREAM_IDLE_TIMEOUT_MS, 'idle'); };
    return await readChatStream(response, onDelta, onChunk, timing);
  } catch (error) {
    if (error.name === 'AbortError' && timeoutReason === 'headers') {
      throw failure(`No response from OpenAI after ${HEADERS_TIMEOUT_MS / 1000}s. Check your network and try again.`, { retryable: true });
    }
    if (error.name === 'AbortError' && timeoutReason === 'first-token') {
      throw failure(`OpenAI sent nothing for ${FIRST_TOKEN_TIMEOUT_MS / 1000}s.`, { retryable: true });
    }
    if (error.name === 'AbortError' && timeoutReason === 'idle') {
      throw failure(`Answer stream stalled for ${STREAM_IDLE_TIMEOUT_MS / 1000}s and was stopped. Try again.`);
    }
    if (error.name === 'TypeError') throw failure(describeNetworkError(error), { retryable: true });
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

module.exports = { streamChatCompletion, transcribeWithWhisper, retryDelayMs };
