<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import MainBar from './MainBar.vue'
import PastePanel from './PastePanel.vue'
import AnswerPanel from './AnswerPanel.vue'
import { useRecorder } from '../composables/useRecorder'
import { useAnswer } from '../composables/useAnswer'

const api = window.overlayApi
const SCREEN_HISTORY_QUESTION = '[Screenshot: question shown on screen]'

// ── API key ──
const envApiKey = import.meta.env.VITE_OPENAI_API_KEY || import.meta.env.VITE_OPENAI_apiKey || ''
const apiKey = ref(envApiKey)
const apiKeyInput = ref('')
const showKeyInput = ref(false)

// ── State ──
// phase covers everything before the answer streams; the stream itself is answer.streaming
const phase = ref('idle') // 'idle' | 'recording' | 'finalizing' | 'transcribing' | 'capturing'
const transcriptText = ref('') // the question to answer (realtime transcript or pasted text)
const liveTranscript = ref('')
const statusMsg = ref('')
const showPastePanel = ref(false)

const recorder = useRecorder()
const answer = useAnswer()

const isRecording = computed(() => phase.value === 'recording')
const isBusy = computed(() => ['finalizing', 'transcribing', 'capturing'].includes(phase.value) || answer.streaming.value)
const canAnswer = computed(() => !isBusy.value && (isRecording.value || !!transcriptText.value.trim()))
const loadingLabel = computed(() => {
  if (phase.value === 'transcribing') return 'transcribing audio'
  return answer.streaming.value ? 'thinking' : ''
})

function flashStatus(message) {
  statusMsg.value = message
  setTimeout(() => { if (statusMsg.value === message) statusMsg.value = '' }, 2000)
}

function requireApiKey() {
  if (apiKey.value) return true
  statusMsg.value = 'API key missing. Paste it below or set VITE_OPENAI_API_KEY in .env.'
  showKeyInput.value = true
  return false
}

// ── Recording ──
async function startRecording() {
  if (phase.value !== 'idle' || isBusy.value || !requireApiKey()) return

  showPastePanel.value = false
  transcriptText.value = ''
  liveTranscript.value = ''
  statusMsg.value = ''
  answer.close()

  // Start (or reset) the realtime session before audio flows; main queues
  // audio until the socket is open.
  api.startRealtimeSession({ apiKey: apiKey.value }).catch((err) => {
    console.warn('[realtime] session start failed, will fall back to Whisper:', err.message)
  })

  try {
    await recorder.start((pcm) => api.sendRealtimeAudioChunk(pcm))
    phase.value = 'recording'
  } catch (err) {
    statusMsg.value = 'Audio capture failed: ' + err.message
  }
}

function discardRecording() {
  recorder.stop()
  liveTranscript.value = ''
  if (isRecording.value) phase.value = 'idle'
}

function clearAudio() {
  recorder.clearBuffer()
  transcriptText.value = ''
  liveTranscript.value = ''
  api.startRealtimeSession({ apiKey: apiKey.value }).catch(() => {}) // clears the server buffer
  flashStatus('Cleared.')
}

// Stops capture and returns the realtime transcript, or a WAV of the retained
// audio when realtime produced nothing.
async function finalizeRecording() {
  recorder.stop()
  liveTranscript.value = ''
  phase.value = 'finalizing'
  statusMsg.value = 'Finalizing transcript...'

  let transcript = ''
  try {
    transcript = (await api.stopRealtimeSession())?.transcript?.trim() || ''
  } catch (err) {
    console.warn('[realtime] transcript unavailable, falling back to Whisper:', err.message)
  }
  statusMsg.value = ''
  return transcript ? { transcript, wav: null } : { transcript: '', wav: recorder.takeFallbackWav() }
}

// ── Answering ──
async function answerQuestion() {
  if (!canAnswer.value || !requireApiKey()) return

  let wav = null
  if (isRecording.value) {
    const result = await finalizeRecording()
    if (result.transcript) transcriptText.value = result.transcript
    wav = result.wav
    phase.value = 'idle'
  }

  let question = transcriptText.value.trim()
  if (!question && !wav) {
    statusMsg.value = 'No transcript or audio to analyze.'
    return
  }

  answer.begin(question)

  if (!question) {
    phase.value = 'transcribing'
    const result = await api.transcribeAudio({ apiKey: apiKey.value, wav })
    if (phase.value !== 'transcribing') return // stopped or closed meanwhile
    phase.value = 'idle'
    question = result.text?.trim() || ''
    if (!question) {
      answer.fail(result.error ? 'Transcription failed: ' + result.error : 'No speech detected. Try again.')
      return
    }
    transcriptText.value = question
    answer.question.value = question
  }

  answer.send(apiKey.value, { question }, question)
}

