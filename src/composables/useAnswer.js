import { ref, onMounted, onUnmounted } from 'vue'

const HISTORY_MESSAGES = 4 // last 2 question/answer exchanges

// One streamed answer at a time: request lifecycle, streamed text, timing,
// and the short conversation history used for follow-up questions.
export function useAnswer() {
  const visible = ref(false)
  const question = ref('') // shown above the answer
  const text = ref('')
  const error = ref('')
  const streaming = ref(false)
  const elapsed = ref(0)
  const latency = ref(null)
  const history = ref([])

  let requestId = null
  let historyQuestion = '' // stored as the user turn once the answer completes
  let startTime = 0
  let timer = null
  let pendingText = ''
  let renderFrame = null

  function stopTimer() {
    clearInterval(timer)
    timer = null
  }

  function cancelRender() {
    if (renderFrame) cancelAnimationFrame(renderFrame)
    renderFrame = null
  }

  // Streaming deltas re-render the whole markdown, so apply at most one per frame
  function scheduleText(nextText) {
    pendingText = nextText
    if (renderFrame) return
    renderFrame = requestAnimationFrame(() => {
      renderFrame = null
      text.value = pendingText
    })
  }

  function finish() {
    requestId = null
    streaming.value = false
    cancelRender()
    stopTimer()
  }

  // Opens the panel and starts the clock (before transcription, if any).
  function begin(displayQuestion) {
    finish()
    visible.value = true
    question.value = displayQuestion
    text.value = ''
    pendingText = ''
    error.value = ''
    latency.value = null
    elapsed.value = 0
    startTime = Date.now()
    timer = setInterval(() => { elapsed.value = Math.round((Date.now() - startTime) / 1000) }, 500)
  }

  function send(apiKey, payload, questionForHistory) {
    requestId = `req_${Date.now()}`
    historyQuestion = questionForHistory
    streaming.value = true
    window.overlayApi.runOpenAiRequest({
      requestId,
      apiKey,
      conversationHistory: JSON.parse(JSON.stringify(history.value)),
      ...payload
    })
  }

  function fail(message) {
    finish()
    error.value = message
  }

  // Cancels the request but keeps whatever text has streamed so far.
  function stop() {
    if (requestId) window.overlayApi.cancelRequest(requestId)
    const wasActive = streaming.value || timer
    finish()
    if (wasActive && !text.value) error.value = 'Stopped.'
  }

  function close() {
    stop()
    visible.value = false
    question.value = ''
    text.value = ''
    error.value = ''
    latency.value = null
    elapsed.value = 0
  }

  function clearHistory() {
    history.value = []
  }

  function onDone({ requestId: id, text: finalText }) {
    if (id !== requestId) return
    finish()
    text.value = finalText || pendingText
    latency.value = ((Date.now() - startTime) / 1000).toFixed(1) + 's'
    if (!text.value) {
      error.value = 'No response received — check your API key or try again.'
      return
    }
    history.value = [
      ...history.value,
      { role: 'user', content: historyQuestion },
      { role: 'assistant', content: text.value }
    ].slice(-HISTORY_MESSAGES)
  }

  function onError({ requestId: id, message }) {
    if (id !== requestId) return
    fail(message || 'Request failed.')
  }

  const unsubscribers = []
  onMounted(() => {
    unsubscribers.push(
      window.overlayApi.onOpenAiDelta(({ requestId: id, text: textSoFar }) => {
        if (id === requestId) scheduleText(textSoFar)
      }),
      window.overlayApi.onOpenAiDone(onDone),
      window.overlayApi.onOpenAiError(onError)
    )
  })
  onUnmounted(() => {
    finish()
    unsubscribers.forEach((unsubscribe) => unsubscribe())
  })

  return { visible, question, text, error, streaming, elapsed, latency, history, begin, send, fail, stop, close, clearHistory }
}
