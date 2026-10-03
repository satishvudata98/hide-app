'use strict';

const { userTurnContent } = require('./prompts');

const VERBATIM_EXCHANGES = 4; // the most recent exchanges, word for word
const EARLIER_MAX_CHARS = 8000; // ~2k tokens of one-line summaries for everything before those
const LINE_CHARS = 200; // per question and per answer in a summary line

const WAIT_ANSWER = /^(\*\*Say:\*\*\s*)?(…|\.\.\.)$/;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

// The Say line of an answer (or its first line), without the label.
function sayLine(answer) {
  const line = answer.split('\n').find((l) => /\*\*Say:\*\*/.test(l)) || answer.split('\n').find((l) => l.trim()) || '';
  return line.replace(/\*\*Say:\*\*/, '').replace(/\*\*/g, '').trim();
}

function stripCode(answer) {
  return answer.replace(/```[\s\S]*?```/g, '[code omitted]');
}

// The interview so far, kept in the main process and rebuilt into messages
// for every request without any extra LLM call: the last few exchanges in
// full, everything earlier as one line each. That keeps a 2-hour interview
// under ~5k tokens of history, so requests don't get slower as it goes on.
function createConversation() {
  let exchanges = []; // { turn: { kind, text }, answer, id }
  let heldText = ''; // interviewer text answered with "…" (no question yet), carried into the next turn

  function summaryLine(exchange, index) {
    const label = { request: 'My request', screen: 'Screenshot', pasted: 'Interviewer (typed)' }[exchange.turn.kind] || 'Interviewer';
    const asked = exchange.turn.kind === 'screen' ? '' : ` "${clip(exchange.turn.text.replace(/\s+/g, ' '), LINE_CHARS)}"`;
    return `${index + 1}. ${label}:${asked} → I said: ${clip(sayLine(exchange.answer), LINE_CHARS)}`;
  }

  return {
    get size() {
      return exchanges.length;
    },

    clear() {
      exchanges = [];
      heldText = '';
    },

    // The turn as it should be sent: interviewer text that got a "…" before
    // (the setup of a question) is joined to the next interviewer turn.
    prepareTurn(turn) {
      if (!heldText || (turn.kind !== 'interviewer' && turn.kind !== 'pasted')) return turn;
      if (turn.text.startsWith(heldText)) return turn; // the held turn itself, asked again
      return { ...turn, text: `${heldText} ${turn.text}` };
    },

    // `id` identifies the request, so a regenerate can replace exactly this exchange.
    add(turn, answer, id = null) {
      const text = answer.trim();
      if (!text) return;
      if (WAIT_ANSWER.test(text)) {
        if (turn.kind === 'interviewer' || turn.kind === 'pasted') heldText = turn.text;
        return;
      }
      heldText = '';
      exchanges.push({ turn, answer: text, id });
    },

    // Drops the latest exchange if it came from request `id` (it's being regenerated).
    removeLast(id) {
      if (id && exchanges.at(-1)?.id === id) exchanges.pop();
    },

    // Chat messages for the history, oldest first. Earlier exchanges go in
    // one system message; code is kept only in the latest answer.
    messages() {
      const splitAt = Math.max(0, exchanges.length - VERBATIM_EXCHANGES);
      const messages = [];

      const lines = exchanges.slice(0, splitAt).map(summaryLine);
      let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
      while (total > EARLIER_MAX_CHARS && lines.length) total -= lines.shift().length + 1;
      if (lines.length) {
        messages.push({ role: 'system', content: `Earlier in this interview (oldest first):\n${lines.join('\n')}` });
      }

      exchanges.slice(splitAt).forEach(({ turn, answer }, index, recent) => {
        const isLatest = index === recent.length - 1;
        messages.push(
          { role: 'user', content: userTurnContent(turn) },
          { role: 'assistant', content: isLatest ? answer : stripCode(answer) }
        );
      });
      return messages;
    }
  };
}

module.exports = { createConversation, sayLine };
