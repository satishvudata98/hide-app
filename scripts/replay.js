'use strict';

// Streams a recorded interview through the real always-on transcription
// session (in real time), presses send at the scheduled moments and measures
// what the app would do: block latency, transcript accuracy (WER) and,
// with --answer, time to the first answer token.
//
// Usage: node scripts/replay.js <interview.wav> [--sends interview.sends.json]
//          [--answer] [--show] [--loop N] [--speed 1] [--vad 300] [--model gpt-4o] [--out report.json]
const fs = require('node:fs');
const path = require('node:path');
const { createRealtimeSession } = require('../electron/realtime');
const { streamChatCompletion, transcribeWithWhisper } = require('../electron/openai');
const { createTextRequestBody } = require('../electron/prompts');
const { createConversation } = require('../electron/conversation');
const { percentile } = require('../electron/trace');
const { loadApiKey, loadContext, readWav, wavBuffer, wordErrorRate } = require('./lib');

const BYTES_PER_MS = 48;
const CHUNK_MS = 100;
const FALLBACK_MAX_CHUNKS = 1200; // ~2 minutes, like the app's recorder

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 1), true) : false; };
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : fallback; };

const withAnswers = flag('--answer');
const show = flag('--show');
const loops = Number(option('--loop', 1));
const speed = Number(option('--speed', 1));
const vadSilenceMs = Number(option('--vad', 300));
const model = option('--model', 'gpt-4o');
const outPath = option('--out', '');
const eventsPath = option('--events', ''); // raw server events as JSONL, for debugging
const asrModel = option('--asr', 'gpt-4o-transcribe');
const wavPath = args[0];
const sendsPath = option('--sends', wavPath?.replace(/\.wav$/, '.sends.json'));
if (!wavPath) {
  console.error('Usage: node scripts/replay.js <interview.wav> [--sends file] [--answer] [--show] [--loop N]');
  process.exit(1);
}

const secs = (ms) => (ms == null ? '   -  ' : `${(ms / 1000).toFixed(2)}s`.padStart(6));

