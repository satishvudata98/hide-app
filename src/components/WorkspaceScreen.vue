<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import MainBar from './MainBar.vue'
import PastePanel from './PastePanel.vue'
import AnswerPanel from './AnswerPanel.vue'
import SettingsPanel from './SettingsPanel.vue'
import { useRecorder } from '../composables/useRecorder'
import { useAnswer } from '../composables/useAnswer'

const api = window.overlayApi
const SCREEN_HISTORY_QUESTION = '[Screenshot: question shown on screen]'
const FOLLOW_UP_INSTRUCTIONS = {
  shorter: 'Make that answer shorter: one or two sentences I can say right away.',
  'with code': 'Add a short, working code example to that answer.',
  simpler: 'Explain that answer more simply, in plain words.'
}

// ── API key ──
const envApiKey = import.meta.env.VITE_OPENAI_API_KEY || import.meta.env.VITE_OPENAI_apiKey || ''
const apiKey = ref(envApiKey)
const apiKeyInput = ref('')
const showKeyInput = ref(false)

// ── State ──
// listen: the always-on capture. phase: everything before an answer streams;
// the stream itself is answer.streaming.
const listen = ref('off') // 'off' | 'starting' | 'on' | 'paused'
const connection = ref('offline') // live transcript socket: 'connecting' | 'connected' | 'reconnecting' | 'offline'
const phase = ref('idle') // 'idle' | 'finalizing' | 'transcribing' | 'capturing'
const pendingText = ref('') // heard since the last answer: what the next send answers
const speaking = ref(false) // the interviewer is mid-sentence
const statusMsg = ref('')
const showPastePanel = ref(false)
const showSettings = ref(false)
const clickThrough = ref(false)

// Persisted in the settings file; answerModel/answerStyle/vadSilenceMs are read by main
const settings = reactive({
  micDeviceId: '',
  systemAudio: true,
  includeMic: false,
  autoListen: true,
  answerModel: '',
  answerStyle: 'brief'
})
const AUDIO_SETTINGS = ['micDeviceId', 'systemAudio', 'includeMic']

const recorder = useRecorder()
const answer = useAnswer()

const isBusy = computed(() => phase.value !== 'idle' || answer.streaming.value)
const canFollowUp = computed(() =>
  !isBusy.value && !!answer.latency.value && !!answer.text.value && answer.history.value.length > 0
)
const loadingLabel = computed(() => {
  if (phase.value === 'transcribing') return 'transcribing audio'
  return answer.streaming.value ? 'thinking' : ''
})

function flashStatus(message) {
  statusMsg.value = message
  setTimeout(() => { if (statusMsg.value === message) statusMsg.value = '' }, 2500)
}

function requireApiKey() {
  if (apiKey.value) return true
  statusMsg.value = 'API key missing. Paste it below or set VITE_OPENAI_API_KEY in .env.'
  showKeyInput.value = true
  return false
}

// ── Listening ──
// Capture runs all the time; main keeps the transcript and queues audio
// until the socket is open.
async function startListening() {
  if (listen.value === 'on' || listen.value === 'starting' || !requireApiKey()) return
  listen.value = 'starting'

  api.startRealtimeSession({ apiKey: apiKey.value }).catch((err) => {
    console.warn('[realtime] session start failed, sends will fall back to Whisper:', err.message)
  })

  try {
    await recorder.start((pcm) => api.sendRealtimeAudioChunk(pcm), {
      micDeviceId: settings.micDeviceId,
      systemAudio: settings.systemAudio,
      includeMic: settings.includeMic,
      onInterrupted: () => restartListening('An audio source stopped. Restarting capture…')
    })
    listen.value = 'on'
  } catch (err) {
    listen.value = 'off'
    statusMsg.value = 'Audio capture failed: ' + err.message
  }
}

function pauseListening() {
  recorder.stop()
  listen.value = 'paused'
}

function toggleListening() {
  if (listen.value === 'on') pauseListening()
  else startListening()
}

