# Architecture

Two processes. They only talk through the IPC bridge in `preload.js` (`window.overlayApi`).

```
Renderer (Vue)                          Main (Node / Electron)
──────────────                          ──────────────────────
useRecorder ── PCM frames (always) ───▶ realtime.js ──WebSocket──▶ OpenAI Realtime (gpt-4o-transcribe, server VAD)
   ▲  AudioWorklet (24kHz mono PCM16)       │ rolling segment log + send cursor
   │                                        ▼
WorkspaceScreen ◀── realtime:pending / status ──┘
   │  send → realtime:take-block (everything since the last send)
   ▼
useAnswer ── openai:run ──────────────▶ ipc.js → conversation.js + prompts.js → openai.js ──SSE──▶ Chat Completions
   ▲                                                                       │  (fallback model on 429/5xx/silence)
   └──────────── openai:delta (new text only) / done / error ◀─────────────┘
```

## Main process

| File | Responsibility |
|---|---|
| `main.js` | App lifecycle; wires the modules together |
| `electron/window.js` | Overlay window, global hotkeys, opacity, click-through, fit-to-content height |
| `electron/ipc.js` | Every IPC handler; runs answer requests (fallback model, cancellation) and owns the conversation |
| `electron/conversation.js` | The interview so far, rebuilt into history messages per request (pure) |
| `electron/prompts.js` | System prompt and request bodies (pure) |
| `electron/openai.js` | Streaming chat request (timeouts, rate-limit-aware retry) and the Whisper fallback |
| `electron/sse.js` | SSE parsing (pure) |
| `electron/realtime.js` | Always-on Realtime session (reconnect, replay, watchdog) and the transcript tracker (pure) |
| `electron/trace.js` | Per-answer latency records and percentiles (pure) |
| `electron/capture.js` | Media permissions, loopback audio, screenshots |
| `electron/context.js` | Loads `jd.txt` / `resume.txt`, cached by modification time |
| `electron/settings.js` | JSON settings file in `userData` |
| `electron/errors.js` | One-line messages for HTTP, network and socket failures (pure) |

## Renderer

| File | Responsibility |
|---|---|
| `components/WorkspaceScreen.vue` | Listening state, the answer flows (send block, screenshot, paste, follow-ups, regenerate) |
| `components/MainBar.vue`, `PastePanel.vue`, `SettingsPanel.vue`, `AnswerPanel.vue` | Presentational pieces |
| `composables/useRecorder.js` | Always-on capture of system audio (mic optional); keeps ~2 min so a send can fall back to Whisper |
| `composables/useAnswer.js` | One streamed answer: request id, text (rendered at most once per frame), timing, trace, regenerate |
| `audio/pcm-worklet.js` | Audio-thread mixer: mono, PCM16, 100ms frames |
| `lib/markdown.js`, `lib/wav.js` | Sanitized markdown (Say line, placeholders) + highlighting; WAV encoding |

## State

`listen` (`off` / `starting` / `on` / `paused`) is the capture, independent of answering. `phase` (`idle` / `finalizing` / `transcribing` / `capturing`) covers everything before an answer streams; the stream itself is `answer.streaming`. A new send is allowed while an answer streams: it cancels that answer.

## Key flows

**Always-on transcription.** Server VAD commits a segment at every pause (300ms by default). The tracker keeps segments in commit order, keyed by `item_id`, and a cursor marks what was already sent. Everything after the cursor is the pending block, shown live in the bar.

**Send.** `takeBlock()` ends the block at the press. If the interviewer is mid-phrase, VAD gets its silence window + 150ms to commit on its own; only then do we commit (in replay tests, our commit racing VAD's could hang the server with no error). The short leftover VAD segment after our mid-speech commit is dropped, because transcribing it produced invented text. The block's segments get up to 2s for their final text; later speech belongs to the next block.

**Recovery.** The socket reconnects with backoff (0.5 / 1 / 2 / 5s). Audio of unfinished speech is replayed from a 60s log, so nothing is lost. A watchdog replaces a socket whose transcript hasn't arrived after 4s, and sessions rotate in a quiet moment after 25 minutes. A block that is incomplete, or taken while reconnecting, is `degraded`: the renderer sends the audio since the last send to Whisper, and that audio is never replayed into the next block.

**Answer requests.** The system message (rules + JD + resume, ~2k tokens) is a fixed prefix that OpenAI caches. After it: a one-line-per-exchange summary of the earlier interview, the last 4 exchanges in full (code only in the latest), then the new turn marked as live transcript, typed question or the candidate's own request. A turn answered with `…` (no question yet) is carried into the next one. The request has a 12s header timeout, an 8s first-token timeout and a 20s idle timeout. A 429 is retried after the wait OpenAI suggests if that's under 3s. A retryable failure (rate limit, 5xx, network, no first token) goes once to `gpt-4o-mini`. Only new text crosses IPC.

**Screenshots.** The display under the cursor, at native aspect ratio, long side ≤ 2048px, sent as JPEG.

## Measuring

`traces.jsonl` gets one line per answer: ms from the press to block ready, request sent, first token, first render and done, plus model, fallback, attempts and cached tokens. `npm run report` prints the percentiles. `scripts/replay.js` streams a recorded interview through the real session in real time and reports block latency, WER and Whisper fallbacks. `scripts/eval-answers.js` grades answers on fixed interview situations with a judge model.
