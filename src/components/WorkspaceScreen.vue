<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/core'
import python from 'highlight.js/lib/languages/python'
import javascript from 'highlight.js/lib/languages/javascript'
import java from 'highlight.js/lib/languages/java'
import typescript from 'highlight.js/lib/languages/typescript'
import bash from 'highlight.js/lib/languages/bash'
import sql from 'highlight.js/lib/languages/sql'
import DOMPurify from 'dompurify'

// ── Config ──
const envApiKey = import.meta.env.VITE_OPENAI_API_KEY || import.meta.env.VITE_OPENAI_apiKey || ''
const apiKey = ref(envApiKey)
const apiKeyInput = ref('')
const showKeyInput = ref(false)

// ── Register highlight.js languages ──
hljs.registerLanguage('python', python)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('java', java)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sql', sql)

// ── State machine: idle → recording → transcribing → answering ──
const appState = ref('idle') // 'idle' | 'recording' | 'transcribing' | 'answering'
const transcriptText = ref('')
const answerText = ref('')
const detectedQuestion = ref('')
const answerElapsed = ref(0)
const showAnswer = ref(false)
const statusMsg = ref('')
const conversationHistory = ref([]) // last 2 exchanges = 4 messages
const responseLatency = ref(null)
const copied = ref(false)
const recordingSeconds = ref(0)
const answerError = ref('')
const liveTranscript = ref('')
const showPastePanel = ref(false)
const pasteText = ref('')

let requestId = null
let answerTimer = null
let answerStartTime = 0
let resizeObserver = null
let recordingTimer = null

// ── Computed ──
const isRecording = computed(() => appState.value === 'recording')
const isAnswering = computed(() => ['transcribing', 'answering'].includes(appState.value))

// ── Markdown rendering ──
const renderedAnswer = computed(() => {
  if (!answerText.value) return ''
  try {
    const html = marked.parse(answerText.value, { breaks: true, gfm: true })
    return DOMPurify.sanitize(typeof html === 'string' ? html : '')
  } catch {
    return answerText.value.replace(/\n/g, '<br>')
  }
})

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

// Downsample Float32 mono → PCM16 at 24kHz → base64 (sync, for realtime streaming)
function floatToPcm16Base64(float32Array, sourceRate) {
  const ratio = sourceRate / 24000
  const targetLen = Math.floor(float32Array.length / ratio)
  const pcm16 = new Int16Array(targetLen)
  for (let i = 0; i < targetLen; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.floor((i + 1) * ratio)
    let sum = 0, count = 0
    for (let j = start; j < end && j < float32Array.length; j++) { sum += float32Array[j]; count++ }
    const s = count ? sum / count : 0
    pcm16[i] = Math.max(-32768, Math.min(32767, s < 0 ? s * 32768 : s * 32767))
  }
  const bytes = new Uint8Array(pcm16.buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCodePoint(bytes[i])
  return btoa(binary)
}

let micStream = null
let audioContext = null
let processor = null
let silenceGain = null
let audioChunks = []

async function startRecording() {
  if (appState.value !== 'idle') return
  if (!apiKey.value) {
    statusMsg.value = 'API key missing. Set VITE_OPENAI_API_KEY in .env.'
    return
  }

  showPastePanel.value = false
  transcriptText.value = ''
  liveTranscript.value = ''
  answerText.value = ''
  detectedQuestion.value = ''
  showAnswer.value = false
  statusMsg.value = ''
  audioChunks = []
  recordingSeconds.value = 0

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    })

    audioContext = new AudioContext()
    processor = audioContext.createScriptProcessor(4096, 1, 1)

    silenceGain = audioContext.createGain()
    silenceGain.gain.value = 0
    processor.connect(silenceGain)
    silenceGain.connect(audioContext.destination)

    const source = audioContext.createMediaStreamSource(micStream)
    source.connect(processor)

    // Open realtime WS session — audio queued in main until WS opens
    window.overlayApi?.startRealtimeSession({ apiKey: apiKey.value }).catch((err) => {
      console.warn('[realtime] session start failed, will fall back to Whisper:', err.message)
    })

    const captureRate = audioContext.sampleRate

    processor.onaudioprocess = (e) => {
      if (appState.value !== 'recording') return
      const mono = mixToMono(e.inputBuffer)
      audioChunks.push(mono) // retained for Whisper fallback
      window.overlayApi?.sendRealtimeAudioChunk({ audioBase64: floatToPcm16Base64(mono, captureRate) })
    }

    appState.value = 'recording'
    recordingTimer = setInterval(() => recordingSeconds.value++, 1000)
  } catch (err) {
    statusMsg.value = 'Mic access failed: ' + err.message
    stopRecording()
  }
}

