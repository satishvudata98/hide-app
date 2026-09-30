<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { renderMarkdown, highlightCodeBlocks, isWaitAnswer } from '../lib/markdown'

const props = defineProps({
  question: { type: String, default: '' },
  text: { type: String, default: '' },
  error: { type: String, default: '' },
  loadingLabel: { type: String, default: '' }, // e.g. 'thinking'; empty when not loading
  elapsed: { type: Number, default: 0 },
  latency: { type: String, default: null },
  canStop: Boolean,
  canFollowUp: Boolean
})

defineEmits(['stop', 'close', 'follow-up', 'regenerate'])

// label → hotkey hint
const FOLLOW_UPS = [['shorter', 'Ctrl+Shift+1'], ['deeper', 'Ctrl+Shift+2'], ['with code', 'Ctrl+Shift+3']]
const HEARD_MAX_CHARS = 140

const bodyEl = ref(null)
const copied = ref(false)

const waiting = computed(() => isWaitAnswer(props.text))
const html = computed(() => (waiting.value ? '' : renderMarkdown(props.text)))
// The end of what was heard: the question is almost always at the end of the block
const heard = computed(() => {
  const text = props.question.replace(/\s+/g, ' ').trim()
  return text.length > HEARD_MAX_CHARS ? '…' + text.slice(-HEARD_MAX_CHARS).replace(/^\S*\s/, '') : text
})

// The Say line comes first, so the view stays at the top while the rest streams in
watch(() => props.question, () => { if (bodyEl.value) bodyEl.value.scrollTop = 0 })
watch(html, async () => {
  await nextTick()
  if (bodyEl.value) highlightCodeBlocks(bodyEl.value)
})

async function copyAnswer() {
  try {
    await navigator.clipboard.writeText(props.text)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch {
    console.warn('[answer] copy failed')
  }
}
</script>

<template>
  <div class="connector-line"></div>

  <div class="answer-block">
    <div class="answer-header">
      <div class="answer-label">
        <span class="answer-dot"></span>
        <span>ai answer</span>
        <span class="answer-latency" v-if="latency">· {{ latency }}</span>
      </div>
      <span class="answer-elapsed" v-if="elapsed > 0 && !latency">{{ elapsed }}s</span>
      <button class="icon-btn copy-btn" @click="copyAnswer" :title="copied ? 'Copied!' : 'Copy answer'" v-if="text">
        {{ copied ? '✓' : '⎘' }}
      </button>
      <button class="icon-btn stop-btn" @click="$emit('stop')" title="Stop" v-if="canStop">■</button>
      <button class="icon-btn close-btn" @click="$emit('close')" title="Close">✕</button>
    </div>

    <div class="answer-body" ref="bodyEl">
      <div class="detected-question" v-if="heard" :title="question">heard: {{ heard }}</div>

      <!-- Streaming answer rendered as sanitized markdown -->
      <div class="answer-md" v-if="html" v-html="html"></div>

      <div class="answer-waiting" v-if="waiting">No question yet. Keep listening and press again once it's asked.</div>

      <div class="answer-error" v-if="error">{{ error }}</div>

      <div class="answer-loading" v-if="loadingLabel && !text && !error">
        <span class="stage-label">{{ loadingLabel }}</span>
        <span class="blink-cursor accent">|</span>
      </div>

      <div class="follow-ups" v-if="canFollowUp && !waiting">
        <button v-for="[kind, hotkey] in FOLLOW_UPS" :key="kind" class="chip" :title="hotkey" @click="$emit('follow-up', kind)">{{ kind }}</button>
        <button class="chip" title="Ctrl+Shift+R" @click="$emit('regenerate')">↻ again</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.follow-ups {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.chip {
  -webkit-app-region: no-drag;
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.20);
  border-radius: 10px;
  color: var(--indigo);
  font-size: 10px;
  padding: 2px 10px;
  cursor: pointer;
}

.chip:hover {
  background: rgba(99, 102, 241, 0.18);
}


/* ═══════════════════════════════════════════
   CONNECTOR LINE
   ═══════════════════════════════════════════ */
.connector-line {
  width: 1px;
  height: 10px;
  background: var(--answer-border);
  margin: 0 auto;
  flex-shrink: 0;
}

/* ═══════════════════════════════════════════
   ANSWER BLOCK
   ═══════════════════════════════════════════ */
.answer-block {
  -webkit-app-region: no-drag;
  background: var(--answer-bg);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--answer-border);
  border-radius: 12px;
  overflow: hidden;
  animation: slide-down 0.25s ease-out;
}

.answer-header {
  display: flex;
  align-items: center;
  height: 32px;
  padding: 0 10px;
  border-bottom: 1px solid rgba(99, 102, 241, 0.10);
  gap: 6px;
}

