# Screnshield

A personal Windows overlay that answers interview questions. It listens to the interviewer (system audio) all the time, transcribes live with the OpenAI Realtime API, and when you press one hotkey it streams an answer to everything said since your last answer. It uses your `resume.txt` and `jd.txt` as context and keeps the conversation, so follow-ups, hints and pushback get answered in context. It can also answer from pasted text or a screenshot.

Electron + Vue 3 + Vite. Windows 10 (2004+) / Windows 11.

## Setup

```powershell
npm install
npm run build
npm start
```

On first run, paste your OpenAI API key into the key field. It's saved to `%APPDATA%\Screnshield\screnshield-settings.json`. You can also set `VITE_OPENAI_API_KEY` in `.env` before building.

Put `jd.txt` (job description) and `resume.txt` next to the app: the project folder in dev, the exe's folder when packaged. The status line tells you if either is missing. Edits are picked up on the next question.

**Dev with hot reload:** run `npm run dev` in one terminal and `npm run start:dev` in another. Close any running Screnshield first, because an old process keeps serving old code.

**`app.whenReady` is undefined?** VS Code terminals set `ELECTRON_RUN_AS_NODE`. Run `Remove-Item Env:ELECTRON_RUN_AS_NODE` first.

## Using it

Listening starts when the app opens. The strip under the bar shows what has been heard since your last answer: that's exactly what the next answer is based on.

| Action | Button | Hotkey |
|---|---|---|
| Answer everything heard since the last answer | `answer question` | `Ctrl+Shift+Enter` |
| Pause / resume listening | `live` pill | `Ctrl+Shift+Space` |
| Discard what was heard (small talk) | `↺` | |
| Answer what's on screen | `analyze screen` | `Ctrl+Shift+S` |
| Type or paste a question | `paste text`, then `Ctrl+Enter` | |
| Stop a streaming answer | `■` in the answer header | |
| Shorter / deeper / with code | chips under the answer | `Ctrl+Shift+1` / `2` / `3` |
| Ask the same question again | `↻ again` | `Ctrl+Shift+R` |
| Settings | `⚙` | |
| Show / hide overlay | | `Ctrl+Shift+O` |
| Click-through on/off | | `Ctrl+Shift+X` |
| Opacity up / down | | `Ctrl+Shift+Up` / `Down` |

Pressing answer while an answer is still streaming replaces it with an answer to the new question. The answer starts with a **Say** line you can say right away; the bullets are for the follow-up. Amber text like `notice period` is a fact the model doesn't know: say your own. If the interviewer hasn't asked anything yet, the answer is "No question yet", and what was heard is kept for the next press. `⊘` clears the conversation.

The `live` pill turns amber while the live transcript reconnects; answers then fall back to Whisper on the recorded audio, so nothing is lost. If gpt-4o is rate-limited or slow to start, the answer comes from `gpt-4o-mini` and the header says so.

Hotkeys are defined in `SHORTCUTS` in [electron/window.js](electron/window.js).

**Settings (`⚙`):**
- **system audio**: what the interviewer says through your speakers/earphones. On by default.
- **mic too**: only for in-person or phone interviews (it also hears you), with a mic picker.
- **pause**: the silence that ends a phrase (300ms default).
- **auto listen**: start listening when the app opens.
- **model**: answer model, default `gpt-4o`.
- **answers**: `brief` or `detailed`.

Everything is stored in the settings file together with `apiKey`. `fallbackModel` (default `gpt-4o-mini`, `""` to turn off) is only in the file.

## Build an exe

```powershell
.\build.ps1              # dist\win-unpacked\Screnshield.exe
.\build.ps1 -Portable    # dist\Screnshield-<version>-x64-portable.exe
.\build.ps1 -Installer   # NSIS installer
```

`build.ps1` runs `vite build` before packaging, so the exe never ships a stale UI.

## Tests and measurements

```powershell
npm test                                   # unit tests for the pure logic
npm run report                             # P50/P95 latency per stage from your real answers
node scripts/make-mock-audio.js            # mock interview audio via TTS (scripts/out/)
node scripts/replay.js scripts/out/mock-interview.wav --answer   # stream it through the real pipeline
node scripts/eval-answers.js               # grade answers on 34 interview situations
```

Every answer writes one numbers-only line (no transcript text) to `%APPDATA%\Screnshield\traces.jsonl`. The replay and eval scripts use the key from `.env` and cost a few cents per run.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it fits together.
