import { describe, it, expect } from 'vitest'
import { encodeWav, mergePcmFrames } from '../src/lib/wav.js'

const ascii = (view, offset, length) =>
  String.fromCharCode(...new Uint8Array(view.buffer, offset, length))

describe('mergePcmFrames', () => {
  it('concatenates frames in order', () => {
    const merged = mergePcmFrames([new Int16Array([1, 2]), new Int16Array([3])])
    expect(Array.from(merged)).toEqual([1, 2, 3])
  })
})

describe('encodeWav', () => {
  it('writes a mono 16-bit PCM header followed by the samples', () => {
    const samples = new Int16Array([0, 1000, -1000, 32767])
    const view = new DataView(encodeWav(samples, 24000))

    expect(view.byteLength).toBe(44 + samples.byteLength)
    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + samples.byteLength)
    expect(ascii(view, 8, 8)).toBe('WAVEfmt ')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(24000)
    expect(view.getUint32(28, true)).toBe(48000) // byte rate
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(view, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(samples.byteLength)
    expect(Array.from(new Int16Array(view.buffer, 44))).toEqual(Array.from(samples))
  })
})