function restartListening(message) {
  if (listen.value !== 'on') return
  if (message) flashStatus(message)
  recorder.stop()
  listen.value = 'off'
  setTimeout(startListening, 500)
}

// Throws away what was heard so far (small talk before the first question…)
function resetBlock() {
  recorder.takeSinceLastSend()
  api.resetQuestionBlock()
  flashStatus('Cleared. Listening for the next question.')
}

// ── Answering ──
// Sends everything heard since the last answer. Listening never stops. When
// the live transcript is unavailable, the audio since the last send goes to
// Whisper instead.
async function answerQuestion() {
  if (isBusy.value || !requireApiKey()) return
  const pressedAt = Date.now()
  showPastePanel.value = false

  phase.value = 'finalizing'
  const takeWav = recorder.takeSinceLastSend()
  let block
  try {
    block = await api.takeQuestionBlock()
  } catch (err) {
    console.warn('[realtime] block unavailable, falling back to Whisper:', err.message)
    block = { text: '', degraded: true }
  }
  let question = block.text?.trim() || ''

  if (!block.degraded) {
    phase.value = 'idle'
    if (!question) {
      flashStatus(listen.value === 'on' ? 'Nothing new heard since the last answer.' : 'Not listening. Press Ctrl+Shift+Space.')
      return
    }
    answer.begin(question, { pressedAt, kind: 'audio' })
    answer.send(apiKey.value, { question }, question)
    return
  }

  const wav = takeWav()
  if (!wav) {
    phase.value = 'idle'
    if (question) {
      answer.begin(question, { pressedAt, kind: 'audio' })
      answer.send(apiKey.value, { question }, question)
    } else {
      flashStatus('Nothing heard since the last answer.')
    }
    return
  }

  phase.value = 'transcribing'
  answer.begin('', { pressedAt, kind: 'whisper' })
  const result = await api.transcribeAudio({ apiKey: apiKey.value, wav })
  if (phase.value !== 'transcribing') return // stopped or closed meanwhile
  phase.value = 'idle'
  question = result.text?.trim() || question
  if (!question) {
    answer.fail(result.error ? 'Transcription failed: ' + result.error : 'No speech detected. Try again.')
    return
  }
  answer.question.value = question
  answer.send(apiKey.value, { question }, question)
}

function answerPastedText(text) {
  if (isBusy.value || !requireApiKey()) return
  showPastePanel.value = false
  answer.begin(text, { kind: 'paste' })
  answer.send(apiKey.value, { question: text }, text)
}

async function analyzeScreen() {
  if (isBusy.value || !requireApiKey()) return
  const pressedAt = Date.now()

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

  answer.begin('Screen analysis', { pressedAt, kind: 'screen' })
  answer.send(apiKey.value, { imageBase64: result.imageBase64, imageType: result.imageType }, SCREEN_HISTORY_QUESTION)
}

function followUp(kind) {
  if (!canFollowUp.value || !requireApiKey()) return
  const instruction = FOLLOW_UP_INSTRUCTIONS[kind]
  answer.begin(`↳ ${kind}`, { kind: 'follow-up' })
  answer.send(apiKey.value, { question: instruction, isFollowUp: true }, instruction)
}

function stopAnswer() {
  answer.stop()
  if (phase.value === 'transcribing') phase.value = 'idle'
}

function closeAnswer() {
  stopAnswer()
  answer.close()
}

// Paste and settings share the space under the bar; only one is open at a time
function togglePanel(name) {
  const panel = name === 'paste' ? showPastePanel : showSettings
  const opening = !panel.value
  showPastePanel.value = false
  showSettings.value = false
  panel.value = opening
}

function clearSession() {
  answer.clearHistory()
  flashStatus('Session cleared.')
}

// ── Settings ──
async function loadSettings() {
  for (const key of Object.keys(settings)) {
    const value = await api.getSettings(key)
    if (value !== null) settings[key] = value
  }
}

