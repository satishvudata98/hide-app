import { describe, it, expect, beforeEach } from 'vitest'
import { createRequire } from 'node:module'

const { createTranscriptTracker } = createRequire(import.meta.url)('../electron/realtime.js')

const committed = (id) => ({ type: 'input_audio_buffer.committed', item_id: id })
const delta = (id, text) => ({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, delta: text })
const completed = (id, text) => ({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text })
const speechStarted = { type: 'input_audio_buffer.speech_started' }

describe('createTranscriptTracker', () => {
  let tracker
  beforeEach(() => { tracker = createTranscriptTracker() })

  it('assembles segments in commit order even when they complete out of order', () => {
    tracker.handleEvent(committed('a'))
    tracker.handleEvent(committed('b'))
    tracker.handleEvent(completed('b', 'the rest of it?'))
    expect(tracker.hasPending()).toBe(true)
    tracker.handleEvent(completed('a', 'What is a closure,'))
    expect(tracker.hasPending()).toBe(false)
    expect(tracker.transcript()).toBe('What is a closure, the rest of it?')
  })

  it('shows deltas as a live draft, replaced by the final text', () => {
    tracker.handleEvent(committed('a'))
    expect(tracker.handleEvent(delta('a', 'Wha'))).toEqual({ kind: 'delta', text: 'Wha' })
    expect(tracker.handleEvent(completed('a', 'What'))).toEqual({ kind: 'completed', text: 'What' })
  })

  it('has nothing pending once VAD committed and transcription finished', () => {
    tracker.handleEvent(speechStarted)
    tracker.noteAudioAppended()
    tracker.handleEvent(committed('a'))
    tracker.handleEvent(completed('a', 'done'))
    expect(tracker.shouldCommitOnStop()).toBe(false)
    expect(tracker.hasPending()).toBe(false)
  })

  it('asks for a commit when speech is still open, then waits for it', () => {
    tracker.handleEvent(speechStarted)
    expect(tracker.shouldCommitOnStop()).toBe(true)
    tracker.markCommitSent()
    expect(tracker.hasPending()).toBe(true)
    tracker.handleEvent(committed('a'))
    tracker.handleEvent(completed('a', 'tail'))
    expect(tracker.hasPending()).toBe(false)
  })

  it('asks for a commit when VAD never reported but audio was sent', () => {
    tracker.noteAudioAppended()
    expect(tracker.shouldCommitOnStop()).toBe(true)
  })

  it('treats an empty-buffer commit error as expected, not as a UI error', () => {
    tracker.markCommitSent()
    const update = tracker.handleEvent({ type: 'error', error: { code: 'input_audio_buffer_commit_empty' } })
    expect(update).toEqual({ kind: 'state' })
    expect(tracker.hasPending()).toBe(false)
  })

  it('ignores leftovers from before a buffer clear', () => {
    tracker.reset({ awaitClear: true })
    expect(tracker.handleEvent(committed('old'))).toBeNull()
    tracker.handleEvent({ type: 'input_audio_buffer.cleared' })
    expect(tracker.handleEvent(completed('old', 'stale'))).toBeNull()
    tracker.handleEvent(committed('new'))
    tracker.handleEvent(completed('new', 'fresh'))
    expect(tracker.transcript()).toBe('fresh')
  })
})
