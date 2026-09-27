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
import pcmWorkletUrl from '../audio/pcm-worklet.js?url&no-inline'

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

// ── State machine: idle → recording → finalizing → transcribing → answering ──
const appState = ref('idle') // 'idle' | 'recording' | 'finalizing' | 'transcribing' | 'answering'
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

const SCREEN_HISTORY_QUESTION = '[Screenshot: question shown on screen]'
const MAX_FALLBACK_AUDIO_SECONDS = 120
const PCM_SAMPLE_RATE = 24000 // realtime API input rate; also used for the Whisper fallback WAV

let requestId = null
let historyQuestion = '' // what gets stored as the user turn once the answer completes
let answerTimer = null
let answerStartTime = 0
let resizeObserver = null
let recordingTimer = null
let pendingAnswerText = null
let answerRenderFrame = null
let stickToBottom = true // auto-scroll only while the reader is at the bottom

// ── Computed ──
const isRecording = computed(() => appState.value === 'recording')
const isAnswering = computed(() => ['transcribing', 'answering'].includes(appState.value))
const isBusy = computed(() => ['finalizing', 'transcribing', 'answering'].includes(appState.value))

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
function mergePcmFrames(frames) {
  let total = 0
  for (const frame of frames) total += frame.length
  const merged = new Int16Array(total)
  let offset = 0
  for (const frame of frames) { merged.set(frame, offset); offset += frame.length }
  return merged
}

function encodeWav(pcm16, sampleRate) {
  const buf = new ArrayBuffer(44 + pcm16.byteLength)
  const v = new DataView(buf)
  const ws = (view, o, str) => { for (let i = 0; i < str.length; i++) view.setUint8(o + i, str.charCodeAt(i)) }
  ws(v, 0, 'RIFF'); v.setUint32(4, 36 + pcm16.byteLength, true)
  ws(v, 8, 'WAVE'); ws(v, 12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  ws(v, 36, 'data'); v.setUint32(40, pcm16.byteLength, true)
  new Int16Array(buf, 44).set(pcm16)
  return buf
}

let micStream = null
let systemStream = null
let audioContext = null
let workletNode = null
let pcmFrames = [] // Int16Array frames at PCM_SAMPLE_RATE, kept for the Whisper fallback

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
  pcmFrames = []
  recordingSeconds.value = 0

  try {
    // Capture system audio (loopback, works with earphones) and mic in parallel; either alone is enough
    const [sysResult, micResult] = await Promise.allSettled([
      navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      })
    ])

    if (sysResult.status === 'fulfilled') {
      systemStream = sysResult.value
      // Only the loopback audio is needed — drop the screen video track
      systemStream.getVideoTracks().forEach(t => t.stop())
      if (!systemStream.getAudioTracks().length) systemStream = null
    } else {
      console.warn('[audio] system audio unavailable:', sysResult.reason?.message)
    }
    if (micResult.status === 'fulfilled') {
      micStream = micResult.value
    } else {
      console.warn('[audio] mic unavailable:', micResult.reason?.message)
    }
    if (!systemStream && !micStream) {
      throw micResult.reason || sysResult.reason || new Error('No audio source available')
    }

    // The context runs at the realtime API's rate; Chromium resamples the inputs
    audioContext = new AudioContext({ sampleRate: PCM_SAMPLE_RATE })
    await audioContext.audioWorklet.addModule(pcmWorkletUrl)
    workletNode = new AudioWorkletNode(audioContext, 'pcm-capture', { numberOfOutputs: 0 })

    // Both sources feed the same worklet input, which mixes them into one mono stream
    for (const stream of [systemStream, micStream]) {
      if (stream) audioContext.createMediaStreamSource(stream).connect(workletNode)
    }

    // Audio is queued in main until the socket is open (or sent straight away if it is reused)
    window.overlayApi.startRealtimeSession({ apiKey: apiKey.value }).catch((err) => {
      console.warn('[realtime] session start failed, will fall back to Whisper:', err.message)
    })

    const maxFallbackFrames = MAX_FALLBACK_AUDIO_SECONDS * 10 // worklet frames are 100ms

    workletNode.port.onmessage = ({ data }) => {
      if (appState.value !== 'recording') return
      pcmFrames.push(new Int16Array(data.pcm))
      if (pcmFrames.length > maxFallbackFrames) pcmFrames.shift()
      window.overlayApi.sendRealtimeAudioChunk(data.pcm)
    }

    appState.value = 'recording'
    recordingTimer = setInterval(() => recordingSeconds.value++, 1000)
  } catch (err) {
    statusMsg.value = 'Audio capture failed: ' + err.message
    stopRecording()
  }
}

