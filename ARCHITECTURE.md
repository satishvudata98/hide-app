# Architecture

Two processes. They only talk through the IPC bridge in `preload.js` (`window.overlayApi`).

```
Renderer (Vue)                          Main (Node / Electron)
──────────────                          ──────────────────────
useRecorder ── PCM frames ────────────▶ realtime.js ──WebSocket──▶ OpenAI Realtime (gpt-4o-transcribe)
   ▲  AudioWorklet (24kHz mono PCM16)       │ transcript deltas
   │                                        ▼
WorkspaceScreen ◀── realtime:transcript-* ──┘
   │  question / screenshot
   ▼
useAnswer ── openai:run ──────────────▶ ipc.js → prompts.js → openai.js ──HTTPS SSE──▶ Chat Completions
   ▲                                                         │
   └──────────── openai:delta / done / error ◀───────────────┘
```

## Main process

| File | Responsibility |
|---|---|
| `main.js` | App lifecycle; wires the modules together |
| `electron/window.js` | Overlay window, global hotkeys, opacity, click-through, fit-to-content height |
| `electron/ipc.js` | Every IPC handler; runs answer requests and tracks them for cancellation |
| `electron/prompts.js` | System prompt and request bodies (pure) |
| `electron/openai.js` | Streaming chat request (timeouts, one retry) and the Whisper fallback |
| `electron/sse.js` | SSE parsing (pure) |
| `electron/realtime.js` | Realtime WebSocket session and the transcript tracker (pure) |
| `electron/capture.js` | Media permissions, loopback audio, screenshots |
| `electron/context.js` | Loads `jd.txt` / `resume.txt`, cached by modification time |
| `electron/settings.js` | JSON settings file in `userData` |
| `electron/errors.js` | One-line messages for HTTP, network and socket failures (pure) |

## Renderer

| File | Responsibility |
|---|---|
| `components/WorkspaceScreen.vue` | The state machine and the flows (record → answer, screenshot, paste) |
| `components/MainBar.vue`, `PastePanel.vue`, `SettingsPanel.vue`, `AnswerPanel.vue` | Presentational pieces |
| `composables/useRecorder.js` | Opens system audio and mic, runs the worklet, keeps ~2 min for the fallback |
| `composables/useAnswer.js` | One streamed answer: request id, text (rendered at most once per frame), timing, history |
| `audio/pcm-worklet.js` | Audio-thread mixer: mono, PCM16, 100ms frames |
| `lib/markdown.js`, `lib/wav.js` | Sanitized markdown + highlighting; WAV encoding |

## State machine

`phase` in `WorkspaceScreen` covers everything before an answer streams. The stream itself is `answer.streaming`.

```
idle ──rec──▶ recording ──answer──▶ finalizing ──transcript──────────────▶ (answer streams) ──▶ idle
                  │                     └──no transcript──▶ transcribing (Whisper) ──▶ (answer streams)
                  └──discard──▶ idle
idle ──analyze screen──▶ capturing ──▶ (answer streams) ──▶ idle
```

While any phase other than `idle`/`recording` is active, or an answer is streaming, the actions are disabled. That rules out overlapping flows.

## Key flows

**Live transcription.** The WebSocket stays open between recordings. Starting a new recording sends `input_audio_buffer.clear` and ignores events until `input_audio_buffer.cleared` arrives, so leftovers can't leak into the next question. Server VAD commits segments as the speaker pauses. The tracker keys segments by `item_id` and joins them in commit order.

**Stopping.** `realtime.stop()` commits only if speech is still open. It resolves as soon as every committed segment has its final text, or after 3s at most. If there's no transcript, the renderer sends the retained audio to Whisper.

**Answer requests.** The system message is prompt + JD + resume, a stable prefix that OpenAI can cache. It's followed by the last 2 exchanges and the question (or the screenshot). The request has a 30s timeout for headers and a 20s idle timeout between chunks. It retries once on 429/5xx/network errors before anything has streamed. Deltas carry the full text so far.

**Screenshots.** The display under the cursor, at native aspect ratio, long side ≤ 2048px, sent as JPEG.
