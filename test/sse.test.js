import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const { splitSseEvents, parseChatDelta } = createRequire(import.meta.url)('../electron/sse.js')

const chunk = (content) => JSON.stringify({ choices: [{ delta: { content } }] })

describe('splitSseEvents', () => {
  it('returns payloads of complete events and keeps the partial tail', () => {
    const { payloads, rest } = splitSseEvents(`data: ${chunk('Hel')}\n\ndata: ${chunk('lo')}\n\ndata: {"cho`)
    expect(payloads.map(parseChatDelta)).toEqual(['Hel', 'lo'])
    expect(rest).toBe('data: {"cho')
  })

  it('reassembles an event split across two network chunks', () => {
    const full = `data: ${chunk('split')}\n\n`
    const first = splitSseEvents(full.slice(0, 15))
    expect(first.payloads).toEqual([])
    const second = splitSseEvents(first.rest + full.slice(15))
    expect(second.payloads.map(parseChatDelta)).toEqual(['split'])
  })

  it('passes [DONE] through and ignores non-data lines', () => {
    const { payloads } = splitSseEvents(': keep-alive\nevent: message\ndata: [DONE]\n\n')
    expect(payloads).toEqual(['[DONE]'])
  })
})

describe('parseChatDelta', () => {
  it('returns an empty string for malformed JSON or chunks without text', () => {
    expect(parseChatDelta('{not json')).toBe('')
    expect(parseChatDelta(JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }))).toBe('')
    expect(parseChatDelta(JSON.stringify({ choices: [] }))).toBe('')
  })
})
