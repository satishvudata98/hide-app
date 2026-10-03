import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

const { createTranscriptTracker, createRealtimeSession, reconnectDelay, sessionUpdate, capBlockText } =
  createRequire(import.meta.url)('../electron/realtime.js')

const committed = (id) => ({ type: 'input_audio_buffer.committed', item_id: id })
const delta = (id, text) => ({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, delta: text })
const completed = (id, text) => ({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text })
const speechStarted = (ms = 0) => ({ type: 'input_audio_buffer.speech_started', audio_start_ms: ms })
const commitEmpty = { type: 'error', error: { code: 'input_audio_buffer_commit_empty' } }

// A finished segment: VAD saw speech, committed it, transcription completed.
function segment(tracker, id, text) {
  tracker.handleEvent(speechStarted())
  tracker.handleEvent(committed(id))
  tracker.handleEvent(completed(id, text))
}

describe('createTranscriptTracker', () => {
  let tracker
  beforeEach(() => { tracker = createTranscriptTracker() })

  it('assembles the pending block in commit order even when segments complete out of order', () => {
    tracker.handleEvent(committed('a'))
    tracker.handleEvent(committed('b'))
    tracker.handleEvent(completed('b', 'the rest of it?'))
    tracker.handleEvent(completed('a', 'What is a closure,'))
    expect(tracker.pendingText()).toBe('What is a closure, the rest of it?')
  })

  it('shows deltas as a live draft, replaced by the final text', () => {
    tracker.handleEvent(committed('a'))
    tracker.handleEvent(delta('a', 'Wha'))
    expect(tracker.pendingText()).toBe('Wha')
    tracker.handleEvent(completed('a', 'What'))
    expect(tracker.pendingText()).toBe('What')
  })

  it('sends a finished block at once and starts the next block empty', () => {
    segment(tracker, 'a', 'Tell me about yourself.')
    expect(tracker.beginBlock()).toBe(false) // no commit needed
    expect(tracker.blockReady()).toBe(true)
    expect(tracker.finishBlock()).toEqual({ text: 'Tell me about yourself.', segments: 1, complete: true })
    expect(tracker.pendingText()).toBe('')

    segment(tracker, 'b', 'Why this company?')
    expect(tracker.finishBlock().text).toBe('Why this company?')
  })

  it('waits for the last segment when it is committed but not transcribed yet', () => {
    segment(tracker, 'a', 'How does')
    tracker.handleEvent(speechStarted())
    tracker.handleEvent(committed('b'))
    tracker.beginBlock()
    expect(tracker.blockReady()).toBe(false)
    tracker.handleEvent(completed('b', 'the event loop work?'))
    expect(tracker.blockReady()).toBe(true)
    expect(tracker.finishBlock().text).toBe('How does the event loop work?')
  })

  it('asks for a commit when speech is still open and ends the block at that commit', () => {
    tracker.handleEvent(speechStarted())
    expect(tracker.beginBlock()).toBe(true)
    expect(tracker.blockReady()).toBe(false)
    tracker.handleEvent(committed('a'))
    tracker.handleEvent(speechStarted()) // the interviewer keeps talking after the press
    tracker.handleEvent(committed('b'))
    tracker.handleEvent(completed('a', 'Explain promises'))
    expect(tracker.blockReady()).toBe(true)
    expect(tracker.finishBlock().text).toBe('Explain promises')

    tracker.handleEvent(completed('b', 'and async await.'))
    expect(tracker.pendingText()).toBe('and async await.') // goes to the next block
  })

  it('drops the short leftover VAD segment after a mid-speech commit, keeps real continued speech', () => {
    const stopped = (endMs) => ({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: endMs })
    tracker.handleEvent(speechStarted(30_000))
    tracker.beginBlock()
    tracker.markForcedCommit(37_300) // pressed right as the interviewer stopped
    tracker.handleEvent(committed('a'))
    tracker.handleEvent(stopped(37_472)) // VAD notices the end 172ms later…
    tracker.handleEvent(committed('tail')) // …and commits the silent tail
    tracker.handleEvent(completed('tail', 'We are looking for a software engineer'))
    tracker.handleEvent(completed('a', 'When would a watcher be the wrong choice?'))
    expect(tracker.finishBlock().text).toBe('When would a watcher be the wrong choice?')
    expect(tracker.pendingText()).toBe('')

    tracker.handleEvent(speechStarted(50_000))
    tracker.beginBlock()
    tracker.markForcedCommit(51_000) // pressed mid-sentence
    tracker.handleEvent(committed('b'))
    tracker.handleEvent(stopped(53_000)) // the interviewer kept talking for 2s
    tracker.handleEvent(committed('c'))
    tracker.handleEvent(completed('b', 'Explain promises'))
    tracker.handleEvent(completed('c', 'and async await.'))
    tracker.finishBlock()
    expect(tracker.pendingText()).toBe('and async await.')
  })

  it('ends the block when the forced commit finds the buffer already committed by VAD', () => {
    tracker.handleEvent(speechStarted())
    tracker.beginBlock()
    tracker.handleEvent(committed('a')) // VAD's commit was in flight
    tracker.handleEvent(commitEmpty) // then our commit found nothing
    tracker.handleEvent(completed('a', 'done'))
    expect(tracker.blockReady()).toBe(true)
    expect(tracker.finishBlock().text).toBe('done')
  })

  it('returns partial text when a segment never finished', () => {
    tracker.handleEvent(committed('a'))
    tracker.handleEvent(delta('a', 'half a sen'))
    tracker.beginBlock()
    expect(tracker.finishBlock()).toEqual({ text: 'half a sen', segments: 1, complete: false })
  })

  it('discards the pending block on reset, including commits in flight before the clear', () => {
    segment(tracker, 'a', 'small talk')
    tracker.handleEvent(speechStarted())
    tracker.resetBlock()
    tracker.handleEvent(committed('b')) // committed before the server processed the clear
    tracker.handleEvent(completed('b', 'more small talk'))
    tracker.handleEvent({ type: 'input_audio_buffer.cleared' })
    expect(tracker.pendingText()).toBe('')

    segment(tracker, 'c', 'First question?')
    expect(tracker.pendingText()).toBe('First question?')
  })

  it('ignores events for segments that were already sent', () => {
    tracker.handleEvent(committed('a'))
    tracker.beginBlock()
    tracker.finishBlock() // timed out before completion
    expect(tracker.handleEvent(completed('a', 'late'))).toBe(false)
    expect(tracker.pendingText()).toBe('')
  })

  it('reports where to replay audio from and drops unfinished segments after a disconnect', () => {
    segment(tracker, 'a', 'kept')
    tracker.handleEvent(speechStarted(4000))
    tracker.handleEvent(committed('b'))
    tracker.handleEvent(speechStarted(6000))
    expect(tracker.replayStartMs()).toBe(4000)
    tracker.dropUnfinished()
    expect(tracker.pendingText()).toBe('kept')
    expect(tracker.isSpeaking()).toBe(false)
    expect(tracker.replayStartMs()).toBeNull()
  })

  it('is idle only with no open speech, no unfinished segment and no send waiting', () => {
    expect(tracker.isIdle()).toBe(true)
    tracker.handleEvent(speechStarted())
    expect(tracker.isIdle()).toBe(false)
    tracker.handleEvent(committed('a'))
    expect(tracker.isIdle()).toBe(false)
    tracker.handleEvent(completed('a', 'x'))
    expect(tracker.isIdle()).toBe(true)
  })
})

