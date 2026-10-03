'use strict';

const fs = require('node:fs');

// Answer stages, in pipeline order. Each is stored as ms after the hotkey press.
const STAGES = ['block_ready', 'request_sent', 'first_token', 'first_render', 'done'];

const offset = (at, from) => (Number.isFinite(at) && Number.isFinite(from) ? Math.max(0, Math.round(at - from)) : null);

// Raw timestamps from the renderer (press, block, render) and from main
// (request, first token, done) → one flat record. Numbers only, no transcript text.
function buildTraceRecord({ kind, pressedAt, blockReadyAt, firstRenderAt, blockChars, ok, error, timing = {} }) {
  const at = {
    block_ready: blockReadyAt,
    request_sent: timing.requestSentAt,
    first_token: timing.firstTokenAt,
    first_render: firstRenderAt,
    done: timing.doneAt
  };
  const ms = {};
  for (const stage of STAGES) ms[stage] = offset(at[stage], pressedAt);

  const usage = timing.usage || {};
  return {
    at: new Date(pressedAt).toISOString(),
    kind,
    ok: !!ok,
    error: error || undefined,
    model: timing.model,
    fallback: timing.fallback || undefined,
    attempts: timing.attempts,
    blockChars,
    promptTokens: usage.prompt_tokens,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens,
    completionTokens: usage.completion_tokens,
    ms
  };
}

function appendTrace(filePath, record) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
  } catch (error) {
    console.warn('[trace] could not write trace:', error.message);
  }
}

function readTraces(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// Nearest-rank percentile of a list of numbers (null for an empty list).
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

// { stage: { n, p50, p95, max } } over successful answers.
function summarizeTraces(records) {
  const ok = records.filter((r) => r.ok);
  const summary = {};
  for (const stage of STAGES) {
    const values = ok.map((r) => r.ms?.[stage]).filter(Number.isFinite);
    summary[stage] = { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: percentile(values, 100) };
  }
  return summary;
}

module.exports = { STAGES, buildTraceRecord, appendTrace, readTraces, percentile, summarizeTraces };
