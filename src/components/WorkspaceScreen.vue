<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'

// ── Config ──
const API_KEY = import.meta.env.VITE_OPENAI_API_KEY || ''
const SYSTEM_PROMPT = 'You are a fast desktop assistant and you have 5 years of  experiennce in software engineering. Answer concisely and clearly. Use bullet points for structured answers. Keep it tight.'

// ── State machine: idle → recording → answering ──
const appState = ref('idle') // 'idle' | 'recording' | 'answering'
const transcriptText = ref('')
const answerText = ref('')
const detectedQuestion = ref('')
const answerElapsed = ref(0)
const showAnswer = ref(false)
const statusMsg = ref('')

let requestId = null
let recognition = null
let recognitionRestarting = false
let answerTimer = null
let answerStartTime = 0
let resizeObserver = null

// ── Computed ──
const isRecording = computed(() => appState.value === 'recording')
const isAnswering = computed(() => appState.value === 'answering')

// ── Audio Helpers ──
function mixToMono(inputBuffer) {
  const ch = inputBuffer.numberOfChannels
  const len = inputBuffer.length
  const mono = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    let s = 0
    for (let c = 0; c < ch; c++) s += inputBuffer.getChannelData(c)[i] || 0
    mono[i] = s / Math.max(ch, 1)
  }
  return mono
}

function mergeChunks(chunks) {
  let total = 0
  for (const c of chunks) total += c.length
  const merged = new Float32Array(total)
  let off = 0
  for (const c of chunks) { merged.set(c, off); off += c.length }
  return merged
}

function downsample(buffer, fromRate, toRate) {
  if (toRate >= fromRate) return buffer
  const ratio = fromRate / toRate
  const newLen = Math.round(buffer.length / ratio)
  const result = new Float32Array(newLen)
  for (let i = 0; i < newLen; i++) {
    const start = Math.round(i * ratio)
    const end = Math.round((i + 1) * ratio)
    let sum = 0, count = 0
    for (let j = start; j < end && j < buffer.length; j++) { sum += buffer[j]; count++ }
    result[i] = count ? sum / count : 0
  }
  return result
}

function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const ws = (view, o, str) => { for (let i = 0; i < str.length; i++) view.setUint8(o + i, str.charCodeAt(i)) }
  ws(v, 0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true)
  ws(v, 8, 'WAVE'); ws(v, 12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  ws(v, 36, 'data'); v.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return buf
}

function arrayBufferToBase64(buffer) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], { type: 'audio/wav' })
    const reader = new FileReader()
    reader.onloadend = () => {
      const b64 = reader.result.split(',')[1]
      if (!b64) { reject(new Error('Base64 conversion failed')); return }
      resolve(b64)
    }
    reader.onerror = () => reject(new Error('File read error'))
    reader.readAsDataURL(blob)
  })
}

let micStream = null
let audioContext = null
let processor = null
let silenceGain = null
let audioChunks = []
let chunkTimer = null
let isProcessingChunk = false

async function startRecording() {
  if (appState.value !== 'idle') return
  if (!API_KEY) {
    statusMsg.value = 'API key missing. Set VITE_OPENAI_API_KEY in .env.'
    return
  }

  transcriptText.value = ''
  answerText.value = ''
  detectedQuestion.value = ''
  showAnswer.value = false
  statusMsg.value = ''
  audioChunks = []

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    })

    audioContext = new AudioContext()
    processor = audioContext.createScriptProcessor(4096, 1, 1)

    // Silent output to keep processor alive
    silenceGain = audioContext.createGain()
    silenceGain.gain.value = 0
    processor.connect(silenceGain)
    silenceGain.connect(audioContext.destination)

    const source = audioContext.createMediaStreamSource(micStream)
    source.connect(processor)

    processor.onaudioprocess = (e) => {
      if (appState.value === 'recording') {
        audioChunks.push(mixToMono(e.inputBuffer))
      }
    }

    appState.value = 'recording'

    // Send chunks to Whisper API every 3.5 seconds
    chunkTimer = setInterval(async () => {
      if (audioChunks.length === 0 || isProcessingChunk) return
      isProcessingChunk = true

      const chunksToSend = audioChunks
      audioChunks = [] // clear for next batch

      const merged = mergeChunks(chunksToSend)
      const downsampled = downsample(merged, audioContext.sampleRate, 16000)
      const wavBuffer = encodeWav(downsampled, 16000)
      const base64 = await arrayBufferToBase64(wavBuffer)

      if (window.overlayApi) {
        const res = await window.overlayApi.transcribeAudio({ apiKey: API_KEY, audioBase64: base64 })
        if (res && res.text) {
          transcriptText.value += (transcriptText.value ? ' ' : '') + res.text.trim()
        } else if (res && res.error) {
          console.warn('Whisper error:', res.error)
        }
      }
      isProcessingChunk = false
    }, 3500)

  } catch (err) {
    statusMsg.value = 'Mic access failed: ' + err.message
    stopRecording()
  }
}

