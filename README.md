# Screnshield

A personal Windows overlay that answers interview questions. It listens to system audio and the mic, transcribes live with the OpenAI Realtime API, and streams an answer from an OpenAI chat model. It uses your `resume.txt` and `jd.txt` as context. It can also answer from pasted text or a screenshot.

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

| Action | Button | Hotkey |
|---|---|---|
| Start recording | `rec` | `Ctrl+Shift+Space` |
| Stop recording and answer | `rec` (while recording) / `answer question` | `Ctrl+Shift+Enter` |
| Discard the current recording | | `Ctrl+Shift+Space` (while recording) |
| Answer what's on screen | `analyze screen` | `Ctrl+Shift+S` |
| Type or paste a question | `paste text`, then `Ctrl+Enter` | |
| Stop a streaming answer | `■` in the answer header | |
| Rework the last answer | `shorter` / `with code` / `simpler` under it | |
| Settings | `⚙` | |
| Show / hide overlay | | `Ctrl+Shift+O` |
| Click-through on/off | | `Ctrl+Shift+X` |
| Opacity up / down | | `Ctrl+Shift+Up` / `Down` |

Follow-up questions include the last two exchanges. `⊘` clears that history. While recording, the bar next to the seconds shows the input level. If it doesn't move when someone speaks, the wrong mic is selected.

Hotkeys are defined in `SHORTCUTS` in [electron/window.js](electron/window.js).

**Settings (`⚙`):**
- **mic**: defaults to the Windows default input. Pick a specific one if a plugged-in headset jack makes Windows switch to a silent "Headset Microphone".
- **system audio**: on or off.
- **model**: answer model, default `gpt-4o`.
- **answers**: `brief` or `detailed`.

Everything is stored in the settings file together with `apiKey`.

## Build an exe

```powershell
.\build.ps1              # dist\win-unpacked\Screnshield.exe
.\build.ps1 -Portable    # dist\Screnshield-<version>-x64-portable.exe
.\build.ps1 -Installer   # NSIS installer
```

`build.ps1` runs `vite build` before packaging, so the exe never ships a stale UI.

## Tests

```powershell
npm test
```

These are unit tests for the pure logic: SSE parsing, realtime transcript assembly, WAV encoding and prompt building.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it fits together.
