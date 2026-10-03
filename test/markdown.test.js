import { describe, it, expect } from 'vitest'
import { decorateAnswer, isWaitAnswer } from '../src/lib/markdown.js'

describe('decorateAnswer', () => {
  it('marks the leading Say paragraph and drops its label', () => {
    expect(decorateAnswer('<p><strong>Say:</strong> I would cache it.</p><ul><li>x</li></ul>'))
      .toBe('<p class="say">I would cache it.</p><ul><li>x</li></ul>')
  })

  it('highlights [placeholders] but leaves code alone', () => {
    const html = '<p>My notice period is [notice period].</p><pre><code>arr[0]</code></pre><p><code>a[i]</code></p>'
    expect(decorateAnswer(html)).toBe(
      '<p>My notice period is <span class="fill">notice period</span>.</p><pre><code>arr[0]</code></pre><p><code>a[i]</code></p>'
    )
  })
})

describe('isWaitAnswer', () => {
  it('recognizes the no-question-yet reply', () => {
    expect(isWaitAnswer('…')).toBe(true)
    expect(isWaitAnswer(' ... ')).toBe(true)
    expect(isWaitAnswer('**Say:** …')).toBe(true)
    expect(isWaitAnswer('**Say:** Sure…')).toBe(false)
  })
})