describe('helpers', () => {
  it('backs off 0.5s, 1s, 2s, then 5s', () => {
    expect([0, 1, 2, 3, 9].map(reconnectDelay)).toEqual([500, 1000, 2000, 5000, 5000])
  })

  it('configures server VAD and the transcription model', () => {
    const { input } = sessionUpdate({ vadSilenceMs: 300 }).session.audio
    expect(input.turn_detection).toMatchObject({ type: 'server_vad', silence_duration_ms: 300 })
    expect(input.transcription).toEqual({ model: 'gpt-4o-transcribe', language: 'en' })
  })

  it('keeps the end of an over-long block from a word boundary', () => {
    const text = 'word '.repeat(2000).trim()
    const capped = capBlockText(text)
    expect(capped.length).toBeLessThanOrEqual(6000)
    expect(capped.startsWith('word')).toBe(true)
  })
})

// Minimal stand-in for the ws client.
class FakeSocket extends EventEmitter {
  static OPEN = 1
  static instances = []
  constructor() {
    super()
    this.readyState = 0
    this.sent = []
    FakeSocket.instances.push(this)
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
  open() { this.readyState = 1; this.emit('open') }
  event(message) { this.emit('message', Buffer.from(JSON.stringify(message))) }
  drop() { this.readyState = 3; this.emit('close') }
  appended() { return this.sent.filter((m) => m.type === 'input_audio_buffer.append') }
}

describe('createRealtimeSession', () => {
  const pcm = (ms) => new Uint8Array(ms * 48).buffer // 24kHz PCM16
  let emitted, session
  const last = () => FakeSocket.instances.at(-1)

  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.instances = []
    emitted = []
    session = createRealtimeSession((channel, payload) => emitted.push({ channel, payload }), { WebSocketImpl: FakeSocket })
  })
  afterEach(() => {
    session.close()
    vi.useRealTimers()
  })

