<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { renderMarkdown, highlightCodeBlocks } from '../lib/markdown'

const props = defineProps({
  question: { type: String, default: '' },
  text: { type: String, default: '' },
  error: { type: String, default: '' },
  loadingLabel: { type: String, default: '' }, // e.g. 'thinking'; empty when not loading
  elapsed: { type: Number, default: 0 },
  latency: { type: String, default: null },
  canStop: Boolean
})

defineEmits(['stop', 'close'])

const bodyEl = ref(null)
const copied = ref(false)
let stickToBottom = true // auto-scroll only while the reader is at the bottom

const html = computed(() => renderMarkdown(props.text))

watch(html, async () => {
  if (!props.text) stickToBottom = true // a new answer starts at the bottom
  await nextTick()
  if (!bodyEl.value) return
  highlightCodeBlocks(bodyEl.value)
  if (stickToBottom) bodyEl.value.scrollTop = bodyEl.value.scrollHeight
})

function onScroll() {
  const el = bodyEl.value
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

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

    <div class="answer-body" ref="bodyEl" @scroll="onScroll">
      <div class="detected-question" v-if="question">"{{ question }}"</div>

      <!-- Streaming answer rendered as sanitized markdown -->
      <div class="answer-md" v-if="html" v-html="html"></div>

      <div class="answer-error" v-if="error">{{ error }}</div>

      <div class="answer-loading" v-if="loadingLabel && !text && !error">
        <span class="stage-label">{{ loadingLabel }}</span>
        <span class="blink-cursor accent">|</span>
      </div>
    </div>
  </div>
</template>

<style scoped>

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
  font-style: italic;
  font-size: 11px;
  color: var(--text-hint);
  margin-bottom: 8px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.answer-md :deep(ul),
.answer-md :deep(ol) {
  padding-left: 1.4em;
  margin-bottom: 6px;
}

.answer-md :deep(li) {
  margin-bottom: 3px;
  line-height: 1.55;
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
