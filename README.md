# Windows Capture-Excluded Electron Overlay

This project is a minimal Electron desktop application for Windows that creates a floating overlay window and asks the OS to exclude it from capture pipelines by calling `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`.

## What it does

- Creates a frameless, transparent, always-on-top overlay window
- Keeps the window out of the taskbar
- Uses a 700 x 600 floating UI with a simple parakeet-inspired recording panel
- Makes the header draggable with CSS `-webkit-app-region: drag`
- Prefers `ffi-napi` and `ref-napi` to call `user32.dll` directly
- Tries to exclude the overlay from screen capture on Windows 10 version 2004+ and Windows 11
- Records system loopback audio plus microphone or headset jack input
- Sends audio and prompt together to OpenAI in one request, then renders transcript and response in separate sections
- Supports global shortcuts for show/hide, click-through mode, and opacity

## Install

```powershell
npm install
npm start
```

If PowerShell blocks `npm.ps1`, run `npm.cmd install` and `npm.cmd start` instead.

If Electron starts in Node mode and errors with `app.whenReady` being undefined, clear `ELECTRON_RUN_AS_NODE` before launching:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm start
```

## Notes on native dependencies

- `ffi-napi` and `ref-napi` are optional dependencies so `npm install` can still complete on machines without a full native build toolchain
- When the native modules are available, the app calls `user32!SetWindowDisplayAffinity` directly
- When they are not available, the app falls back to Electron's `win.setContentProtection(true)`, which Electron documents as calling `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` on Windows
- If `ffi-napi` needs to compile locally, you may need Visual Studio with the "Desktop development with C++" workload

## Shortcuts

- `Ctrl+Shift+O`: Show or hide the overlay
- `Ctrl+Shift+X`: Toggle click-through mode
- `Ctrl+Shift+Up`: Increase opacity
- `Ctrl+Shift+Down`: Decrease opacity

## Use the recorder UI

1. Launch the app.
2. Enter your OpenAI API key in the UI.
3. Optionally edit the prompt.
4. Click `Start` to capture system audio plus mic or headset input.
5. Click `Stop` when you are done.
6. Click `Send` to upload the WAV buffer and prompt to OpenAI.
7. Read the transcript and assistant response in the two output panels.

Latency note:

- This build uses a single OpenAI request with the `gpt-audio` model so transcription and reasoning happen together
- For the best response time, keep each recording short

## Build for Windows

The most reliable option is the unpacked app folder:

```powershell
npm run pack
```

That creates:

- `dist\win-unpacked\InvisibleOverlay.exe`

You can double-click that `.exe` directly.

You can also use the included build script:

```powershell
.\build.ps1
```

Optional builds:

```powershell
.\build.ps1 -Portable
npm run dist
```

That tries to create:

- `dist\InvisibleOverlay-1.0.0-x64-portable.exe`

For a normal installer:

```powershell
npm run dist:installer
.\build.ps1 -Installer
```

Notes:

- The app still does not create a task tray icon because no `Tray` is used anywhere in the code
- The overlay window still does not appear in the taskbar because `skipTaskbar: true` is set on the `BrowserWindow`
- On first build, `electron-builder` may download Windows packaging tools such as NSIS
- On some Windows machines, the portable/installer targets can fail if the packaging tools cannot extract symlinks without elevated privileges or Developer Mode enabled
- If that happens, use `npm run pack` or `.\build.ps1` without switches, then run `dist\win-unpacked\InvisibleOverlay.exe`

## How the native window handle works

Electron exposes the native top-level window handle through `win.getNativeWindowHandle()`.

- On Windows, the returned `Buffer` contains the `HWND` bytes in little-endian format
- The app converts that buffer into a pointer with `ref.readPointer(...)`
- `ref.readPointer(...)` uses the current pointer size, so the same logic works for both 32-bit and 64-bit processes

## How `SetWindowDisplayAffinity` works

The app calls:

```js
SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
```

That asks the Windows compositor to keep the window visible on the local monitor while excluding it from supported capture APIs and sharing pipelines.

Important notes:

- `WDA_EXCLUDEFROMCAPTURE` requires Windows 10 version 2004 or newer
- On older versions, Windows treats it like `WDA_MONITOR`
- Microsoft documents this as content protection support, not absolute DRM-level protection
- A top-level window is required, which is why the code applies affinity to the `BrowserWindow` handle itself

## Files

- `package.json`: Electron app metadata and dependencies
- `main.js`: Window creation, native API binding, capture permissions, OpenAI request handling
- `preload.js`: Safe bridge between the renderer and Electron main process
- `index.html`: Recorder UI, audio mixing, WAV encoding, transcript and response rendering