function stopAudioCapture() {
  if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null }
  if (systemStream) { systemStream.getTracks().forEach(t => t.stop()); systemStream = null }
  if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); workletNode = null }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null }
}

function stopRecording() {
  stopAudioCapture()
  if (appState.value === 'recording') appState.value = 'idle'
  liveTranscript.value = ''
}

// ── Answer lifecycle helpers ──
function clearAnswerTimer() {
  if (answerTimer) { clearInterval(answerTimer); answerTimer = null }
}

// Streaming deltas re-render the whole markdown, so apply at most one per frame
function scheduleAnswerText(text) {
  pendingAnswerText = text
  if (answerRenderFrame) return
  answerRenderFrame = requestAnimationFrame(() => {
    answerRenderFrame = null
    answerText.value = pendingAnswerText
  })
}

function cancelAnswerRender() {
  if (answerRenderFrame) { cancelAnimationFrame(answerRenderFrame); answerRenderFrame = null }
}

function beginAnswerPanel(question) {
  detectedQuestion.value = question
  answerText.value = ''
  answerError.value = ''
  showAnswer.value = true
  answerStartTime = Date.now()
  answerElapsed.value = 0
  responseLatency.value = null
  stickToBottom = true
  cancelAnswerRender()
  clearAnswerTimer()
  answerTimer = setInterval(() => {
    answerElapsed.value = Math.round((Date.now() - answerStartTime) / 1000)
  }, 500)
}

function sendAnswerRequest(payload, questionForHistory) {
  requestId = `req_${Date.now()}`
  historyQuestion = questionForHistory
  statusMsg.value = 'Thinking...'
  appState.value = 'answering'
  window.overlayApi.runOpenAiRequest({
    requestId,
    apiKey: apiKey.value,
    conversationHistory: JSON.parse(JSON.stringify(conversationHistory.value)),
    ...payload
  })
}

// Stops capture and returns the final realtime transcript, or a WAV of the
// retained audio when realtime produced nothing.
async function finalizeRecording() {
  stopAudioCapture()
  liveTranscript.value = ''
  appState.value = 'finalizing'
  statusMsg.value = 'Finalizing transcript...'

  let transcript = ''
  try {
    const result = await window.overlayApi.stopRealtimeSession()
    transcript = result?.transcript?.trim() || ''
  } catch (err) {
    console.warn('[realtime] transcript unavailable, falling back to Whisper:', err.message)
  }

  if (transcript || !pcmFrames.length) return { transcript, wav: null }
  return { transcript: '', wav: encodeWav(mergePcmFrames(pcmFrames), PCM_SAMPLE_RATE) }
}

async function transcribeWithWhisper(wav) {
  appState.value = 'transcribing'
  statusMsg.value = 'Transcribing...'
  const result = await window.overlayApi.transcribeAudio({ apiKey: apiKey.value, wav })
  const text = result.text?.trim() || ''
  if (result.error) statusMsg.value = 'Transcription failed: ' + result.error
  else if (!text) statusMsg.value = 'No speech detected. Try again.'
  return text
}

// ── Answer Question ──
async function answerQuestion() {
  if (isBusy.value || !window.overlayApi) return
  if (!apiKey.value) {
    statusMsg.value = 'API key missing. Set VITE_OPENAI_API_KEY in .env.'
    return
  }

  let wav = null
  if (appState.value === 'recording') {
    const finalized = await finalizeRecording()
    if (finalized.transcript) transcriptText.value = finalized.transcript
    wav = finalized.wav
    appState.value = 'idle'
  }

  let question = transcriptText.value.trim()
  if (!question && !wav) {
    statusMsg.value = 'No transcript or audio to analyze.'
    return
  }

  beginAnswerPanel(question)

  if (!question) {
    question = await transcribeWithWhisper(wav)
    if (appState.value !== 'transcribing') return // stopped or closed meanwhile
    if (!question) {
      clearAnswerTimer()
      appState.value = 'idle'
      return
    }
    transcriptText.value = question
    detectedQuestion.value = question
  }

  sendAnswerRequest({ transcribedText: question }, question)
}

// ── Analyze Screen ──
async function analyzeScreen() {
  if (isBusy.value || isRecording.value || !window.overlayApi?.captureScreen) return
  if (!apiKey.value) {
    statusMsg.value = 'API key missing. Set VITE_OPENAI_API_KEY in .env.'
    return
  }

  showPastePanel.value = false
  appState.value = 'answering'
  statusMsg.value = 'Capturing screen...'

  const result = await window.overlayApi.captureScreen()
  if (result.error) {
    statusMsg.value = 'Capture failed: ' + result.error
    appState.value = 'idle'
    return
  }

  beginAnswerPanel('Screen analysis')
  sendAnswerRequest(
    { transcribedText: '', imageBase64: result.imageBase64, imageType: result.imageType || 'jpeg' },
    SCREEN_HISTORY_QUESTION
  )
}

