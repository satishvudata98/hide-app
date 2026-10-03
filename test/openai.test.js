import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const { streamChatCompletion, retryDelayMs } = createRequire(import.meta.url)('../electron/openai.js')

const sse = (...texts) => texts.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`).join('') + 'data: [DONE]\n\n'
const okStream = (...texts) => new Response(sse(...texts), { status: 200 })
const rateLimited = (message, headers = {}) =>
  new Response(JSON.stringify({ error: { message, code: 'rate_limit_exceeded' } }), { status: 429, headers })

function run(fetchMock, options = {}) {
  vi.stubGlobal('fetch', fetchMock)
  return streamChatCompletion({ apiKey: 'k', body: {}, controller: new AbortController(), onDelta: () => {}, ...options })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('retryDelayMs', () => {
  it('reads the retry headers, then the "try again in" hint', () => {
    expect(retryDelayMs(new Headers({ 'retry-after-ms': '250' }))).toBe(250)
    expect(retryDelayMs(new Headers({ 'retry-after': '2' }))).toBe(2000)
    expect(retryDelayMs(new Headers(), 'Please try again in 1.438s.')).toBe(1438)
    expect(retryDelayMs(new Headers(), 'Please try again in 64ms.')).toBe(64)
    expect(retryDelayMs(new Headers(), '')).toBe(800)
  })
})

describe('streamChatCompletion', () => {
  it('streams the text and records attempts and first token', async () => {
    const timing = {}
    await expect(run(vi.fn().mockResolvedValue(okStream('Hel', 'lo')), { timing })).resolves.toBe('Hello')
    expect(timing.attempts).toBe(1)
    expect(timing.firstTokenAt).toBeGreaterThan(0)
  })

  it('waits as long as a 429 asks and retries', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rateLimited('Rate limit reached. Please try again in 20ms.'))
      .mockResolvedValueOnce(okStream('ok'))
    await expect(run(fetchMock)).resolves.toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up at once when the wait is too long, flagged for the fallback model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rateLimited('Please try again in 20s.'))
    await expect(run(fetchMock)).rejects.toMatchObject({ status: 429, retryable: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never retries a used-up quota', async () => {
    const quota = new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), { status: 429 })
    const fetchMock = vi.fn().mockResolvedValue(quota)
    await expect(run(fetchMock)).rejects.toMatchObject({ retryable: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a rejected key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(run(fetchMock)).rejects.toMatchObject({ status: 401, retryable: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops a request that sends headers but no token within 8s', async () => {
    vi.useFakeTimers()
    const silent = (_url, { signal }) => Promise.resolve(new Response(new ReadableStream({
      start(controller) { signal.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))) }
    }), { status: 200 }))
    const result = run(vi.fn(silent))
    const assertion = expect(result).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('8s') })
    await vi.advanceTimersByTimeAsync(8000)
    await assertion
  })

  it('turns a network failure into a retryable, readable error after one retry', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    await expect(run(fetchMock, { retry: { attempts: 2, maxWaitMs: 3000 } })).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining('Network error')
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
