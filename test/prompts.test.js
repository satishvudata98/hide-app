import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const { SYSTEM_PROMPT, createTextRequestBody, createVisionRequestBody } =
  createRequire(import.meta.url)('../electron/prompts.js')

const context = { jd: 'Vue developer role', resume: 'Satish, 3 years Vue' }
const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))

describe('createTextRequestBody', () => {
  const body = createTextRequestBody({ model: 'gpt-4o', context, history, question: 'What is a closure?' })

  it('puts prompt, JD and resume in the system message as a stable prefix', () => {
    const system = body.messages[0]
    expect(system.role).toBe('system')
    expect(system.content.startsWith(SYSTEM_PROMPT)).toBe(true)
    expect(system.content).toContain('# Job Description\nVue developer role')
    expect(system.content).toContain('# Candidate Resume\nSatish, 3 years Vue')
  })

  it('keeps only the last two exchanges, then the question', () => {
    expect(body.messages.slice(1, -1).map((m) => m.content)).toEqual(['m2', 'm3', 'm4', 'm5'])
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Interviewer question:\nWhat is a closure?' })
  })

  it('uses the given model and streams', () => {
    expect(body.model).toBe('gpt-4o')
    expect(body.stream).toBe(true)
  })

  it('omits missing context sections', () => {
    const bare = createTextRequestBody({ model: 'm', context: { jd: '', resume: '' }, question: 'q' })
    expect(bare.messages[0].content).toBe(SYSTEM_PROMPT)
  })
})

describe('createVisionRequestBody', () => {
  it('sends the screenshot as a data URL after the history', () => {
    const body = createVisionRequestBody({ model: 'gpt-4o', context, history: history.slice(0, 2), imageBase64: 'AAAA' })
    const last = body.messages.at(-1)
    expect(body.messages).toHaveLength(4)
    expect(last.content[1].image_url.url).toBe('data:image/jpeg;base64,AAAA')
  })
})
