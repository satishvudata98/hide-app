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

// Text delta and (on the final chunk, with include_usage) token usage from
// one chat-completions stream payload. Unparseable payloads give { text: '' }.
function parseChatChunk(payload) {
  try {
    const chunk = JSON.parse(payload);
    const content = chunk?.choices?.[0]?.delta?.content;
    return { text: typeof content === 'string' ? content : '', usage: chunk?.usage || null };
  } catch {
    return { text: '', usage: null };
  }
}

module.exports = { splitSseEvents, parseChatChunk };