function stopRecording() {
  if (chunkTimer) {
    clearInterval(chunkTimer)
    chunkTimer = null
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop())
    micStream = null
  }
  if (processor) {
    processor.disconnect()
    processor = null
  }
  if (silenceGain) {
    silenceGain.disconnect()
    silenceGain = null
  }
  if (audioContext) {
    audioContext.close().catch(() => {})
    audioContext = null
  }
  if (appState.value === 'recording') {
    appState.value = 'idle'
  }
}

// ── Answer Question ──
function answerQuestion() {
  const text = transcriptText.value.trim()
  if (!text) {
    statusMsg.value = 'No transcript to analyze.'
    return
  }
  if (!API_KEY) {
    statusMsg.value = 'API key missing. Set VITE_OPENAI_API_KEY in .env.'
    return
  }

  detectedQuestion.value = text
  answerText.value = ''
  showAnswer.value = true
  appState.value = 'answering'
  answerStartTime = Date.now()
  answerElapsed.value = 0

  answerTimer = setInterval(() => {
    answerElapsed.value = Math.round((Date.now() - answerStartTime) / 1000)
  }, 500)

  requestId = `req_${Date.now()}`

  if (window.overlayApi) {
    window.overlayApi.runOpenAiRequest({
      requestId,
      apiKey: API_KEY,
      prompt: SYSTEM_PROMPT,
      transcribedText: text,
      format: 'text'
    })
  }
}

// ── Analyze Screen ──
async function analyzeScreen() {
  if (!API_KEY) {
    statusMsg.value = 'API key missing. Set VITE_OPENAI_API_KEY in .env.'
    return
  }

  statusMsg.value = 'Capturing screen...'

  if (!window.overlayApi?.captureScreen) {
    statusMsg.value = 'Screen capture not available.'
    return
  }

  const result = await window.overlayApi.captureScreen()
  if (result.error) {
    statusMsg.value = 'Capture failed: ' + result.error
    return
  }

  detectedQuestion.value = 'Screen analysis requested'
  answerText.value = ''
  showAnswer.value = true
  appState.value = 'answering'
  answerStartTime = Date.now()
  answerElapsed.value = 0
  statusMsg.value = ''

  answerTimer = setInterval(() => {
    answerElapsed.value = Math.round((Date.now() - answerStartTime) / 1000)
  }, 500)

  requestId = `req_${Date.now()}`

  if (window.overlayApi) {
    window.overlayApi.runOpenAiRequest({
      requestId,
      apiKey: API_KEY,
      prompt: SYSTEM_PROMPT,
      transcribedText: transcriptText.value.trim() || '',
      imageBase64: result.imageBase64,
      format: 'text'
    })
  }
}

// ── Close answer ──
function closeAnswer() {
  showAnswer.value = false
  answerText.value = ''
  detectedQuestion.value = ''
  if (answerTimer) { clearInterval(answerTimer); answerTimer = null }
  answerElapsed.value = 0

  // Do not resume recording automatically unless they click the record pill
  appState.value = 'idle'
}

// ── Clear transcript ──
function clearTranscript() {
  transcriptText.value = ''
}

// ── Exit ──
function quitApp() {
  if (window.overlayApi) window.overlayApi.quitApp()
}

// ── Format answer text to bullet points ──
const formattedAnswer = computed(() => {
  if (!answerText.value) return []
  const lines = answerText.value.split('\n').filter(l => l.trim())
  return lines.map(line => {
    // Strip leading bullet markers for uniform rendering
    return line.replace(/^[\s]*[-•*]\s*/, '').trim()
  }).filter(l => l)
})

// ── Dynamic window height ──
const rootEl = ref(null)

function syncWindowHeight() {
  if (!rootEl.value || !window.overlayApi?.resizeHeight) return
  // Measure the actual rendered content + some padding
  const height = rootEl.value.scrollHeight + 24 // 24 for body padding
  window.overlayApi.resizeHeight(height)
}

