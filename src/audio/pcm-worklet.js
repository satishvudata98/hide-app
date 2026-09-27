// Runs on the audio thread. Mixes every connected input down to mono, converts
// to 16-bit PCM and posts ~100ms frames: { pcm: ArrayBuffer, level: 0..1 (RMS) }.
// The AudioContext runs at 24kHz, so frames are already in the format the
// realtime transcription API expects.
const FRAME_MS = 100

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frameSize = Math.round((sampleRate * FRAME_MS) / 1000)
    this.resetFrame()
  }

  resetFrame() {
    this.frame = new Int16Array(this.frameSize)
    this.offset = 0
    this.sumSquares = 0
  }

  process(inputs) {
    const channels = inputs[0]
    if (!channels || channels.length === 0) return true

    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0
      for (const channel of channels) sample += channel[i]
      sample = Math.max(-1, Math.min(1, sample / channels.length))
      this.sumSquares += sample * sample
      this.frame[this.offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      if (this.offset === this.frameSize) this.flush()
    }
    return true
  }

  flush() {
    const pcm = this.frame.buffer
    const level = Math.sqrt(this.sumSquares / this.frameSize)
    this.port.postMessage({ pcm, level }, [pcm])
    this.resetFrame()
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