  it('queues audio while connecting and sends it after the session update', () => {
    session.start('sk-test', { vadSilenceMs: 300 })
    session.appendAudio(pcm(100))
    last().open()
    expect(last().sent.map((m) => m.type)).toEqual(['session.update', 'input_audio_buffer.append'])
  })

  const commits = () => last().sent.filter((m) => m.type === 'input_audio_buffer.commit')

  it('lets VAD close speech that just ended instead of racing it with a commit', async () => {
    session.start('sk-test', { vadSilenceMs: 300 })
    last().open()
    last().event(speechStarted())
    const block = session.takeBlock()
    vi.advanceTimersByTime(200)
    last().event(committed('a')) // VAD's own commit, inside the grace period
    last().event(completed('a', 'What is Pinia?'))
    vi.advanceTimersByTime(500)
    await expect(block).resolves.toMatchObject({ text: 'What is Pinia?', degraded: false })
    expect(commits()).toHaveLength(0)
  })

  it('commits itself when the interviewer is still talking after the grace period', async () => {
    session.start('sk-test', { vadSilenceMs: 300 })
    last().open()
    last().event(speechStarted())
    const block = session.takeBlock()
    vi.advanceTimersByTime(449)
    expect(commits()).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(commits()).toHaveLength(1)
    last().event(committed('a'))
    last().event(completed('a', 'Explain closures and'))
    await expect(block).resolves.toMatchObject({ text: 'Explain closures and', degraded: false })
  })

  it('treats a block whose segment never finished as degraded and replaces the socket', async () => {
    session.start('sk-test')
    const first = last()
    first.open()
    first.event(committed('a'))
    first.event(delta('a', 'partial'))
    const block = session.takeBlock()
    vi.advanceTimersByTime(2500)
    await expect(block).resolves.toMatchObject({ text: 'partial', complete: false, degraded: true })
    vi.advanceTimersByTime(10)
    expect(last()).not.toBe(first)
  })

  it('reconnects and replays audio when a transcript never arrives', () => {
    session.start('sk-test')
    const first = last()
    first.open()
    for (let i = 0; i < 20; i++) session.appendAudio(pcm(100))
    first.event(speechStarted(1000))
    first.event(committed('a')) // …and then the server goes silent
    vi.advanceTimersByTime(7500)
    const second = last()
    expect(second).not.toBe(first)
    second.open()
    expect(second.appended().length).toBeGreaterThan(0) // speech from 700ms on is replayed
  })

  it('marks a send as degraded when the socket is down', async () => {
    session.start('sk-test')
    await expect(session.takeBlock()).resolves.toMatchObject({ degraded: true })
  })

  it('reconnects with backoff, keeps finished text and replays unfinished speech', () => {
    session.start('sk-test')
    const first = last()
    first.open()
    for (let i = 0; i < 10; i++) session.appendAudio(pcm(100)) // 0–1000ms
    first.event(speechStarted(0))
    first.event(committed('a'))
    first.event(completed('a', 'Kept segment.'))
    first.event(speechStarted(600)) // open speech from 600ms, never committed
    first.drop()

    session.appendAudio(pcm(100)) // arrives during the gap: queued
    expect(emitted.at(-1)).toMatchObject({ channel: 'realtime:status', payload: { state: 'reconnecting' } })
    vi.advanceTimersByTime(500)
    const second = last()
    expect(second).not.toBe(first)
    second.open()

    // Replay from 600ms minus 300ms padding = chunks starting at 300..900ms (7), then the queued chunk
    expect(second.appended()).toHaveLength(8)
    const pending = emitted.filter((e) => e.channel === 'realtime:pending').at(-1)
    expect(pending.payload.text).toBe('Kept segment.')
  })

  it('does not replay audio that a send during the reconnect already gave to Whisper', async () => {
    session.start('sk-test')
    const first = last()
    first.open()
    for (let i = 0; i < 20; i++) session.appendAudio(pcm(100))
    first.event(speechStarted(500))
    first.drop() // unfinished speech is queued for replay…
    await expect(session.takeBlock()).resolves.toMatchObject({ degraded: true }) // …but this send covers it
    vi.advanceTimersByTime(500)
    last().open()
    expect(last().appended()).toHaveLength(0)
  })

  it('stops reconnecting on a rejected key', () => {
    session.start('sk-bad')
    last().emit('error', new Error('Unexpected server response: 401'))
    last().drop()
    vi.advanceTimersByTime(10_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(emitted.some((e) => e.channel === 'realtime:error')).toBe(true)
  })

  it('reconnects at once with a new key', () => {
    session.start('sk-one')
    last().open()
    session.start('sk-two')
    vi.advanceTimersByTime(0)
    expect(FakeSocket.instances).toHaveLength(2)
  })
})