// ── Stop / close answer ──
function stopAnswer() {
  if (requestId) window.overlayApi?.cancelRequest?.(requestId)
  requestId = null
  cancelAnswerRender()
  clearAnswerTimer()
  if (isAnswering.value) appState.value = 'idle'
  statusMsg.value = ''
  if (!answerText.value) answerError.value = 'Stopped.'
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
  stopAnswer()
  showAnswer.value = false
  answerText.value = ''
  answerError.value = ''
  detectedQuestion.value = ''
  responseLatency.value = null
  answerElapsed.value = 0
}

// ── Clear audio ──
function clearAudio() {
  pcmFrames = []
  transcriptText.value = ''
  liveTranscript.value = ''
  window.overlayApi.startRealtimeSession({ apiKey: apiKey.value }).catch(() => {})
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
    scheduleAnswerText(p.text || '')
    if (statusMsg.value === 'Thinking...') statusMsg.value = ''
  })

  window.overlayApi.onOpenAiDone((p) => {
    if (p.requestId !== requestId) return
    cancelAnswerRender()
    const finalText = p.text || pendingAnswerText || answerText.value
    answerText.value = finalText
    responseLatency.value = ((Date.now() - answerStartTime) / 1000).toFixed(1) + 's'
    clearAnswerTimer()
    appState.value = 'idle'
    requestId = null
    if (!finalText) {
      answerError.value = 'No response received — check your API key or try again.'
    }
    if (historyQuestion && finalText) {
      conversationHistory.value.push(
        { role: 'user', content: historyQuestion },
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
    clearAnswerTimer()
    appState.value = 'idle'
    requestId = null
  })

  window.overlayApi.onRealtimeTranscriptDelta((p) => {
    liveTranscript.value = p.displayText || ''
  })
  window.overlayApi.onRealtimeTranscriptDone((p) => {
    liveTranscript.value = p.transcript || ''
  })
  window.overlayApi.onRealtimeError((p) => {
    console.warn('[realtime] error:', p.message)
    if (isRecording.value) statusMsg.value = 'Live transcript: ' + p.message
  })
  window.overlayApi.onSystemError((p) => {
    statusMsg.value = p.message
  })

  window.overlayApi.onShortcutToggleRecord(() => {
    if (isRecording.value) stopRecording()
    else startRecording()
  })
  window.overlayApi.onShortcutAnswer(() => {
    if (transcriptText.value.trim() || isRecording.value) answerQuestion()
  })
  window.overlayApi.onShortcutScreen(() => analyzeScreen())

  window.overlayApi.getContextStatus().then(({ hasJd, hasResume, dir }) => {
    const missing = [!hasJd && 'jd.txt', !hasResume && 'resume.txt'].filter(Boolean)
    if (missing.length) statusMsg.value = `${missing.join(' and ')} not found in ${dir}`
  })

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
  cancelAnswerRender()
  if (answerTimer) clearInterval(answerTimer)
  if (resizeObserver) resizeObserver.disconnect()
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
    if (stickToBottom) answerBodyEl.value.scrollTop = answerBodyEl.value.scrollHeight
  }
})

function onAnswerScroll() {
  const el = answerBodyEl.value
  if (el) stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
</script>

<template>
  <div class="overlay-root" ref="rootEl">

    <!-- ═══ MAIN BAR ═══ -->
    <div class="main-bar">

      <div class="single-row">
        <div class="left-actions">
          <button class="action-btn indigo" @click="answerQuestion" :disabled="isBusy || (!transcriptText.trim() && !isRecording)">
            <span class="action-icon">☰</span>
            <span>answer question</span>
          </button>
          <button class="action-btn green" @click="analyzeScreen" :disabled="isBusy || isRecording">
            <span class="action-icon">◻</span>
            <span>analyze screen</span>
          </button>
          <button class="action-btn amber" :class="{ active: showPastePanel }" @click="showPastePanel = !showPastePanel" :disabled="isBusy">
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
          <button class="action-btn indigo" @click="submitPasteText" :disabled="!pasteText.trim() || isBusy">
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
        <button class="icon-btn stop-btn" @click="stopAnswer" title="Stop" v-if="isAnswering">■</button>
        <button class="icon-btn close-btn" @click="closeAnswer" title="Close">✕</button>
      </div>

      <div class="answer-body" ref="answerBodyEl" @scroll="onAnswerScroll">
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
  /* Never shrink to the window height: the window is sized from this element */
  flex-shrink: 0;
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
