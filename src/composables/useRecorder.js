import { ref } from 'vue'
import pcmWorkletUrl from '../audio/pcm-worklet.js?url&no-inline'
import { encodeWav, mergePcmFrames } from '../lib/wav'

export const PCM_SAMPLE_RATE = 24000 // realtime API input rate; also used for the fallback WAV
const MAX_FALLBACK_FRAMES = 120 * 10 // ~2 minutes of 100ms worklet frames

// System audio (loopback: what the interviewer says, even through earphones)
// and optionally the mic, opened in parallel. An unavailable saved mic falls
// back to the default one (deviceId is a preference, not a requirement).
async function openAudioStreams({ micDeviceId = '', systemAudio = true, includeMic = false }) {
  if (!systemAudio && !includeMic) throw new Error('System audio and mic are both turned off in settings')

  const [system, mic] = await Promise.allSettled([
    systemAudio
      ? navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      : Promise.reject(new Error('system audio turned off in settings')),
    includeMic
      ? navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micDeviceId || undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      })
      : Promise.reject(new Error('mic turned off in settings'))
  ])

  const streams = []
  if (system.status === 'fulfilled') {
    // Only the loopback audio is needed; drop the screen video track
    system.value.getVideoTracks().forEach((track) => track.stop())
    if (system.value.getAudioTracks().length) streams.push(system.value)
  } else if (systemAudio) {
    console.warn('[audio] system audio unavailable:', system.reason?.message)
  }
  if (mic.status === 'fulfilled') streams.push(mic.value)
  else if (includeMic) console.warn('[audio] mic unavailable:', mic.reason?.message)

  if (!streams.length) throw system.reason || mic.reason || new Error('No audio source available')
  return streams
}

// Always-on capture as mono 24kHz PCM16 frames of 100ms. Each frame is passed
// to onFrame(ArrayBuffer). The last ~2 minutes are kept so the audio since the
// last send can go to Whisper when the live transcript is unavailable.
// `level` (0..1) follows the input loudness. onInterrupted() is called if a
// source ends by itself (device unplugged, display change).
export function useRecorder() {
  const level = ref(0)
  let streams = []
  let audioContext = null
  let workletNode = null
  let frames = []
  let frameCount = 0 // frames received since start; frames[] holds the newest of them
  let sentAt = 0 // frameCount at the last send

  async function start(onFrame, { onInterrupted, ...options } = {}) {
    stop()
    frames = []
    frameCount = 0
    sentAt = 0
    try {
      streams = await openAudioStreams(options)
      // The context runs at the target rate; Chromium resamples the inputs
      audioContext = new AudioContext({ sampleRate: PCM_SAMPLE_RATE })
      await audioContext.audioWorklet.addModule(pcmWorkletUrl)
      workletNode = new AudioWorkletNode(audioContext, 'pcm-capture', { numberOfOutputs: 0 })
      // All sources feed the same worklet input, which mixes them into one mono stream
      for (const stream of streams) audioContext.createMediaStreamSource(stream).connect(workletNode)
      for (const track of streams.flatMap((stream) => stream.getAudioTracks())) {
        track.addEventListener('ended', () => onInterrupted?.(), { once: true })
      }

      workletNode.port.onmessage = ({ data }) => {
        frames.push(new Int16Array(data.pcm))
        frameCount++
        if (frames.length > MAX_FALLBACK_FRAMES) frames.shift()
        // Speech RMS is roughly 0.02–0.3; sqrt spreads that across the meter. Fall back slowly.
        level.value = Math.max(Math.min(1, Math.sqrt(data.level) * 1.6), level.value * 0.6)
        onFrame(data.pcm)
      }
    } catch (error) {
      stop()
      throw error
    }
  }

  function stop() {
    level.value = 0
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

  // Marks a send. Returns a function that encodes the audio since the previous
  // send (at most the retained ~2 minutes) as a WAV, or null when there is none.
  // Encoding is deferred because it's only needed when Whisper is the fallback.
  function takeSinceLastSend() {
    const count = Math.min(frameCount - sentAt, frames.length)
    sentAt = frameCount
    const since = count > 0 ? frames.slice(-count) : []
    return () => (since.length ? encodeWav(mergePcmFrames(since), PCM_SAMPLE_RATE) : null)
  }

  return { level, start, stop, takeSinceLastSend }
}
