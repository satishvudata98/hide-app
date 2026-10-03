import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const { SYSTEM_PROMPT, createTextRequestBody, createVisionRequestBody, generationParams, userTurnContent } =
  createRequire(import.meta.url)('../electron/prompts.js')

const context = { jd: 'Vue developer role', resume: 'Satish, 3 years Vue' }
const history = [
  { role: 'user', content: 'Interviewer (live transcript since my last answer):\nq1' },
  { role: 'assistant', content: 'a1' }
]
const turn = { kind: 'interviewer', text: 'what is a closure' }

describe('createTextRequestBody', () => {
  const body = createTextRequestBody({ model: 'gpt-4o', context, history, turn })

  it('puts prompt, JD and resume in the system message as a stable prefix', () => {
    const system = body.messages[0]
    expect(system.role).toBe('system')
    expect(system.content.startsWith(SYSTEM_PROMPT)).toBe(true)
    expect(system.content).toContain('# Job Description\nVue developer role')
    expect(system.content).toContain('# Candidate Resume\nSatish, 3 years Vue')
  })

  it('sends the history, then the turn marked as live transcript', () => {
    expect(body.messages.slice(1, -1)).toEqual(history)
    const last = body.messages.at(-1)
    expect(last.role).toBe('user')
    expect(last.content).toMatch(/^Interviewer \(live transcript since my last answer\):\nwhat is a closure\n\n/)
  })

  it('reminds about honesty in the current turn only', () => {
    expect(body.messages.at(-1).content).toContain('[brackets]')
    expect(body.messages.slice(0, -1).some((m) => m.content.includes('[brackets]'))).toBe(false)
  })

  it('uses the given model, streams and asks for usage', () => {
    expect(body).toMatchObject({ model: 'gpt-4o', stream: true, stream_options: { include_usage: true } })
  })

  it('marks the candidate\'s own follow-up requests and typed questions', () => {
    expect(userTurnContent({ kind: 'request', text: 'Make it shorter.' })).toMatch(/^My request about your last answer/)
    expect(userTurnContent({ kind: 'pasted', text: 'q' })).toMatch(/^Interviewer question \(typed\)/)
  })

  it('adds the detailed style to the last message only, so the system prefix stays cacheable', () => {
    const detailed = createTextRequestBody({ model: 'gpt-4o', context, style: 'detailed', turn })
    expect(detailed.messages[0]).toEqual(body.messages[0])
    expect(detailed.messages.at(-1).content).toContain('Answer style: detailed')
    expect(detailed.max_tokens).toBeGreaterThan(body.max_tokens)
  })

  it('omits missing context sections', () => {
    const bare = createTextRequestBody({ model: 'm', context: { jd: '', resume: '' }, turn })
    expect(bare.messages[0].content).toBe(SYSTEM_PROMPT)
  })

  it('is long enough with a real resume for OpenAI prompt caching (1024+ tokens)', () => {
    expect(SYSTEM_PROMPT.length / 4).toBeGreaterThan(1024) // ~4 characters per token
  })
})

describe('generationParams', () => {
  it('uses temperature and max_tokens for chat models', () => {
    expect(generationParams('gpt-4o', 700)).toEqual({ temperature: 0.4, max_tokens: 700 })
    expect(generationParams('gpt-5-chat-latest', 700)).toEqual({ temperature: 0.4, max_tokens: 700 })
  })

  it('uses max_completion_tokens with room for reasoning, and no temperature, for reasoning models', () => {
    for (const model of ['o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini']) {
      const params = generationParams(model, 700)
      expect(params.temperature).toBeUndefined()
      expect(params.max_tokens).toBeUndefined()
      expect(params.max_completion_tokens).toBeGreaterThan(700)
    }
  })
})

describe('createVisionRequestBody', () => {
  it('sends the screenshot as a data URL after the history', () => {
    const body = createVisionRequestBody({ model: 'gpt-4o', context, history, imageBase64: 'AAAA' })
    const last = body.messages.at(-1)
    expect(body.messages).toHaveLength(4)
    expect(last.content[1].image_url.url).toBe('data:image/jpeg;base64,AAAA')
  })
})
