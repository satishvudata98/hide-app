'use strict';

// Prints P50/P95 per answer stage from traces.jsonl.
// Usage: npm run report [-- <path to traces.jsonl>] [--last N] [--kind audio]
const path = require('node:path');
const { STAGES, readTraces, summarizeTraces } = require('../electron/trace');

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args.splice(index, 2)[1] : undefined;
};
const last = Number(option('--last')) || 0;
const kind = option('--kind');
const filePath = args[0] || path.join(process.env.APPDATA || '', 'Screnshield', 'traces.jsonl');

let records;
try {
  records = readTraces(filePath);
} catch (error) {
  console.error(`Could not read ${filePath}: ${error.message}`);
  process.exit(1);
}
if (kind) records = records.filter((r) => r.kind === kind);
if (last) records = records.slice(-last);

const failed = records.filter((r) => !r.ok);
const summary = summarizeTraces(records);
const secs = (ms) => (ms == null ? '   -  ' : `${(ms / 1000).toFixed(2)}s`.padStart(6));

console.log(`${filePath}\n${records.length} answers (${failed.length} failed)${kind ? `, kind=${kind}` : ''}\n`);
console.log('stage (from press)      n     p50     p95     max');
for (const stage of STAGES) {
  const { n, p50, p95, max } = summary[stage];
  console.log(`${stage.padEnd(20)} ${String(n).padStart(4)}  ${secs(p50)}  ${secs(p95)}  ${secs(max)}`);
}

const cached = records.filter((r) => r.ok && r.promptTokens);
if (cached.length) {
  const ratio = cached.reduce((sum, r) => sum + (r.cachedTokens || 0) / r.promptTokens, 0) / cached.length;
  console.log(`\nprompt cache hit: ${(ratio * 100).toFixed(0)}% of prompt tokens on average`);
}
for (const r of failed.slice(-5)) console.log(`failed ${r.at}: ${r.error}`);
