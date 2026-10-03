'use strict';

// Runs the answer prompt over fixed interview situations and has a judge model
// grade each answer. Run it after every prompt change.
// Usage: node scripts/eval-answers.js [--model gpt-4o] [--judge gpt-4o] [--only id,id] [--show] [--out report.json]
const fs = require('node:fs');
const path = require('node:path');
const { createTextRequestBody } = require('../electron/prompts');
const { createConversation } = require('../electron/conversation');
const { streamChatCompletion, retryDelayMs } = require('../electron/openai');
const { percentile } = require('../electron/trace');
const { ROOT, loadApiKey, loadContext } = require('./lib');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 1), true) : false; };
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : fallback; };

const model = option('--model', 'gpt-4o');
const judgeModel = option('--judge', 'gpt-4o');
const only = option('--only', '');
const show = flag('--show');
const useV1 = flag('--v1');
const outPath = option('--out', path.join(ROOT, 'scripts', 'out', `eval-${Date.now()}.json`));
const CONCURRENCY = 1; // a tier-1 key allows 30k gpt-4o tokens per minute, shared by answers and judge
const SCRIPT_RETRY = { attempts: 8, maxWaitMs: 60_000 }; // scripts wait out rate limits

const BANNED = /great question|certainly|absolutely|fast-paced|\bdelve|\bleverag|\brobust|seamless|\bcrucial|streamlin|it's worth noting|in conclusion|as an ai/i;
const WAIT = /^(\*\*Say:\*\*\s*)?(…|\.\.\.)$/;

const JUDGE_PROMPT = `You grade answers written by an interview copilot. The copilot reads a live, error-prone transcript of what the interviewer said and writes what the candidate should say, in first person, based only on the candidate's resume.

Grade strictly and reply with JSON only:
{
  "addresses_ask": true|false,      // does it answer what the interviewer actually wants right now (given the conversation), per the expectation?
  "invented_experience": true|false, // does it state as fact anything about the candidate NOT supported by the resume: projects, employers, tools used in a job, what was done on a project, durations ("two weeks"), outcomes ("improved engagement"), numbers, names, availability or salary? General knowledge and [placeholders] are fine. Be strict.
  "human_tone": 1-5,                 // 5 = sounds like a strong candidate talking; 1 = robotic, padded or obviously AI
  "reason": "one short sentence"
}`;

async function judge(apiKey, { resume, jd }, testCase, history, answer) {
  const transcript = history.map(([q, a]) => `Interviewer: ${q}\nCandidate: ${a}`).join('\n\n') || '(none)';
  for (let attempt = 1; ; attempt++) {
    const response = await judgeRequest(apiKey, { resume, jd }, testCase, transcript, answer);
    if (response.ok) return JSON.parse((await response.json()).choices[0].message.content);
    const body = await response.text();
    if (response.status !== 429 || attempt >= SCRIPT_RETRY.attempts) throw new Error(`judge ${response.status}: ${body}`);
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response.headers, body) + 200));
  }
}

function judgeRequest(apiKey, { resume, jd }, testCase, transcript, answer) {
  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: judgeModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        {
          role: 'user',
          content: `# Resume\n${resume}\n\n# Job description\n${jd}\n\n# Conversation so far\n${transcript}\n\n` +
            `# Latest ${testCase.kind === 'request' ? 'request from the candidate' : 'interviewer turn (raw transcript)'}\n${testCase.turn}\n\n` +
            `# What a good answer does\n${testCase.expect}\n\n# Answer to grade\n${answer}`
        }
      ]
    })
  });
}

// --v1: the prompt and 2-exchange history from the v1-stable tag, for comparison.
function v1RequestBody(context, testCase, history) {
  const v1 = require(path.join(ROOT, 'scripts', 'out', 'prompts-v1.js'));
  const messages = history.flatMap(([q, a]) => [{ role: 'user', content: q }, { role: 'assistant', content: a }]);
  return v1.createTextRequestBody({ model, context, history: messages, question: testCase.turn, isFollowUp: testCase.kind === 'request' });
}

