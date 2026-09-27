// Joins Int16Array PCM frames into one contiguous Int16Array.
export function mergePcmFrames(frames) {
  let total = 0
  for (const frame of frames) total += frame.length
  const merged = new Int16Array(total)
  let offset = 0
  for (const frame of frames) {
    merged.set(frame, offset)
    offset += frame.length
  }
  return merged
}

// Wraps mono 16-bit PCM samples in a WAV (RIFF) container.
export function encodeWav(pcm16, sampleRate) {
  const buffer = new ArrayBuffer(44 + pcm16.byteLength)
  const view = new DataView(buffer)
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + pcm16.byteLength, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, pcm16.byteLength, true)
  new Int16Array(buffer, 44).set(pcm16)
  return buffer
}
