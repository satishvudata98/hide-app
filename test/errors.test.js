import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const { describeHttpError, describeNetworkError, describeSocketError } =
  createRequire(import.meta.url)('../electron/errors.js')

describe('describeHttpError', () => {
  it('explains the common OpenAI failures in one line', () => {
    expect(describeHttpError(401)).toMatch(/API key/)
    expect(describeHttpError(404)).toMatch(/answerModel/)
    expect(describeHttpError(503)).toBe('OpenAI server error (503). Try again.')
  })

  it('tells quota exhaustion apart from rate limiting', () => {
    expect(describeHttpError(429, '{"error":{"code":"insufficient_quota"}}')).toMatch(/quota/)
    expect(describeHttpError(429, '{"error":{"code":"rate_limit_exceeded"}}')).toMatch(/Rate limited/)
  })
})

describe('describeNetworkError', () => {
  it('turns fetch TypeErrors into a network message and passes others through', () => {
    expect(describeNetworkError(new TypeError('fetch failed'))).toMatch(/Network error/)
    expect(describeNetworkError(new Error('boom'))).toBe('boom')
  })
})

describe('describeSocketError', () => {
  it('reads the HTTP status from a failed WebSocket handshake', () => {
    expect(describeSocketError(new Error('Unexpected server response: 401'))).toMatch(/^Live transcript: .*API key/)
  })
})
