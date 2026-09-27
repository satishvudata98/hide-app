'use strict';

// Splits a Server-Sent Events text buffer into the `data:` payloads of every
// complete event. `rest` is the incomplete tail to prepend to the next chunk.
function splitSseEvents(buffer) {
  const events = buffer.split('\n\n');
  const rest = events.pop() || '';
  const payloads = [];

  for (const event of events) {
    for (const line of event.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload) payloads.push(payload);
    }
  }

  return { payloads, rest };
}

// Text delta from one chat-completions stream payload ('' if none or unparseable).
function parseChatDelta(payload) {
  try {
    const content = JSON.parse(payload)?.choices?.[0]?.delta?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

module.exports = { splitSseEvents, parseChatDelta };