async function runCase(apiKey, context, testCase) {
  const conversation = createConversation();
  const history = testCase.history || [];
  for (const [question, answer] of history) conversation.add({ kind: 'interviewer', text: question }, answer);
  const turn = conversation.prepareTurn({ kind: testCase.kind || 'interviewer', text: testCase.turn });
  const body = useV1
    ? v1RequestBody(context, testCase, history)
    : createTextRequestBody({ model, context, history: conversation.messages(), turn });
  const timing = {};
  const answer = (await streamChatCompletion({
    apiKey, body, controller: new AbortController(), timing, onDelta: () => {}, retry: SCRIPT_RETRY
  })).trim();

  const checks = {
    ttftMs: timing.attempts === 1 ? timing.firstTokenAt - timing.requestSentAt : null, // retried: not a latency sample
    cachedTokens: timing.usage?.prompt_tokens_details?.cached_tokens || 0,
    sayFirst: testCase.wait ? WAIT.test(answer) : answer.startsWith('**Say:**'),
    banned: (BANNED.exec(answer) || [])[0] || ''
  };
  const grade = testCase.wait
    ? { addresses_ask: WAIT.test(answer), invented_experience: false, human_tone: 5, reason: 'expects exactly …' }
    : await judge(apiKey, context, testCase, history, answer);
  const pass = grade.addresses_ask && !grade.invented_experience && checks.sayFirst && !checks.banned;
  return { id: testCase.id, type: testCase.type, pass, ...checks, ...grade, answer };
}

async function main() {
  const apiKey = loadApiKey();
  const context = loadContext();
  let { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'eval-cases.json'), 'utf8'));
  if (only) cases = cases.filter((c) => only.split(',').includes(c.id));
  console.log(`${cases.length} cases, ${useV1 ? 'v1 prompt' : 'current prompt'}, answers by ${model}, judged by ${judgeModel}\n`);

  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < cases.length) {
      const testCase = cases[next++];
      try {
        const result = await runCase(apiKey, context, testCase);
        results.push(result);
        const marks = [
          result.pass ? 'PASS' : 'FAIL',
          !result.addresses_ask && 'misses the ask',
          result.invented_experience && 'INVENTED',
          !result.sayFirst && 'format',
          result.banned && `banned "${result.banned}"`
        ].filter(Boolean).join(' · ');
        console.log(`${testCase.id.padEnd(28)} ${marks}  tone ${result.human_tone}  ttft ${result.ttftMs == null ? ' -  ' : (result.ttftMs / 1000).toFixed(2) + 's'}${result.pass ? '' : `\n${' '.repeat(29)}${result.reason}`}`);
      } catch (error) {
        results.push({ id: testCase.id, pass: false, error: error.message });
        console.log(`${testCase.id.padEnd(28)} ERROR ${error.message}`);
      }
    }
  }));

  const graded = results.filter((r) => !r.error);
  const pct = (n) => `${Math.round((n / (graded.length || 1)) * 100)}%`;
  const ttft = graded.map((r) => r.ttftMs).filter(Number.isFinite);
  console.log(`\npass ${pct(graded.filter((r) => r.pass).length)}  ·  answers the ask ${pct(graded.filter((r) => r.addresses_ask).length)}` +
    `  ·  invented ${graded.filter((r) => r.invented_experience).length}  ·  Say first ${pct(graded.filter((r) => r.sayFirst).length)}` +
    `  ·  banned phrases ${graded.filter((r) => r.banned).length}  ·  tone ${(graded.reduce((s, r) => s + r.human_tone, 0) / (graded.length || 1)).toFixed(1)}/5`);
  console.log(`model TTFT p50 ${(percentile(ttft, 50) / 1000).toFixed(2)}s  p95 ${(percentile(ttft, 95) / 1000).toFixed(2)}s` +
    `  ·  cached prompt tokens on ${graded.filter((r) => r.cachedTokens > 0).length}/${graded.length} requests`);

  if (show) {
    for (const r of results.filter((x) => show && (!x.pass || only))) console.log(`\n── ${r.id}\n${r.answer || r.error}`);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ model, judgeModel, results }, null, 2));
  console.log(`\nreport: ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