function stopAudioCapture() {
  if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null }
  if (processor) { processor.disconnect(); processor = null }
  if (silenceGain) { silenceGain.disconnect(); silenceGain = null }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null }
}

function stopRecording() {
  stopAudioCapture()
  if (appState.value === 'recording') appState.value = 'idle'
  liveTranscript.value = ''
  window.overlayApi?.closeRealtimeSession()
}

// ── Answer Question ──
async function answerQuestion() {
  if (!apiKey.value) {
    statusMsg.value = 'API key missing. Set VITE_OPENAI_API_KEY in .env.'
    return
  }

  // Cancel any in-flight request before starting a new one
  if (requestId && isAnswering.value) {
    window.overlayApi?.cancelRequest?.(requestId)
    if (answerTimer) { clearInterval(answerTimer); answerTimer = null }
  }

  let audioBase64 = null
  let capturedSampleRate = 48000

  if (appState.value === 'recording') {
    capturedSampleRate = audioContext?.sampleRate || 48000
    stopAudioCapture()
    appState.value = 'idle'
    liveTranscript.value = ''

    // Commit realtime buffer and wait up to 3s for final transcript
    statusMsg.value = 'Finalizing transcript...'
    try {
      const result = await window.overlayApi.stopRealtimeSession()
      window.overlayApi.closeRealtimeSession()
      const transcribed = result?.transcript?.trim() || ''
      if (transcribed) {
        transcriptText.value = transcribed
      }
    } catch (err) {
      window.overlayApi?.closeRealtimeSession()
      console.warn('[realtime] transcript unavailable, falling back to Whisper:', err.message)
    }

    // Whisper fallback if realtime produced no transcript
    if (!transcriptText.value.trim() && audioChunks.length > 0) {
      statusMsg.value = 'Processing audio...'
      const merged = mergeChunks(audioChunks)
      const downsampled = downsample(merged, capturedSampleRate, 16000)
      const wavBuffer = encodeWav(downsampled, 16000)
      audioBase64 = await arrayBufferToBase64(wavBuffer)
    }
  }

  const text = transcriptText.value.trim()

  if (!text && !audioBase64) {
    statusMsg.value = 'No transcript or audio to analyze.'
    return
  }

  answerText.value = ''
  answerError.value = ''
  showAnswer.value = true
  answerStartTime = Date.now()
  answerElapsed.value = 0
  responseLatency.value = null

  answerTimer = setInterval(() => {
    answerElapsed.value = Math.round((Date.now() - answerStartTime) / 1000)
  }, 500)

  requestId = `req_${Date.now()}`

  if (audioBase64) {
    // ── Two-stage: Whisper transcription first, then GPT-4o answer ──
    appState.value = 'transcribing'
    statusMsg.value = 'Transcribing...'
    detectedQuestion.value = ''

    if (!window.overlayApi) return

    const result = await window.overlayApi.transcribeAudio({ apiKey: apiKey.value, audioBase64, format: 'wav' })

    if (result.error) {
      statusMsg.value = 'Transcription failed: ' + result.error
      if (answerTimer) { clearInterval(answerTimer); answerTimer = null }
      appState.value = 'idle'
      return
    }

    const transcribed = result.text?.trim() || ''
    if (!transcribed) {
      statusMsg.value = 'No speech detected. Try again.'
      if (answerTimer) { clearInterval(answerTimer); answerTimer = null }
      appState.value = 'idle'
      return
    }

    transcriptText.value = transcribed
    detectedQuestion.value = transcribed
    statusMsg.value = 'Thinking...'
    appState.value = 'answering'

    window.overlayApi.runOpenAiRequest({
      requestId,
      apiKey: apiKey.value,
      transcribedText: transcribed,
      format: 'text',
      conversationHistory: JSON.parse(JSON.stringify(conversationHistory.value))
    })
  } else {
    // ── Text mode ──
    detectedQuestion.value = text
    statusMsg.value = 'Thinking...'
    appState.value = 'answering'

    if (window.overlayApi) {
      window.overlayApi.runOpenAiRequest({
        requestId,
        apiKey: apiKey.value,
        transcribedText: text,
        format: 'text',
        conversationHistory: JSON.parse(JSON.stringify(conversationHistory.value))
      })
    }
  }
}

