'use strict';

// One-line, actionable messages for OpenAI failures. The raw response body is
// logged to the console by the caller; the UI only gets these.
function describeHttpError(status, body = '') {
  if (status === 401) return 'OpenAI rejected the API key (401). Check or replace the key.';
  if (status === 403) return 'This API key is not allowed to use that model (403).';
  if (status === 404) return 'Model not found for this key (404). Check "answerModel" in settings.';
  if (status === 429) {
    return /insufficient_quota/.test(body)
      ? 'OpenAI quota used up. Check billing on your OpenAI account.'
      : 'Rate limited by OpenAI (429). Wait a few seconds and try again.';
  }
  if (status >= 500) return `OpenAI server error (${status}). Try again.`;
  return `OpenAI request failed (${status}).`;
}

// fetch() rejects with a TypeError ("fetch failed") when the network is down.
function describeNetworkError(error) {
  return error?.name === 'TypeError' ? 'Network error. Check your internet connection.' : error?.message;
}

// ws reports handshake failures as "Unexpected server response: 401".
function describeSocketError(error) {
  const status = Number(/Unexpected server response: (\d+)/.exec(error?.message || '')?.[1]);
  if (status) return `Live transcript: ${describeHttpError(status)}`;
  return `Live transcript: ${error?.code === 'ENOTFOUND' ? 'network error' : error?.message}`;
}

module.exports = { describeHttpError, describeNetworkError, describeSocketError };
