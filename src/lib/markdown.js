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
    return DOMPurify.sanitize(typeof html === 'string' ? html : '')
  } catch {
    return DOMPurify.sanitize(text.replaceAll('\n', '<br>'))
  }
}

export function highlightCodeBlocks(root) {
  root.querySelectorAll('pre code:not(.hljs)').forEach((el) => hljs.highlightElement(el))
}
