import { ref } from 'vue'
import pcmWorkletUrl from '../audio/pcm-worklet.js?url&no-inline'
import { encodeWav, mergePcmFrames } from '../lib/wav'

export const PCM_SAMPLE_RATE = 24000 // realtime API input rate; also used for the fallback WAV
const MAX_FALLBACK_FRAMES = 120 * 10 // ~2 minutes of 100ms worklet frames

// System audio (loopback, works with earphones) and the mic, opened in
// parallel. Either one alone is enough.
async function openAudioStreams() {
  const [system, mic] = await Promise.allSettled([
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    })
  ])

  const streams = []
  if (system.status === 'fulfilled') {
    // Only the loopback audio is needed; drop the screen video track
    system.value.getVideoTracks().forEach((track) => track.stop())
    if (system.value.getAudioTracks().length) streams.push(system.value)
  } else {
    console.warn('[audio] system audio unavailable:', system.reason?.message)
  }
  if (mic.status === 'fulfilled') streams.push(mic.value)
  else console.warn('[audio] mic unavailable:', mic.reason?.message)

  if (!streams.length) throw mic.reason || system.reason || new Error('No audio source available')
  return streams
}

// Captures audio as mono 24kHz PCM16 frames of 100ms. Each frame is passed to
// onFrame(ArrayBuffer); the last ~2 minutes are kept for a Whisper fallback.
export function useRecorder() {
  const seconds = ref(0)
  let streams = []
  let audioContext = null
  let workletNode = null
  let timer = null
  let frames = []

  async function start(onFrame) {
    frames = []
    seconds.value = 0
    try {
      streams = await openAudioStreams()
      // The context runs at the target rate; Chromium resamples the inputs
      audioContext = new AudioContext({ sampleRate: PCM_SAMPLE_RATE })
      await audioContext.audioWorklet.addModule(pcmWorkletUrl)
      workletNode = new AudioWorkletNode(audioContext, 'pcm-capture', { numberOfOutputs: 0 })
      // All sources feed the same worklet input, which mixes them into one mono stream
      for (const stream of streams) audioContext.createMediaStreamSource(stream).connect(workletNode)

      workletNode.port.onmessage = ({ data }) => {
        frames.push(new Int16Array(data.pcm))
        if (frames.length > MAX_FALLBACK_FRAMES) frames.shift()
        onFrame(data.pcm)
      }
      timer = setInterval(() => seconds.value++, 1000)
    } catch (error) {
      stop()
      throw error
    }
  }

  function stop() {
    clearInterval(timer)
    timer = null
    streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()))
    streams = []
    if (workletNode) {
      workletNode.port.onmessage = null
      workletNode.disconnect()
      workletNode = null
    }
    audioContext?.close().catch(() => {})
    audioContext = null
  }

  function clearBuffer() {
    frames = []
  }

  function takeFallbackWav() {
    return frames.length ? encodeWav(mergePcmFrames(frames), PCM_SAMPLE_RATE) : null
  }

  return { seconds, start, stop, clearBuffer, takeFallbackWav }
}
