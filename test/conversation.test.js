import { describe, it, expect, beforeEach } from 'vitest'
import { createRequire } from 'node:module'

const { createConversation, sayLine } = createRequire(import.meta.url)('../electron/conversation.js')

const interviewer = (text) => ({ kind: 'interviewer', text })
const answer = (say, extra = '') => `**Say:** ${say}\n- **point** detail${extra}`

describe('createConversation', () => {
  let conversation
  beforeEach(() => { conversation = createConversation() })

  it('replays the last exchanges word for word', () => {
    conversation.add(interviewer('What is Pinia?'), answer('It is the Vue store.'))
    expect(conversation.messages()).toEqual([
      { role: 'user', content: 'Interviewer (live transcript since my last answer):\nWhat is Pinia?' },
      { role: 'assistant', content: answer('It is the Vue store.') }
    ])
  })

  it('keeps 4 exchanges in full and summarizes older ones in one line each', () => {
    for (let i = 1; i <= 7; i++) conversation.add(interviewer(`question ${i}`), answer(`answer ${i}.`))
    const messages = conversation.messages()
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toBe([
      'Earlier in this interview (oldest first):',
      '1. Interviewer: "question 1" → I said: answer 1.',
      '2. Interviewer: "question 2" → I said: answer 2.',
      '3. Interviewer: "question 3" → I said: answer 3.'
    ].join('\n'))
    expect(messages.slice(1)).toHaveLength(8)
    expect(messages[1].content).toContain('question 4')
  })

  it('keeps code only in the latest answer', () => {
    const code = '\n```js\nconst x = 1\n```'
    conversation.add(interviewer('write debounce'), answer('Here it is.', code))
    conversation.add(interviewer('and throttle?'), answer('Similar.', code))
    const [, first, , latest] = conversation.messages()
    expect(first.content).toContain('[code omitted]')
    expect(latest.content).toContain('const x = 1')
  })

  it('stays bounded over a long interview', () => {
    for (let i = 0; i < 300; i++) conversation.add(interviewer('q '.repeat(150)), answer('a '.repeat(150)))
    const chars = conversation.messages().reduce((sum, m) => sum + m.content.length, 0)
    expect(chars).toBeLessThan(20_000) // ~5k tokens
  })

  it('holds a turn answered with "…" and joins it to the next question', () => {
    conversation.add(interviewer('Okay so next I want to talk about your RAG project.'), '…')
    expect(conversation.size).toBe(0)
    const next = conversation.prepareTurn(interviewer('Why LangChain?'))
    expect(next.text).toBe('Okay so next I want to talk about your RAG project. Why LangChain?')
    conversation.add(next, answer('It gave us retrieval out of the box.'))
    expect(conversation.prepareTurn(interviewer('And then?')).text).toBe('And then?')
  })

  it('does not double a held turn when that same turn is asked again (regenerate)', () => {
    conversation.add(interviewer('Okay, one sec.'), '…')
    expect(conversation.prepareTurn(interviewer('Okay, one sec.')).text).toBe('Okay, one sec.')
  })

  it('labels requests and screenshots in the summary', () => {
    conversation.add({ kind: 'screen', text: '' }, answer('Use a hash map.'))
    conversation.add({ kind: 'request', text: 'Make it shorter.' }, answer('Hash map, O(n).'))
    for (let i = 0; i < 4; i++) conversation.add(interviewer(`q${i}`), answer(`a${i}`))
    expect(conversation.messages()[0].content).toContain('1. Screenshot: → I said: Use a hash map.')
    expect(conversation.messages()[0].content).toContain('2. My request: "Make it shorter." → I said: Hash map, O(n).')
  })

  it('removes the latest exchange only when it is the one being regenerated', () => {
    conversation.add(interviewer('q1'), answer('a1'), 'req_1')
    conversation.add(interviewer('q2'), answer('a2'), 'req_2')
    conversation.removeLast('req_1') // not the latest: kept
    expect(conversation.size).toBe(2)
    conversation.removeLast('req_2')
    expect(conversation.size).toBe(1)
    conversation.removeLast(null)
    expect(conversation.size).toBe(1)
  })

  it('clears everything', () => {
    conversation.add(interviewer('q'), answer('a'))
    conversation.clear()
    expect(conversation.messages()).toEqual([])
  })
})

describe('sayLine', () => {
  it('extracts the Say line without markup, or falls back to the first line', () => {
    expect(sayLine('**Say:** I would **cache** it.\n- more')).toBe('I would cache it.')
    expect(sayLine('Sure, I can hear you.')).toBe('Sure, I can hear you.')
  })
})
