'use strict';

// Turns a scripted interview into a 24kHz mono WAV with OpenAI TTS, plus the
// send schedule and reference text replay.js needs.
// Usage: node scripts/make-mock-audio.js [script.json] [--out dir] [--noise 0.01]
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, loadApiKey, writeWav } = require('./lib');

const SAMPLE_RATE = 24000;
const BYTES_PER_MS = 48;
const LEAD_IN_MS = 1000;

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args.splice(index, 2)[1] : fallback;
};
const outDir = path.resolve(option('--out', path.join(ROOT, 'scripts', 'out')));
const noise = Number(option('--noise', 0));
const scriptPath = path.resolve(args[0] || path.join(__dirname, 'fixtures', 'mock-interview.json'));

const silence = (ms) => Buffer.alloc(Math.round(ms) * BYTES_PER_MS);

async function speak(apiKey, { voice, accent, pace }, text) {
  const style = [accent && `Speak with a natural ${accent} accent.`, pace === 'fast' && 'Speak quickly, like a busy interviewer.']
    .filter(Boolean).join(' ');
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice,
      input: text,
      instructions: `You are a job interviewer on a video call. ${style}`.trim(),
      response_format: 'pcm' // raw 24kHz 16-bit mono
    })
  });
  if (!response.ok) throw new Error(`TTS ${response.status}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

// Deterministic white noise at `level` (fraction of full scale) mixed in place.
function addNoise(pcm, level) {
  let seed = 42;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i) + random() * level * 32767;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i);
  }
}

async function main() {
  const apiKey = loadApiKey();
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const parts = [silence(LEAD_IN_MS)];
  let positionMs = LEAD_IN_MS;
  const sends = [];

  for (const [index, turn] of script.turns.entries()) {
    process.stdout.write(`turn ${index + 1}/${script.turns.length}… `);
    for (const [clipIndex, text] of turn.clips.entries()) {
      const audio = await speak(apiKey, turn, text);
      parts.push(audio);
      positionMs += audio.length / BYTES_PER_MS;
      const pause = turn.pausesMs?.[clipIndex];
      if (pause && clipIndex < turn.clips.length - 1) {
        parts.push(silence(pause));
        positionMs += pause;
      }
    }
    const endMs = positionMs;
    sends.push({ atMs: Math.round(endMs + (turn.sendDelayMs ?? 700)), speechEndMs: Math.round(endMs), reference: turn.clips.join(' ') });
    const gap = (turn.answerSeconds ?? script.answerSeconds ?? 4) * 1000;
    parts.push(silence(gap));
    positionMs += gap;
    console.log('ok');
  }

  const pcm = Buffer.concat(parts);
  if (noise) addNoise(pcm, noise);
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(scriptPath, '.json') + (noise ? `-noise${noise}` : '');
  writeWav(path.join(outDir, `${base}.wav`), pcm, SAMPLE_RATE);
  fs.writeFileSync(path.join(outDir, `${base}.sends.json`), JSON.stringify(sends, null, 2));
  console.log(`\n${path.join(outDir, base)}.wav  (${(pcm.length / BYTES_PER_MS / 1000).toFixed(1)}s, ${sends.length} sends)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