// ── Analyze Screen ──
async function analyzeScreen() {
  if (!apiKey.value) {
    statusMsg.value = 'API key missing. Set VITE_OPENAI_API_KEY in .env.'
    return
  }

  showPastePanel.value = false

  if (requestId && isAnswering.value) {
    window.overlayApi?.cancelRequest?.(requestId)
    if (answerTimer) { clearInterval(answerTimer); answerTimer = null }
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

  detectedQuestion.value = 'Screen analysis'
  answerText.value = ''
  answerError.value = ''
  showAnswer.value = true
  appState.value = 'answering'
  answerStartTime = Date.now()
  answerElapsed.value = 0
  responseLatency.value = null
  statusMsg.value = 'Thinking...'

  answerTimer = setInterval(() => {
    answerElapsed.value = Math.round((Date.now() - answerStartTime) / 1000)
  }, 500)

  requestId = `req_${Date.now()}`

  window.overlayApi.runOpenAiRequest({
    requestId,
    apiKey: apiKey.value,
    transcribedText: transcriptText.value.trim() || '',
    imageBase64: result.imageBase64,
    imageType: result.imageType || 'jpeg',
    format: 'text',
    conversationHistory: JSON.parse(JSON.stringify(conversationHistory.value))
  })
}

// ── Copy answer ──
async function copyAnswer() {
  if (!answerText.value) return
  try {
    await navigator.clipboard.writeText(answerText.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch {
    statusMsg.value = 'Copy failed.'
  }
}

// ── Close answer ──
function closeAnswer() {
  showAnswer.value = false
  answerText.value = ''
  detectedQuestion.value = ''
  responseLatency.value = null
  if (answerTimer) { clearInterval(answerTimer); answerTimer = null }
  answerElapsed.value = 0
  appState.value = 'idle'
}

// ── Clear audio ──
function clearAudio() {
  audioChunks = []
  transcriptText.value = ''
  liveTranscript.value = ''
  window.overlayApi?.closeRealtimeSession?.()
  statusMsg.value = 'Cleared.'
  setTimeout(() => { if (statusMsg.value === 'Cleared.') statusMsg.value = '' }, 2000)
}

// ── Clear session history ──
function clearSession() {
  conversationHistory.value = []
  statusMsg.value = 'Session cleared.'
  setTimeout(() => { if (statusMsg.value === 'Session cleared.') statusMsg.value = '' }, 2000)
}

// ── Submit pasted text ──
async function submitPasteText() {
  const text = pasteText.value.trim()
  if (!text) return
  transcriptText.value = text
  showPastePanel.value = false
  pasteText.value = ''
  await answerQuestion()
}

// ── Exit ──
function quitApp() {
  if (window.overlayApi) window.overlayApi.quitApp()
}

// ── Dynamic window height ──
const rootEl = ref(null)

function syncWindowHeight() {
  if (!rootEl.value || !window.overlayApi?.resizeHeight) return
  const height = rootEl.value.scrollHeight + 24
  window.overlayApi.resizeHeight(height)
}

// ── API key persistence ──
async function loadApiKey() {
  if (!window.overlayApi?.getSettings) return
  const stored = await window.overlayApi.getSettings('apiKey')
  if (stored) {
    apiKey.value = stored
    showKeyInput.value = false
  } else if (!apiKey.value) {
    showKeyInput.value = true
  }
}

async function saveApiKey() {
  const val = apiKeyInput.value.trim()
  if (!val) return
  if (window.overlayApi?.setSettings) {
    await window.overlayApi.setSettings('apiKey', val)
  }
  apiKey.value = val
  showKeyInput.value = false
  statusMsg.value = 'API key saved.'
  setTimeout(() => { if (statusMsg.value === 'API key saved.') statusMsg.value = '' }, 2000)
}

// ── OpenAI response handlers ──
onMounted(() => {
  if (!window.overlayApi) return

  loadApiKey()

  window.overlayApi.onOpenAiStarted((p) => {
    if (p.requestId !== requestId) return
    statusMsg.value = ''
  })

  window.overlayApi.onOpenAiDelta((p) => {
    if (p.requestId !== requestId) return
    answerText.value = p.text || ''
    if (statusMsg.value === 'Thinking...') statusMsg.value = ''
  })

  window.overlayApi.onOpenAiDone((p) => {
    if (p.requestId !== requestId) return
    const finalText = p.text || answerText.value
    answerText.value = finalText
    responseLatency.value = ((Date.now() - answerStartTime) / 1000).toFixed(1) + 's'
    if (answerTimer) { clearInterval(answerTimer); answerTimer = null }
    appState.value = 'idle'
    if (!finalText) {
      answerError.value = 'No response received — check your API key or try again.'
    }
    if (detectedQuestion.value && finalText) {
      conversationHistory.value.push(
        { role: 'user', content: detectedQuestion.value },
        { role: 'assistant', content: finalText }
      )
      if (conversationHistory.value.length > 4) {
        conversationHistory.value = conversationHistory.value.slice(-4)
      }
    }
    statusMsg.value = ''
  })

  window.overlayApi.onOpenAiError((p) => {
    if (p.requestId && p.requestId !== requestId) return
    answerError.value = p.message || 'Request failed.'
    statusMsg.value = ''
    if (answerTimer) { clearInterval(answerTimer); answerTimer = null }
    appState.value = 'idle'
  })

  if (window.overlayApi.onRealtimeTranscriptDelta) {
    window.overlayApi.onRealtimeTranscriptDelta((p) => {
      liveTranscript.value = p.displayText || ''
    })
    window.overlayApi.onRealtimeTranscriptDone((p) => {
      liveTranscript.value = p.transcript || ''
    })
    window.overlayApi.onRealtimeError((p) => {
      console.warn('[realtime] error:', p.message)
    })
  }

  if (window.overlayApi.onShortcutPageUp) {
    window.overlayApi.onShortcutPageUp(() => {
      if (isRecording.value) stopRecording()
      else startRecording()
    })
    window.overlayApi.onShortcutPageDown(() => {
      if (!isAnswering.value && (transcriptText.value.trim() || isRecording.value)) {
        answerQuestion()
      }
    })
  }

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

watch([answerText, showAnswer, transcriptText, appState, statusMsg, liveTranscript, showPastePanel, pasteText], () => {
  nextTick(() => syncWindowHeight())
})

const answerBodyEl = ref(null)
const liveTextEl = ref(null)

watch(liveTranscript, async () => {
  await nextTick()
  if (liveTextEl.value) liveTextEl.value.scrollLeft = liveTextEl.value.scrollWidth
})

watch(renderedAnswer, async () => {
  await nextTick()
  if (answerBodyEl.value) {
    // Apply highlight.js to any unhighlighted code blocks
    answerBodyEl.value.querySelectorAll('pre code:not(.hljs)').forEach(el => {
      hljs.highlightElement(el)
    })
    answerBodyEl.value.scrollTop = answerBodyEl.value.scrollHeight
  }
})
</script>

<template>
  <div class="overlay-root" ref="rootEl">

    <!-- ═══ MAIN BAR ═══ -->
    <div class="main-bar">

      <div class="single-row">
        <div class="left-actions">
          <button class="action-btn indigo" @click="answerQuestion" :disabled="isAnswering || (!transcriptText.trim() && !isRecording)">
            <span class="action-icon">☰</span>
            <span>answer question</span>
          </button>
          <button class="action-btn green" @click="analyzeScreen" :disabled="isAnswering">
            <span class="action-icon">◻</span>
            <span>analyze screen</span>
          </button>
          <button class="action-btn amber" :class="{ active: showPastePanel }" @click="showPastePanel = !showPastePanel" :disabled="isAnswering">
            <span class="action-icon">✎</span>
            <span>paste text</span>
          </button>
        </div>

        <!-- Drag area in the middle -->
        <div class="drag-space" title="Drag to move"></div>

        <div class="right-actions">
          <button class="icon-btn" v-if="isRecording" @click="clearAudio" title="Clear recorded audio">↺</button>
          <button class="icon-btn clear-btn" v-if="conversationHistory.length > 0" @click="clearSession" title="Clear session history">⊘</button>
          <div class="rec-pill" :class="isRecording ? 'active' : 'inactive'" @click="isRecording ? answerQuestion() : startRecording()">
            <span class="rec-dot" :class="{ pulsing: isRecording }"></span>
            <span class="rec-label">{{ isRecording ? recordingSeconds + 's' : 'rec' }}</span>
          </div>
          <button class="icon-btn exit-btn" @click="quitApp" title="Exit">✕</button>
        </div>
      </div>

      <!-- Status message -->
      <div class="status-msg" v-if="statusMsg">{{ statusMsg }}</div>

      <!-- Live transcript while recording -->
      <div class="live-transcript" v-if="isRecording && liveTranscript">
        <span class="live-dot"></span>
        <div class="live-text" ref="liveTextEl">{{ liveTranscript }}</div>
      </div>

      <!-- API key input — shown when no key is set -->
      <div class="key-row" v-if="showKeyInput">
        <input
          class="key-input"
          v-model="apiKeyInput"
          type="password"
          placeholder="Paste OpenAI API key (sk-…)"
          @keydown.enter="saveApiKey"
        />
        <button class="action-btn indigo key-save-btn" @click="saveApiKey">Save</button>
      </div>

      <!-- Paste text panel -->
      <div class="paste-row" v-if="showPastePanel">
        <div class="paste-header">
          <span class="paste-title">paste text / code</span>
          <button class="icon-btn" @click="showPastePanel = false" title="Close">✕</button>
        </div>
        <textarea
          class="paste-textarea"
          v-model="pasteText"
          placeholder="Paste code or type a question here..."
          @keydown.ctrl.enter.prevent="submitPasteText"
          rows="4"
        ></textarea>
        <div class="paste-footer">
          <span class="paste-hint">Ctrl+Enter to submit</span>
          <button class="action-btn indigo" @click="submitPasteText" :disabled="!pasteText.trim() || isAnswering">
            <span>analyze</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ═══ CONNECTOR LINE ═══ -->
    <div class="connector-line" v-if="showAnswer"></div>

    <!-- ═══ ANSWER BLOCK ═══ -->
    <div class="answer-block" v-if="showAnswer">
      <div class="answer-header">
        <div class="answer-label">
          <span class="answer-dot"></span>
          <span>ai answer</span>
          <span class="answer-latency" v-if="responseLatency">· {{ responseLatency }}</span>
        </div>
        <span class="answer-elapsed" v-if="answerElapsed > 0 && !responseLatency">{{ answerElapsed }}s</span>
        <button class="icon-btn copy-btn" @click="copyAnswer" :title="copied ? 'Copied!' : 'Copy answer'" v-if="answerText">
          {{ copied ? '✓' : '⎘' }}
        </button>
        <button class="icon-btn close-btn" @click="closeAnswer" title="Close">✕</button>
      </div>

      <div class="answer-body" ref="answerBodyEl">
        <!-- Detected question -->
        <div class="detected-question" v-if="detectedQuestion">
          "{{ detectedQuestion }}"
        </div>

        <!-- Streaming answer rendered as markdown -->
        <div class="answer-md" v-if="renderedAnswer" v-html="renderedAnswer"></div>

        <!-- Error state -->
        <div class="answer-error" v-if="answerError">{{ answerError }}</div>

        <!-- Loading state -->
        <div class="answer-loading" v-if="!answerText && !answerError && isAnswering">
          <span class="stage-label" v-if="appState === 'transcribing'">transcribing audio</span>
          <span class="stage-label" v-else>thinking</span>
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

/* ── Single Row ── */
.single-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
}

.left-actions, .right-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.drag-space {
  -webkit-app-region: drag;
  flex: 1;
  height: 26px;
  cursor: grab;
}

.rec-pill {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 8px;
  border-radius: 20px;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 52px;
}

.rec-pill.inactive {
  background: rgba(16, 185, 129, 0.10);
  border: 1px solid rgba(16, 185, 129, 0.20);
}

.rec-pill.inactive:hover {
  background: rgba(16, 185, 129, 0.18);
}

.rec-pill.inactive .rec-dot {
  background: var(--green);
  opacity: 1;
}

.rec-pill.inactive .rec-label {
  color: var(--green);
}

.rec-pill.active {
  background: rgba(239, 68, 68, 0.16);
  border: 1px solid rgba(239, 68, 68, 0.35);
}

.rec-pill.active:hover {
  background: rgba(239, 68, 68, 0.22);
}

.rec-pill.active .rec-dot {
  background: var(--red);
  opacity: 0.4;
}

.rec-pill.active .rec-label {
  color: var(--red);
}

.rec-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.rec-dot.pulsing {
  opacity: 1;
  animation: pulse-red 1.2s ease-in-out infinite;
}

.rec-label {
  font-size: 11px;
  font-weight: 500;
  text-transform: lowercase;
  font-variant-numeric: tabular-nums;
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

.copy-btn {
  font-size: 14px;
}

.copy-btn:hover {
  color: var(--indigo);
  background: rgba(99, 102, 241, 0.10);
}

.action-btn {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 12px;
  border: none;
  border-radius: 8px;
  font-size: 11px;
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

/* ── API key input ── */
.key-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.key-input {
  flex: 1;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 11px;
  padding: 4px 8px;
  outline: none;
  height: 24px;
  -webkit-app-region: no-drag;
}

.key-input:focus {
  border-color: rgba(99, 102, 241, 0.45);
  background: rgba(99, 102, 241, 0.06);
}

.key-input::placeholder {
  color: var(--text-hint);
}

.key-save-btn {
  height: 24px;
  padding: 0 10px;
  font-size: 10px;
  flex-shrink: 0;
}

/* ── Status ── */
.status-msg {
  padding: 4px 10px 6px;
  font-size: 10px;
  color: var(--text-hint);
  border-top: 1px solid rgba(255, 255, 255, 0.03);
}

/* ── Live transcript ── */
.live-transcript {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.03);
  overflow: hidden;
}

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--red);
  flex-shrink: 0;
  animation: pulse-red 1.2s ease-in-out infinite;
}

.live-text {
  font-size: 11px;
  color: var(--text-hint);
  line-height: 1.5;
  white-space: nowrap;
  overflow-x: hidden;
  flex: 1;
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

/* ── Amber action button (paste text) ── */
.action-btn.amber {
  background: rgba(245, 158, 11, 0.10);
  color: rgb(251, 191, 36);
  border: 1px solid rgba(245, 158, 11, 0.18);
}

.action-btn.amber:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.20);
}

.action-btn.amber.active {
  background: rgba(245, 158, 11, 0.22);
  border-color: rgba(245, 158, 11, 0.40);
}

/* ── Clear session button ── */
.clear-btn:hover {
  color: rgb(251, 191, 36);
  background: rgba(245, 158, 11, 0.12);
}

/* ── Paste text panel ── */
.paste-row {
  padding: 6px 10px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.paste-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2px;
}

.paste-title {
  font-size: 10px;
  color: var(--text-hint);
  text-transform: lowercase;
  font-weight: 500;
}

.paste-textarea {
  width: 100%;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: 'SF Mono', ui-monospace, 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
  line-height: 1.5;
  padding: 6px 8px;
  outline: none;
  resize: vertical;
  box-sizing: border-box;
  -webkit-app-region: no-drag;
}

.paste-textarea:focus {
  border-color: rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.04);
}

.paste-textarea::placeholder {
  color: var(--text-hint);
}

.paste-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.paste-hint {
  font-size: 10px;
  color: var(--text-hint);
}
</style>