// ── OpenAI response handlers ──
onMounted(() => {
  if (!window.overlayApi) return

  window.overlayApi.onOpenAiStarted((p) => {
    if (p.requestId !== requestId) return
    statusMsg.value = ''
  })

  window.overlayApi.onOpenAiDelta((p) => {
    if (p.requestId !== requestId) return
    answerText.value = p.text || ''
  })

  window.overlayApi.onOpenAiDone((p) => {
    if (p.requestId !== requestId) return
    answerText.value = p.text || answerText.value
    if (answerTimer) { clearInterval(answerTimer); answerTimer = null }
    // Stay in answering state until user closes
  })

  window.overlayApi.onOpenAiError((p) => {
    if (p.requestId && p.requestId !== requestId) return
    statusMsg.value = p.message || 'Request failed.'
    if (answerTimer) { clearInterval(answerTimer); answerTimer = null }
    appState.value = 'idle'
  })

  // Observe root element to auto-resize window
  nextTick(() => {
    if (rootEl.value) {
      resizeObserver = new ResizeObserver(() => syncWindowHeight())
      resizeObserver.observe(rootEl.value)
      syncWindowHeight()
    }
  })
})

onUnmounted(() => {
  stopRecording()
  if (answerTimer) clearInterval(answerTimer)
  if (resizeObserver) resizeObserver.disconnect()
})

// Auto-resize whenever answer or transcript changes
watch([answerText, showAnswer, transcriptText, appState, statusMsg], () => {
  nextTick(() => syncWindowHeight())
})

const answerBodyEl = ref(null)
watch(answerText, async () => {
  await nextTick()
  if (answerBodyEl.value) answerBodyEl.value.scrollTop = answerBodyEl.value.scrollHeight
})
</script>

<template>
  <div class="overlay-root" ref="rootEl">

    <!-- ═══ MAIN OVERLAY BLOCK ═══ -->
    <div class="main-bar">

      <!-- Row 1: Top bar — drag handle + rec pill + exit -->
      <div class="top-row">
        <div class="drag-handle" title="Drag to move">· · ·</div>
        <div class="top-right">
          <div class="rec-pill" :class="{ active: isRecording }" @click="isRecording ? stopRecording() : startRecording()">
            <span class="rec-dot" :class="{ pulsing: isRecording }"></span>
            <span class="rec-label">rec</span>
          </div>
          <button class="icon-btn exit-btn" @click="quitApp" title="Exit">✕</button>
        </div>
      </div>

      <!-- Row 2: Action buttons -->
      <div class="action-row">
        <button class="action-btn indigo" @click="answerQuestion" :disabled="isAnswering || !transcriptText.trim()">
          <span class="action-icon">☰</span>
          <span>answer question</span>
        </button>
        <button class="action-btn green" @click="analyzeScreen" :disabled="isAnswering">
          <span class="action-icon">◻</span>
          <span>analyze screen</span>
        </button>
      </div>

      <!-- Row 3: Transcript row -->
      <div class="transcript-row">
        <div class="transcript-text">
          <span v-if="transcriptText">{{ transcriptText }}</span>
          <span v-else class="transcript-placeholder">{{ isRecording ? 'listening...' : 'start recording to see transcript' }}</span>
          <span v-if="isRecording" class="blink-cursor">|</span>
        </div>
        <button class="clear-btn" @click="clearTranscript" v-if="transcriptText" title="Clear transcript">clear</button>
      </div>

      <!-- Status message -->
      <div class="status-msg" v-if="statusMsg">{{ statusMsg }}</div>
    </div>

    <!-- ═══ CONNECTOR LINE ═══ -->
    <div class="connector-line" v-if="showAnswer"></div>

    <!-- ═══ ANSWER BLOCK ═══ -->
    <div class="answer-block" v-if="showAnswer">
      <div class="answer-header">
        <div class="answer-label">
          <span class="answer-dot"></span>
          <span>ai answer</span>
        </div>
        <span class="answer-elapsed" v-if="answerElapsed > 0">{{ answerElapsed }}s</span>
        <button class="icon-btn close-btn" @click="closeAnswer" title="Close">✕</button>
      </div>

      <div class="answer-body" ref="answerBodyEl">
        <!-- Detected question -->
        <div class="detected-question" v-if="detectedQuestion">
          "{{ detectedQuestion }}"
        </div>

        <!-- Streaming answer -->
        <div class="answer-content" v-if="answerText">
          <div v-for="(line, i) in formattedAnswer" :key="i" class="answer-bullet">
            <span class="bullet-dot">·</span>
            <span>{{ line }}</span>
          </div>
        </div>

        <!-- Loading state -->
        <div class="answer-loading" v-if="!answerText && appState === 'answering'">
          <span class="blink-cursor accent">|</span>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════
   OVERLAY ROOT
   ═══════════════════════════════════════════ */
