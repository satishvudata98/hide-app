import { ref, onMounted, onUnmounted } from 'vue'

// One streamed answer at a time: request lifecycle, streamed text and timing.
// The conversation itself lives in the main process; exchangeCount only
// drives the UI (follow-up buttons, clear-session).
export function useAnswer() {
  const visible = ref(false)
  const question = ref('') // shown above the answer
  const text = ref('')
  const error = ref('')
  const streaming = ref(false)
  const elapsed = ref(0)
  const latency = ref(null)
  const exchangeCount = ref(0)

  let requestId = null
  let startTime = 0
  let timer = null
  let pendingText = ''
  let renderFrame = null
  let trace = null // timestamps for the current answer, written to traces.jsonl when it ends
  let last = null // { displayQuestion, payload, completedId }: the latest request, for regenerate

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
      if (trace && !trace.firstRenderAt) trace.firstRenderAt = Date.now()
    })
  }

  function finish() {
    requestId = null
    streaming.value = false
    cancelRender()
    stopTimer()
  }

  // Opens the panel and starts the clock at `pressedAt` (the hotkey press, so
  // transcription wait counts too). `kind` labels the trace: audio/paste/screen/follow-up.
  function begin(displayQuestion, { pressedAt = Date.now(), kind = 'text' } = {}) {
    if (requestId) window.overlayApi.cancelRequest(requestId) // a new question replaces an answer still streaming
    finish()
    visible.value = true
    question.value = displayQuestion
    text.value = ''
    pendingText = ''
    error.value = ''
    latency.value = null
    elapsed.value = 0
    startTime = pressedAt
    trace = { kind, pressedAt }
    timer = setInterval(() => { elapsed.value = Math.round((Date.now() - startTime) / 1000) }, 500)
  }

  // payload: { question, turnKind: 'interviewer' | 'pasted' | 'request' } or { imageBase64, imageType }
  function send(apiKey, payload) {
    requestId = `req_${Date.now()}`
    streaming.value = true
    last = { displayQuestion: question.value, payload, completedId: null }
    if (trace) Object.assign(trace, { blockReadyAt: Date.now(), blockChars: payload.question?.length ?? 0 })
    window.overlayApi.runOpenAiRequest({ requestId, apiKey, ...payload })
  }

  // Asks the latest question again. A completed answer is replaced in the
  // conversation; one still streaming or failed is simply retried.
  function regenerate(apiKey) {
    if (!last) return false
    const { displayQuestion, payload, completedId } = last
    begin(displayQuestion, { kind: 'regenerate' })
    send(apiKey, { ...payload, replaces: completedId })
    return true
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
    exchangeCount.value = 0
    window.overlayApi.clearConversation()
  }

  function writeTrace(ok, timing, message) {
    if (!trace) return
    window.overlayApi.writeTrace({ ...trace, ok, error: message, timing })
    trace = null
  }

  function onDone({ requestId: id, text: finalText, timing, exchanges }) {
    if (id !== requestId) return
    if (last) last.completedId = id
    finish()
    text.value = finalText || pendingText
    const doneAt = Date.now()
    if (trace && !trace.firstRenderAt && text.value) trace.firstRenderAt = doneAt
    const seconds = (at) => ((at - startTime) / 1000).toFixed(1) + 's'
    latency.value = (trace?.firstRenderAt
      ? `first words ${seconds(trace.firstRenderAt)} · done ${seconds(doneAt)}`
      : seconds(doneAt)) + (timing?.fallback ? ` · ${timing.model}` : '')
    writeTrace(!!text.value, timing, text.value ? undefined : 'empty response')
    if (!text.value) {
      error.value = 'No response received — check your API key or try again.'
      return
    }
    exchangeCount.value = exchanges ?? exchangeCount.value + 1
  }

  function onError({ requestId: id, message, timing }) {
    if (id !== requestId) return
    writeTrace(false, timing, message || 'Request failed.')
    fail(message || 'Request failed.')
  }

  const unsubscribers = []
  onMounted(() => {
    unsubscribers.push(
      window.overlayApi.onOpenAiDelta(({ requestId: id, delta }) => {
        if (id === requestId) scheduleText(pendingText + delta)
      }),
      window.overlayApi.onOpenAiDone(onDone),
      window.overlayApi.onOpenAiError(onError)
    )
  })
  onUnmounted(() => {
    finish()
    unsubscribers.forEach((unsubscribe) => unsubscribe())
  })

  return { visible, question, text, error, streaming, elapsed, latency, exchangeCount, begin, send, regenerate, fail, stop, close, clearHistory }
}