async function updateSetting(key, value) {
  settings[key] = value
  try {
    await api.setSettings(key, value)
  } catch (err) {
    statusMsg.value = 'Could not save settings: ' + err.message
    return
  }
  if (AUDIO_SETTINGS.includes(key)) restartListening()
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
  try {
    await api.setSettings('apiKey', value)
  } catch (err) {
    statusMsg.value = 'Could not save the key: ' + err.message
  }
  apiKey.value = value
  apiKeyInput.value = ''
  showKeyInput.value = false
  flashStatus('API key saved.')
  if (listen.value === 'on') api.startRealtimeSession({ apiKey: value }).catch(() => {}) // reconnects with the new key
  else if (settings.autoListen) startListening()
}

// ── Window height follows the content ──
const rootEl = ref(null)
let resizeObserver = null

function syncWindowHeight() {
  if (rootEl.value) api.resizeHeight(rootEl.value.scrollHeight + 24)
}

// ── Pending text scrolls to the newest words ──
const liveTextEl = ref(null)
watch(pendingText, async () => {
  await nextTick()
  if (liveTextEl.value) liveTextEl.value.scrollLeft = liveTextEl.value.scrollWidth
})

const unsubscribers = []

onMounted(async () => {
  unsubscribers.push(
    api.onRealtimePending(({ text, speaking: isSpeaking }) => {
      pendingText.value = text || ''
      speaking.value = !!isSpeaking
    }),
    api.onRealtimeStatus(({ state, message }) => {
      connection.value = state
      if (message && state !== 'connected') statusMsg.value = message
    }),
    api.onRealtimeError(({ message }) => {
      console.warn('[realtime] error:', message)
      if (listen.value === 'on') statusMsg.value = message
    }),
    api.onShortcutToggleListen(() => toggleListening()),
    api.onShortcutAnswer(() => answerQuestion()),
    api.onShortcutScreen(() => analyzeScreen()),
    api.onWindowState((state) => { clickThrough.value = state.clickThrough })
  )

  api.getContextStatus().then(({ hasJd, hasResume, dir }) => {
    const missing = [!hasJd && 'jd.txt', !hasResume && 'resume.txt'].filter(Boolean)
    if (missing.length) statusMsg.value = `${missing.join(' and ')} not found in ${dir}`
  })

  resizeObserver = new ResizeObserver(syncWindowHeight)
  resizeObserver.observe(rootEl.value)
  syncWindowHeight()

  await Promise.all([loadApiKey(), loadSettings()])
  if (settings.autoListen && apiKey.value) startListening()
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
        :can-answer="!isBusy"
        :can-analyze="!isBusy"
        :can-paste="!isBusy"
        :paste-open="showPastePanel"
        :listen="listen"
        :connection="connection"
        :level="recorder.level.value"
        :has-pending="!!pendingText"
        :has-history="answer.history.value.length > 0"
        :settings-open="showSettings"
        :click-through="clickThrough"
        @answer="answerQuestion"
        @analyze="analyzeScreen"
        @toggle-paste="togglePanel('paste')"
        @toggle-settings="togglePanel('settings')"
        @reset-block="resetBlock"
        @clear-session="clearSession"
        @toggle-listen="toggleListening"
        @quit="api.quitApp()"
      />

      <div class="status-msg" v-if="statusMsg">{{ statusMsg }}</div>

      <div class="live-transcript" v-if="pendingText || speaking">
        <span class="live-dot" :class="{ idle: !speaking }"></span>
        <div class="live-text" ref="liveTextEl">{{ pendingText || '…' }}</div>
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

      <SettingsPanel
        v-if="showSettings"
        :settings="settings"
        @update="updateSetting"
        @close="showSettings = false"
      />

      <PastePanel
        v-if="showPastePanel"
        :disabled="isBusy"
        @submit="answerPastedText"
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
      :can-follow-up="canFollowUp"
      @follow-up="followUp"
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

/* Heard text waiting, interviewer not speaking right now */
.live-dot.idle {
  background: var(--text-hint);
  animation: none;
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