.overlay-root {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 8px;
  gap: 0;
}

/* ═══════════════════════════════════════════
   MAIN BAR
   ═══════════════════════════════════════════ */
.main-bar {
  background: var(--overlay-bg);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--overlay-border);
  border-radius: 12px;
  overflow: hidden;
}

/* ── Row 1: Top bar ── */
.top-row {
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.drag-handle {
  -webkit-app-region: drag;
  flex: 1;
  color: var(--text-hint);
  font-size: 14px;
  letter-spacing: 3px;
  cursor: grab;
  padding: 4px 0;
}

.top-right {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 8px;
}

.rec-pill {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 8px;
  border-radius: 20px;
  background: rgba(239, 68, 68, 0.10);
  border: 1px solid rgba(239, 68, 68, 0.20);
  cursor: pointer;
  transition: all 0.2s ease;
}

.rec-pill:hover {
  background: rgba(239, 68, 68, 0.18);
}

.rec-pill.active {
  background: rgba(239, 68, 68, 0.16);
  border-color: rgba(239, 68, 68, 0.35);
}

.rec-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--red);
  opacity: 0.4;
  flex-shrink: 0;
}

.rec-dot.pulsing {
  opacity: 1;
  animation: pulse-red 1.2s ease-in-out infinite;
}

.rec-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--red);
  text-transform: lowercase;
}

.icon-btn {
  -webkit-app-region: no-drag;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-hint);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.icon-btn:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.06);
}

.exit-btn:hover {
  color: var(--red);
  background: rgba(239, 68, 68, 0.12);
}

/* ── Row 2: Action buttons ── */
.action-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
}

.action-btn {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 16px;
  border: none;
  border-radius: 8px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  justify-content: center;
  flex-shrink: 0;
}

.action-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.action-btn.indigo {
  background: var(--indigo-dim);
  color: var(--indigo);
  border: 1px solid rgba(99, 102, 241, 0.18);
}

.action-btn.indigo:hover:not(:disabled) {
  background: rgba(99, 102, 241, 0.22);
}

.action-btn.green {
  background: var(--green-dim);
  color: var(--green);
  border: 1px solid rgba(16, 185, 129, 0.18);
}

.action-btn.green:hover:not(:disabled) {
  background: rgba(16, 185, 129, 0.22);
}

.action-icon {
  font-size: 13px;
  line-height: 1;
}

/* ── Row 3: Transcript row ── */
.transcript-row {
  display: flex;
  align-items: center;
  height: 32px;
  padding: 0 10px;
  gap: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.transcript-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 32px;
}

.transcript-placeholder {
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

.clear-btn {
  -webkit-app-region: no-drag;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 5px;
  color: var(--text-hint);
  font-size: 10px;
  font-weight: 500;
  padding: 2px 8px;
  cursor: pointer;
  transition: all 0.15s ease;
  text-transform: lowercase;
  flex-shrink: 0;
}

.clear-btn:hover {
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.08);
}

/* ── Status ── */
.status-msg {
  padding: 4px 10px 6px;
  font-size: 10px;
  color: var(--text-hint);
  border-top: 1px solid rgba(255, 255, 255, 0.03);
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
  gap: 8px;
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

.answer-elapsed {
  font-size: 10px;
  color: var(--text-hint);
  font-variant-numeric: tabular-nums;
}

.close-btn:hover {
  color: var(--text-primary);
}

.answer-body {
  padding: 10px 12px;
  max-height: 260px;
  overflow-y: auto;
  user-select: text;
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

.answer-content {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.answer-bullet {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-primary);
  align-items: baseline;
}

.bullet-dot {
  color: var(--indigo);
  font-weight: 700;
  font-size: 16px;
  line-height: 1;
  flex-shrink: 0;
  margin-top: 1px;
}

.answer-loading {
  padding: 4px 0;
  font-size: 14px;
}
</style>
