import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const { splitSseEvents, parseChatChunk } = createRequire(import.meta.url)('../electron/sse.js')

const chunk = (content) => JSON.stringify({ choices: [{ delta: { content } }] })
const textOf = (payload) => parseChatChunk(payload).text

describe('splitSseEvents', () => {
  it('returns payloads of complete events and keeps the partial tail', () => {
    const { payloads, rest } = splitSseEvents(`data: ${chunk('Hel')}\n\ndata: ${chunk('lo')}\n\ndata: {"cho`)
    expect(payloads.map(textOf)).toEqual(['Hel', 'lo'])
    expect(rest).toBe('data: {"cho')
  })

  it('reassembles an event split across two network chunks', () => {
    const full = `data: ${chunk('split')}\n\n`
    const first = splitSseEvents(full.slice(0, 15))
    expect(first.payloads).toEqual([])
    const second = splitSseEvents(first.rest + full.slice(15))
    expect(second.payloads.map(textOf)).toEqual(['split'])
  })

  it('passes [DONE] through and ignores non-data lines', () => {
    const { payloads } = splitSseEvents(': keep-alive\nevent: message\ndata: [DONE]\n\n')
    expect(payloads).toEqual(['[DONE]'])
  })
})

describe('parseChatChunk', () => {
  it('returns empty text for malformed JSON or chunks without text', () => {
    expect(textOf('{not json')).toBe('')
    expect(textOf(JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }))).toBe('')
    expect(textOf(JSON.stringify({ choices: [] }))).toBe('')
  })

  it('returns the usage from the final include_usage chunk', () => {
    const usage = { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 1024 } }
    expect(parseChatChunk(JSON.stringify({ choices: [], usage }))).toEqual({ text: '', usage })
  })
})