async function analyzeScreen() {
  if (isBusy.value || isRecording.value || !requireApiKey()) return

  showPastePanel.value = false
  phase.value = 'capturing'
  statusMsg.value = 'Capturing screen...'
  const result = await api.captureScreen()
  phase.value = 'idle'
  statusMsg.value = ''

  if (result.error) {
    statusMsg.value = 'Capture failed: ' + result.error
    return
  }

  answer.begin('Screen analysis')
  answer.send(apiKey.value, { imageBase64: result.imageBase64, imageType: result.imageType }, SCREEN_HISTORY_QUESTION)
}

function stopAnswer() {
  answer.stop()
  if (phase.value === 'transcribing') phase.value = 'idle'
}

function closeAnswer() {
  stopAnswer()
  answer.close()
}

function submitPasteText(text) {
  transcriptText.value = text
  showPastePanel.value = false
  answerQuestion()
}

function clearSession() {
  answer.clearHistory()
  flashStatus('Session cleared.')
}

// ── API key persistence ──
async function loadApiKey() {
  const stored = await api.getSettings('apiKey')
  if (stored) apiKey.value = stored
  showKeyInput.value = !apiKey.value
}

async function saveApiKey() {
  const value = apiKeyInput.value.trim()
  if (!value) return
  await api.setSettings('apiKey', value)
  apiKey.value = value
  apiKeyInput.value = ''
  showKeyInput.value = false
  flashStatus('API key saved.')
}

// ── Window height follows the content ──
const rootEl = ref(null)
let resizeObserver = null

function syncWindowHeight() {
  if (rootEl.value) api.resizeHeight(rootEl.value.scrollHeight + 24)
}

// ── Live transcript scrolls to the newest words ──
const liveTextEl = ref(null)
watch(liveTranscript, async () => {
  await nextTick()
  if (liveTextEl.value) liveTextEl.value.scrollLeft = liveTextEl.value.scrollWidth
})

const unsubscribers = []

onMounted(() => {
  loadApiKey()

  unsubscribers.push(
    api.onRealtimeTranscriptDelta(({ displayText }) => { liveTranscript.value = displayText || '' }),
    api.onRealtimeTranscriptDone(({ transcript }) => { liveTranscript.value = transcript || '' }),
    api.onRealtimeError(({ message }) => {
      console.warn('[realtime] error:', message)
      if (isRecording.value) statusMsg.value = 'Live transcript: ' + message
    }),
    api.onShortcutToggleRecord(() => (isRecording.value ? discardRecording() : startRecording())),
    api.onShortcutAnswer(() => answerQuestion()),
    api.onShortcutScreen(() => analyzeScreen())
  )

  api.getContextStatus().then(({ hasJd, hasResume, dir }) => {
    const missing = [!hasJd && 'jd.txt', !hasResume && 'resume.txt'].filter(Boolean)
    if (missing.length) statusMsg.value = `${missing.join(' and ')} not found in ${dir}`
  })

  resizeObserver = new ResizeObserver(syncWindowHeight)
  resizeObserver.observe(rootEl.value)
  syncWindowHeight()
})

onUnmounted(() => {
  recorder.stop()
  resizeObserver?.disconnect()
  unsubscribers.forEach((unsubscribe) => unsubscribe())
})
</script>

<template>
  <div class="overlay-root" ref="rootEl">
    <div class="main-bar">
      <MainBar
        :can-answer="canAnswer"
        :can-analyze="!isBusy && !isRecording"
        :can-paste="!isBusy"
        :paste-open="showPastePanel"
        :is-recording="isRecording"
        :recording-seconds="recorder.seconds.value"
        :has-history="answer.history.value.length > 0"
        @answer="answerQuestion"
        @analyze="analyzeScreen"
        @toggle-paste="showPastePanel = !showPastePanel"
        @clear-audio="clearAudio"
        @clear-session="clearSession"
        @rec="isRecording ? answerQuestion() : startRecording()"
        @quit="api.quitApp()"
      />

      <div class="status-msg" v-if="statusMsg">{{ statusMsg }}</div>

      <div class="live-transcript" v-if="isRecording && liveTranscript">
        <span class="live-dot"></span>
        <div class="live-text" ref="liveTextEl">{{ liveTranscript }}</div>
      </div>

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

      <PastePanel
        v-if="showPastePanel"
        :disabled="isBusy"
        @submit="submitPasteText"
        @close="showPastePanel = false"
      />
    </div>

    <AnswerPanel
      v-if="answer.visible.value"
      :question="answer.question.value"
      :text="answer.text.value"
      :error="answer.error.value"
      :loading-label="loadingLabel"
      :elapsed="answer.elapsed.value"
      :latency="answer.latency.value"
      :can-stop="answer.streaming.value || phase === 'transcribing'"
      @stop="stopAnswer"
      @close="closeAnswer"
    />
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
</style>