async function main() {
  const apiKey = loadApiKey();
  const context = loadContext();
  const pcm = readWav(wavPath);
  const baseSends = JSON.parse(fs.readFileSync(sendsPath, 'utf8'));
  const durationMs = pcm.length / BYTES_PER_MS;
  const sends = [];
  for (let loop = 0; loop < loops; loop++) {
    for (const send of baseSends) sends.push({ ...send, atMs: send.atMs + loop * durationMs, loop });
  }
  const totalMs = durationMs * loops;

  const statuses = [];
  const eventLog = eventsPath ? fs.openSync(eventsPath, 'w') : null;
  const session = createRealtimeSession((channel, payload) => {
    if (channel === 'realtime:status') statuses.push(payload.state);
    if (channel === 'realtime:error') console.warn(`  ! ${payload.message}`);
  }, {
    onServerEvent: eventLog && ((event, audioMs) => {
      if (event.type.endsWith('.delta') || event.type === 'input_audio_buffer.append') return;
      const { type, item_id, audio_start_ms, audio_end_ms, transcript, error } = event;
      fs.writeSync(eventLog, JSON.stringify({ t: Date.now() - startedAt, audioMs, type, item_id, audio_start_ms, audio_end_ms, transcript, error }) + '\n');
    })
  });
  session.start(apiKey, { vadSilenceMs, model: asrModel });

  console.log(`${path.basename(wavPath)}: ${(totalMs / 1000).toFixed(0)}s of audio, ${sends.length} sends, ${asrModel}, VAD ${vadSilenceMs}ms` +
    `${withAnswers ? `, answers with ${model}` : ''}${speed !== 1 ? `, ${speed}x` : ''}\n`);

  const results = [];
  const answers = [];
  const conversation = createConversation();
  let nextSend = 0;
  let sentMs = 0;
  let sinceSend = []; // audio chunks since the last send, for the Whisper fallback
  let startedAt = Date.now();

  async function answer(result, question) {
    const turn = conversation.prepareTurn({ kind: 'interviewer', text: question });
    const body = createTextRequestBody({ model, context, history: conversation.messages(), turn });
    const timing = {};
    try {
      const text = await streamChatCompletion({
        apiKey, body, controller: new AbortController(), timing, onDelta: () => {}, retry: { attempts: 8, maxWaitMs: 60_000 }
      });
      result.firstTokenMs = timing.firstTokenAt - result.pressedAt;
      result.modelTtftMs = timing.firstTokenAt - timing.requestSentAt;
      result.doneMs = Date.now() - result.pressedAt;
      result.cachedTokens = timing.usage?.prompt_tokens_details?.cached_tokens;
      result.answer = text;
      conversation.add(turn, text);
    } catch (error) {
      result.answerError = error.message;
    }
  }

  // Same as the app: a degraded block is replaced by Whisper on the audio since the last send.
  async function press(send, index) {
    const pressedAt = Date.now();
    const audioSinceSend = Buffer.concat(sinceSend);
    sinceSend = [];
    if (eventLog) fs.writeSync(eventLog, JSON.stringify({ t: pressedAt - startedAt, audioMs: sentMs, type: `PRESS #${index + 1}` }) + '\n');
    const block = await session.takeBlock();
    let text = block.text;
    let whisper = false;
    if (block.degraded && audioSinceSend.length) {
      const fallback = await transcribeWithWhisper({ apiKey, wav: wavBuffer(audioSinceSend) });
      text = fallback.text?.trim() || text;
      whisper = true;
    }
    const result = {
      index: index + 1,
      loop: send.loop,
      pressedAt,
      blockMs: Date.now() - pressedAt,
      text,
      whisper,
      reference: send.reference,
      wer: wordErrorRate(send.reference, text),
      segments: block.segments,
      complete: block.complete,
      degraded: block.degraded,
      heapMb: Math.round(process.memoryUsage().heapUsed / 1e6)
    };
    results.push(result);
    const line = `#${String(result.index).padStart(2)}  block ${secs(result.blockMs)}  WER ${(result.wer * 100).toFixed(0).padStart(3)}%  ` +
      `${block.segments} seg${whisper ? '  WHISPER' : ''}${block.complete ? '' : '  incomplete'}  "${text}"`;
    console.log(line);
    if (withAnswers && text) answers.push(answer(result, text));
  }

  startedAt = Date.now();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const audioMs = (Date.now() - startedAt) * speed;
      while (sentMs < audioMs && sentMs < totalMs) {
        const offset = Math.round((sentMs % durationMs) * BYTES_PER_MS);
        const chunk = pcm.subarray(offset, offset + CHUNK_MS * BYTES_PER_MS);
        session.appendAudio(chunk);
        sinceSend.push(chunk);
        if (sinceSend.length > FALLBACK_MAX_CHUNKS) sinceSend.shift();
        sentMs += CHUNK_MS;
      }
      while (nextSend < sends.length && sentMs >= sends[nextSend].atMs) {
        press(sends[nextSend], nextSend);
        nextSend++;
      }
      if (sentMs >= totalMs && nextSend >= sends.length) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
  });

  await new Promise((resolve) => setTimeout(resolve, 3000)); // let the last block resolve
  await Promise.all(answers);
  session.close();

  const stat = (label, values) => {
    const finite = values.filter(Number.isFinite);
    if (finite.length) console.log(`${label.padEnd(21)}${secs(percentile(finite, 50))}  ${secs(percentile(finite, 95))}  ${secs(percentile(finite, 100))}`);
  };
  const meanWer = results.reduce((sum, r) => sum + r.wer, 0) / (results.length || 1);
  console.log('\n                         p50     p95     max');
  stat('question ready', results.map((r) => r.blockMs));
  stat('model first token', results.map((r) => r.modelTtftMs));
  stat('first token (press)', results.map((r) => r.firstTokenMs));
  console.log(`\nmean WER ${(meanWer * 100).toFixed(1)}%  ·  whisper fallback ${results.filter((r) => r.whisper).length}/${results.length}` +
    `  ·  incomplete ${results.filter((r) => !r.complete).length}  ·  reconnects ${statuses.filter((s) => s === 'reconnecting').length}` +
    `  ·  heap ${results[0]?.heapMb}→${results.at(-1)?.heapMb} MB`);

  if (show) {
    for (const r of results.filter((x) => x.answer)) console.log(`\n── #${r.index} "${r.text}"\n${r.answer}`);
  }
  for (const r of results.filter((x) => x.answerError)) console.log(`#${r.index} answer failed: ${r.answerError}`);
  if (outPath) fs.writeFileSync(outPath, JSON.stringify({ vadSilenceMs, model, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
