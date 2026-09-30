import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import python from 'highlight.js/lib/languages/python'
import javascript from 'highlight.js/lib/languages/javascript'
import java from 'highlight.js/lib/languages/java'
import typescript from 'highlight.js/lib/languages/typescript'
import bash from 'highlight.js/lib/languages/bash'
import sql from 'highlight.js/lib/languages/sql'

hljs.registerLanguage('python', python)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('java', java)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sql', sql)

// Model output → sanitized HTML, safe for v-html.
export function renderMarkdown(text) {
  if (!text) return ''
  try {
    const html = marked.parse(text, { breaks: true, gfm: true })
    return decorateAnswer(DOMPurify.sanitize(typeof html === 'string' ? html : ''))
  } catch {
    return DOMPurify.sanitize(text.replaceAll('\n', '<br>'))
  }
}

// Runs on sanitized HTML, adding only fixed markup:
// - the leading "**Say:** …" paragraph gets class "say" (styled as the line to read first);
// - [placeholders] outside code get class "fill", so personal facts the model
//   left for the candidate stand out instead of being read out as-is.
export function decorateAnswer(html) {
  const decorated = html.replace(/^<p><strong>Say:<\/strong>\s*/, '<p class="say">')
  return decorated
    .split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/)
    .map((part, index) => (index % 2 ? part : part.replace(/\[([^\]<>]{1,40})\]/g, '<span class="fill">$1</span>')))
    .join('')
}

// A "…" answer means the interviewer hasn't asked anything yet.
export const isWaitAnswer = (text) => /^(\*\*Say:\*\*\s*)?(…|\.\.\.)$/.test(text.trim())

export function highlightCodeBlocks(root) {
  root.querySelectorAll('pre code:not(.hljs)').forEach((el) => hljs.highlightElement(el))
}
