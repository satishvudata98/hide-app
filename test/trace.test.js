import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const { buildTraceRecord, percentile, summarizeTraces } = createRequire(import.meta.url)('../electron/trace.js')

describe('percentile', () => {
  it('uses nearest rank', () => {
    const values = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10]
    expect(percentile(values, 50)).toBe(5)
    expect(percentile(values, 95)).toBe(10)
    expect(percentile([42], 95)).toBe(42)
    expect(percentile([], 50)).toBeNull()
  })
})

describe('buildTraceRecord', () => {
  it('turns timestamps into ms after the press and keeps usage', () => {
    const record = buildTraceRecord({
      kind: 'audio',
      pressedAt: 1000,
      blockReadyAt: 1100,
      firstRenderAt: 1950,
      blockChars: 80,
      ok: true,
      timing: {
        model: 'gpt-4o',
        attempts: 1,
        requestSentAt: 1110,
        firstTokenAt: 1900,
        doneAt: 4000,
        usage: { prompt_tokens: 2000, completion_tokens: 150, prompt_tokens_details: { cached_tokens: 1792 } }
      }
    })
    expect(record.ms).toEqual({ block_ready: 100, request_sent: 110, first_token: 900, first_render: 950, done: 3000 })
    expect(record).toMatchObject({ kind: 'audio', ok: true, model: 'gpt-4o', promptTokens: 2000, cachedTokens: 1792 })
  })

  it('leaves missing stages as null (e.g. a request that failed before streaming)', () => {
    const record = buildTraceRecord({ kind: 'paste', pressedAt: 1000, blockReadyAt: 1000, ok: false, error: 'boom' })
    expect(record.ms.first_token).toBeNull()
    expect(record.error).toBe('boom')
  })
})

describe('summarizeTraces', () => {
  it('summarizes successful answers only', () => {
    const records = [
      { ok: true, ms: { first_render: 800 } },
      { ok: true, ms: { first_render: 1200 } },
      { ok: false, ms: { first_render: 9000 } }
    ]
    expect(summarizeTraces(records).first_render).toEqual({ n: 2, p50: 800, p95: 1200, max: 1200 })
  })
})