.answer-label {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  font-size: 11px;
  font-weight: 500;
  color: var(--indigo);
  text-transform: lowercase;
}

.answer-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--indigo);
  flex-shrink: 0;
}

.answer-latency {
  font-size: 10px;
  color: var(--text-hint);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.answer-elapsed {
  font-size: 10px;
  color: var(--text-hint);
  font-variant-numeric: tabular-nums;
}

.close-btn:hover {
  color: var(--text-primary);
}

.stop-btn {
  font-size: 10px;
}

.stop-btn:hover {
  color: var(--red);
  background: rgba(239, 68, 68, 0.12);
}

.answer-body {
  padding: 10px 12px;
  max-height: 510px;
  overflow-y: auto;
  user-select: text;
  -webkit-user-select: text;
}

.detected-question {
  font-size: 11px;
  color: var(--text-hint);
  margin-bottom: 8px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ── Markdown answer ── */
.answer-md {
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-primary);
}

.answer-md :deep(h2) {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-bright);
  margin: 10px 0 4px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding-bottom: 3px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.answer-md :deep(h3) {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-bright);
  margin: 8px 0 3px;
}

.answer-md :deep(p) {
  margin-bottom: 5px;
}

/* The line to say first: biggest and brightest thing on screen */
.answer-md :deep(p.say) {
  font-size: 14.5px;
  line-height: 1.5;
  font-weight: 500;
  color: var(--text-bright);
  margin-bottom: 9px;
}

/* Supporting points: quieter, their bold key term carries the scan */
.answer-md :deep(ul),
.answer-md :deep(ol) {
  padding-left: 1.4em;
  margin-bottom: 6px;
  color: rgba(255, 255, 255, 0.74);
}

.answer-md :deep(li) {
  margin-bottom: 3px;
  line-height: 1.55;
}

/* [placeholder] the candidate fills in with their own real fact */
.answer-md :deep(.fill) {
  color: rgb(251, 191, 36);
  border-bottom: 1px dashed rgba(251, 191, 36, 0.6);
  padding: 0 1px;
}

.answer-waiting {
  font-size: 11.5px;
  color: var(--text-hint);
  padding: 2px 0;
}

.answer-md :deep(strong) {
  color: var(--text-bright);
  font-weight: 600;
}

.answer-md :deep(em) {
  color: var(--text-secondary);
}

/* Inline code */
.answer-md :deep(code):not(pre > code) {
  background: rgba(99, 102, 241, 0.12);
  border: 1px solid rgba(99, 102, 241, 0.15);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: 'SF Mono', ui-monospace, 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
  color: rgba(165, 180, 252, 0.9);
}

/* Code blocks */
.answer-md :deep(pre) {
  background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 6px 0;
  overflow-x: auto;
}

.answer-md :deep(pre code) {
  background: none;
  border: none;
  padding: 0;
  font-family: 'SF Mono', ui-monospace, 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-primary);
  white-space: pre;
}

/* highlight.js token colors (Material Palenight-inspired) */
.answer-md :deep(.hljs-keyword),
.answer-md :deep(.hljs-built_in) { color: #c792ea; }
.answer-md :deep(.hljs-string),
.answer-md :deep(.hljs-attr) { color: #c3e88d; }
.answer-md :deep(.hljs-number),
.answer-md :deep(.hljs-literal) { color: #f78c6c; }
.answer-md :deep(.hljs-comment) { color: rgba(255, 255, 255, 0.3); font-style: italic; }
.answer-md :deep(.hljs-function),
.answer-md :deep(.hljs-title) { color: #82aaff; }
.answer-md :deep(.hljs-variable),
.answer-md :deep(.hljs-params) { color: #f07178; }
.answer-md :deep(.hljs-type),
.answer-md :deep(.hljs-class .hljs-title) { color: #ffcb6b; }
.answer-md :deep(.hljs-tag),
.answer-md :deep(.hljs-name) { color: #f07178; }
.answer-md :deep(.hljs-meta) { color: rgba(255, 255, 255, 0.4); }

/* ── Error state ── */
.answer-error {
  padding: 6px 0 2px;
  font-size: 11px;
  color: rgba(239, 68, 68, 0.85);
  line-height: 1.5;
}

/* ── Loading state ── */
.answer-loading {
  padding: 4px 0;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.stage-label {
  font-size: 11px;
  color: var(--text-hint);
  font-style: italic;
}

.blink-cursor {
  color: var(--text-secondary);
  animation: blink-cursor 0.8s step-end infinite;
  margin-left: 1px;
}

.blink-cursor.accent {
  color: var(--indigo);
}

.copy-btn {
  font-size: 14px;
}

.copy-btn:hover {
  color: var(--indigo);
  background: rgba(99, 102, 241, 0.10);
}

</style>
