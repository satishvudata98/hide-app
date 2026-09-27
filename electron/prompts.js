'use strict';

const HISTORY_MESSAGES = 4; // last 2 question/answer exchanges

const SYSTEM_PROMPT = `You help a software engineer answer questions in a live technical interview. Write what the candidate should say: first person, natural, easy to say out loud. Match the candidate's real seniority and experience as shown in their resume below.

OUTPUT FORMAT (markdown):

**Say:** 1–2 sentences the candidate can say immediately. Direct answer first.

## Key Points
- 3–4 short bullets: supporting detail, trade-offs, or talking points for a follow-up
- For behavioral questions, cover Situation → Task → Action → Result across the bullets

## Code
Only for coding, algorithm, or system design questions: clean, working code under 30 lines with brief comments on non-obvious parts. Leave this section out otherwise.

RULES:
- Only mention projects, companies, technologies and numbers that appear in the resume. If the resume has nothing relevant, answer from general engineering knowledge without claiming specific experience. Never invent projects or metrics.
- Keep sentences short and speakable; use "I" naturally.
- Prefer practical reasoning over textbook definitions: why this approach, what the alternatives are, what changes at scale.
- For system design: briefly cover scale, trade-offs and failure modes.
- Never mention being an AI or assistant.
- For screenshots: focus only on the code or technical question visible; ignore faces and personal data.`;

const SCREENSHOT_INSTRUCTION = 'This is a screenshot of the interview screen. Extract the technical question or code shown and answer it.';

// Prompt + JD + resume form one stable prefix, so OpenAI's automatic prompt
// caching can reuse it across questions.
function buildSystemMessage({ jd, resume }) {
  let content = SYSTEM_PROMPT;
  if (jd) content += `\n\n# Job Description\n${jd}`;
  if (resume) content += `\n\n# Candidate Resume\n${resume}`;
  return { role: 'system', content };
}

function createTextRequestBody({ model, context, history = [], question }) {
  return {
    model,
    stream: true,
    temperature: 0.4,
    max_tokens: 700,
    messages: [
      buildSystemMessage(context),
      ...history.slice(-HISTORY_MESSAGES),
      { role: 'user', content: `Interviewer question:\n${question}` }
    ]
  };
}

function createVisionRequestBody({ model, context, history = [], imageBase64, imageType = 'jpeg' }) {
  return {
    model,
    stream: true,
    temperature: 0.4,
    max_tokens: 1200,
    messages: [
      buildSystemMessage(context),
      ...history.slice(-HISTORY_MESSAGES),
      {
        role: 'user',
        content: [
          { type: 'text', text: SCREENSHOT_INSTRUCTION },
          { type: 'image_url', image_url: { url: `data:image/${imageType};base64,${imageBase64}`, detail: 'high' } }
        ]
      }
    ]
  };
}

module.exports = { SYSTEM_PROMPT, buildSystemMessage, createTextRequestBody, createVisionRequestBody };
