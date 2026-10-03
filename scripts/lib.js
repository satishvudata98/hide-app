'use strict';

// Shared helpers for the scripts: API key, context files, WAV I/O, WER.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function loadApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const match = /^VITE_OPENAI_API_KEY\s*=\s*(.+)$/m.exec(env);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* no .env */ }
  throw new Error('Set OPENAI_API_KEY or VITE_OPENAI_API_KEY in .env');
}

function loadContext() {
  const read = (name) => { try { return fs.readFileSync(path.join(ROOT, name), 'utf8').trim(); } catch { return ''; } };
  return { jd: read('jd.txt'), resume: read('resume.txt') };
}

function writeWav(filePath, pcm, sampleRate = 24000) {
  fs.writeFileSync(filePath, wavBuffer(pcm, sampleRate));
}

function wavBuffer(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Returns the PCM16 bytes of a mono 24kHz WAV.
function readWav(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${filePath} is not a WAV file`);
  const sampleRate = data.readUInt32LE(24);
  const channels = data.readUInt16LE(22);
  if (sampleRate !== 24000 || channels !== 1) throw new Error(`${filePath} must be 24kHz mono (got ${sampleRate}Hz, ${channels}ch)`);
  let offset = 12;
  while (offset < data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === 'data') return data.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size;
  }
  throw new Error(`${filePath} has no data chunk`);
}

const words = (text) => text.toLowerCase().replace(/[^a-z0-9.+#/ ]+/g, ' ').replace(/\.(\s|$)/g, ' ').split(/\s+/).filter(Boolean);

// Word error rate of `hypothesis` against `reference` (0 = perfect).
function wordErrorRate(reference, hypothesis) {
  const ref = words(reference);
  const hyp = words(hypothesis);
  if (!ref.length) return hyp.length ? 1 : 0;
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const current = [i];
    for (let j = 1; j <= hyp.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[hyp.length] / ref.length;
}

module.exports = { ROOT, loadApiKey, loadContext, writeWav, wavBuffer, readWav, wordErrorRate };
