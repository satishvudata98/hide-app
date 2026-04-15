<script setup>
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'

// ── Config ──
const API_KEY = import.meta.env.VITE_OPENAI_API_KEY || ''
const SYSTEM_PROMPT = 'You are a fast desktop assistant. Answer concisely and clearly based on the user question or transcript provided. Keep responses structured and easy to read.'

// ── State ──
const isRecording = ref(false)
const isSending = ref(false)
const recordingTime = ref(0)
const responseText = ref('')
const statusMsg = ref('')
const audioReady = ref(false)

let requestId = null
let captureState = null
let timerId = null
let audioBase64 = ''
let wavBytes = 0

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

function stopTracks(cap) {
  if (!cap) return
  for (const s of [cap.systemStream, cap.micStream]) {
    if (s) s.getTracks().forEach(t => t.stop())
  }
  if (cap.processor) cap.processor.disconnect()
  if (cap.silenceNode) cap.silenceNode.disconnect()
  for (const n of cap.nodes || []) { n.source.disconnect(); n.gain.disconnect() }
}

// ── Start Recording ──
async function startRecording() {
  if (isRecording.value || isSending.value) return

  responseText.value = ''
  statusMsg.value = ''
  audioBase64 = ''
  wavBytes = 0
  audioReady.value = false

  let systemStream = null
  let micStream = null

  try {
    systemStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    })

    const ctx = new AudioContext()
    const proc = ctx.createScriptProcessor(4096, 2, 1)

    // Silent output to keep processor alive
    const silenceGain = ctx.createGain()
    silenceGain.gain.value = 0
    proc.connect(silenceGain)
    silenceGain.connect(ctx.destination)

    const nodes = []
    const chunks = []

    const connectStream = (stream) => {
      if (!stream || !stream.getAudioTracks().length) return false
      const source = ctx.createMediaStreamSource(stream)
      const gain = ctx.createGain()
      gain.gain.value = 1
      source.connect(gain)
      gain.connect(proc)
      nodes.push({ source, gain })
      return true
    }

    const hasSys = connectStream(systemStream)
    const hasMic = connectStream(micStream)

    proc.onaudioprocess = (e) => {
      if (!isRecording.value) return
      chunks.push(mixToMono(e.inputBuffer))
    }

    captureState = { audioContext: ctx, processor: proc, silenceNode: silenceGain, chunks, nodes, systemStream, micStream, startedAt: performance.now() }
    isRecording.value = true
    recordingTime.value = 0

    timerId = setInterval(() => {
      recordingTime.value = ((performance.now() - captureState.startedAt) / 1000)
    }, 200)

    if (hasSys) {
      statusMsg.value = 'Recording system audio + mic...'
    } else {
      statusMsg.value = 'Recording mic only. System audio not detected.'
    }
  } catch (error) {
    stopTracks({ systemStream, micStream })
    statusMsg.value = `Capture failed: ${error.message}`
    isRecording.value = false
  }
}

// ── Stop & Send ──
async function stopAndSend() {
  if (!isRecording.value || !captureState) return

  const cap = captureState
  isRecording.value = false
  clearInterval(timerId)
  timerId = null

  const duration = (performance.now() - cap.startedAt) / 1000
  recordingTime.value = duration

  stopTracks(cap)
  try { await cap.audioContext.close() } catch (_) {}

  const merged = mergeChunks(cap.chunks)
  if (!merged.length) {
    captureState = null
    statusMsg.value = 'No audio captured. Try again.'
    return
  }

  const downsampled = downsample(merged, cap.audioContext.sampleRate, 16000)
  const wavBuffer = encodeWav(downsampled, 16000)
  audioBase64 = await arrayBufferToBase64(wavBuffer)
  wavBytes = wavBuffer.byteLength
  captureState = null

  // Immediately send
  sendToOpenAi()
}

function sendToOpenAi() {
  if (!audioBase64) {
    statusMsg.value = 'No audio to send.'
    return
  }

  if (!API_KEY) {
    statusMsg.value = 'API key missing. Set VITE_OPENAI_API_KEY in .env and rebuild.'
    return
  }

  isSending.value = true
  responseText.value = ''
  statusMsg.value = 'Sending audio to OpenAI...'
  requestId = `req_${Date.now()}`

  if (window.overlayApi) {
    window.overlayApi.runOpenAiRequest({
      requestId,
      apiKey: API_KEY,
      prompt: SYSTEM_PROMPT,
      audioBase64,
      format: 'wav'
    })
  }
}

function clearAll() {
  if (timerId) { clearInterval(timerId); timerId = null }
  if (captureState) {
    captureState.audioContext.close().catch(() => {})
    stopTracks(captureState)
  }
  captureState = null
  isRecording.value = false
  isSending.value = false
  audioBase64 = ''
  wavBytes = 0
  audioReady.value = false
  recordingTime.value = 0
  responseText.value = ''
  statusMsg.value = ''
}

function quitApp() {
  if (window.overlayApi) window.overlayApi.quitApp()
}

// ── Format time ──
function fmtTime(sec) {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ── OpenAI response handlers ──
onMounted(() => {
  if (!window.overlayApi) return

  window.overlayApi.onOpenAiStarted((p) => {
    if (p.requestId !== requestId) return
    statusMsg.value = 'Processing...'
  })

  window.overlayApi.onOpenAiDelta((p) => {
    if (p.requestId !== requestId) return
    responseText.value = p.text || ''
  })

  window.overlayApi.onOpenAiDone((p) => {
    if (p.requestId !== requestId) return
    isSending.value = false
    responseText.value = p.text || responseText.value
    statusMsg.value = ''
  })

  window.overlayApi.onOpenAiError((p) => {
    if (p.requestId && p.requestId !== requestId) return
    isSending.value = false
    statusMsg.value = p.message || 'Request failed.'
  })
})

onUnmounted(() => { clearAll() })

const responseEl = ref(null)
watch(responseText, async () => {
  await nextTick()
  if (responseEl.value) responseEl.value.scrollTop = responseEl.value.scrollHeight
})
</script>

<template>
  <div class="hud">
    <!-- ─── Recording indicator ─── -->
    <div class="rec-bar glass" v-if="isRecording">
      <span class="rec-dot"></span>
      <span class="rec-time">{{ fmtTime(recordingTime) }}</span>
      <span class="rec-label">Recording</span>
    </div>

    <!-- ─── Response Panel ─── -->
    <div class="panel response-panel glass" v-if="responseText || isSending">
      <div class="panel-label">
        <span class="indicator accent" :class="{ active: isSending }"></span>
        <span>{{ isSending ? 'Generating...' : 'Response' }}</span>
      </div>
      <div class="response-text" ref="responseEl">
        {{ responseText }}<span v-if="isSending && !responseText" class="cursor accent">|</span>
      </div>
    </div>

    <!-- ─── Status ─── -->
    <div class="status-bar glass" v-if="statusMsg && !isRecording">
      {{ statusMsg }}
    </div>

    <!-- Spacer to push controls to bottom -->
    <div class="spacer"></div>

    <!-- ─── Controls ─── -->
    <div class="controls glass">
      <button
        class="ctrl-btn start"
        :class="{ recording: isRecording }"
        @click="isRecording ? stopAndSend() : startRecording()"
        :disabled="isSending"
      >
        {{ isRecording ? '⬆ Send' : '▶ Start' }}
      </button>
      <button class="ctrl-btn" @click="clearAll" :disabled="isRecording">
        Clear
      </button>
      <button class="ctrl-btn exit" @click="quitApp">
        ✕
      </button>
    </div>
  </div>
</template>

<style scoped>
.hud {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
}

/* ── Recording bar ── */
.rec-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  font-size: 13px;
}

.rec-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger);
  animation: pulse-glow 1.5s infinite;
}

.rec-time {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}

.rec-label {
  color: var(--muted);
}

/* ── Panels ── */
.panel {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.panel-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}

.indicator {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  flex-shrink: 0;
}

.indicator.accent.active {
  background: var(--accent);
  animation: pulse-glow 1.5s infinite;
}

.response-panel {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.response-text {
  font-size: 14px;
  line-height: 1.65;
  color: rgba(255, 255, 255, 0.9);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.cursor {
  animation: blink-cursor 0.8s infinite;
  font-weight: 300;
}
.cursor.accent { color: var(--accent); }

/* ── Status ── */
.status-bar {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--muted);
}

.spacer {
  flex: 1;
}

/* ── Controls ── */
.controls {
  display: flex;
  gap: 6px;
  padding: 8px;
  flex-shrink: 0;
}

.ctrl-btn {
  height: 36px;
  border: none;
  border-radius: 8px;
  padding: 0 14px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
  flex: 1;
}

.ctrl-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
}

.ctrl-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.ctrl-btn.start {
  background: linear-gradient(180deg, var(--accent), #7ad14d);
  color: #0a0e08;
  font-weight: 600;
  flex: 2;
}

.ctrl-btn.start:hover:not(:disabled) {
  filter: brightness(1.1);
}

.ctrl-btn.start.recording {
  background: linear-gradient(180deg, #ff8d7d, var(--danger));
  color: #fff;
}

.ctrl-btn.exit {
  flex: 0 0 36px;
  padding: 0;
  color: var(--muted);
  font-size: 14px;
}

.ctrl-btn.exit:hover {
  color: var(--danger);
  background: rgba(255, 111, 111, 0.1);
}
</style>
