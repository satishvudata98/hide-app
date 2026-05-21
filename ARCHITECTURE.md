# Screnshield Architecture & Flow Analysis

Screnshield is a stealth AI assistant overlay built for Windows. It provides an invisible overlay (hidden from screen capturing tools) to assist during technical interviews. It captures audio or screen content, augments the query with local context (Resume and Job Description), and queries OpenAI's advanced models to provide real-time, streaming answers.

## 1. Tech Stack
* **Core Framework:** Electron (Node.js backend + Chromium frontend). Used for desktop window management, IPC (Inter-Process Communication), global shortcuts, and screen capture (`desktopCapturer`).
* **Frontend Framework:** Vue 3 (Composition API) built with Vite. Provides a highly reactive, lightweight UI.
* **Native Windows Interop:** `ffi-napi` and `ref-napi`. These are used to directly invoke the Windows `user32.dll` API to achieve the stealth capture exclusion.
* **AI Engine:** OpenAI API. Uses `gpt-4o` for vision and text generation, and `gpt-4o-audio-preview` for native audio comprehension and response.
* **Web Audio API:** Used in the frontend to capture microphone data, mix channels to mono, downsample to 16kHz, and encode raw PCM data into WAV format.

---

## 2. Component Architecture

### The Main Process (`main.js`)
The backbone of the application running in Node.js.
* **Window Management:** Creates a transparent, frameless, and non-resizable `BrowserWindow` positioned at the top-center of the screen.
* **Stealth Mode Engine:** Uses `ffi-napi` to retrieve the native window handle (HWND) and applies `WDA_EXCLUDEFROMCAPTURE` (0x11) via `SetWindowDisplayAffinity`. This instructs the Windows desktop compositor to display the window locally but completely exclude it from any screen capture/recording APIs (like OBS, Zoom, Teams).
* **Context Ingestion:** Reads `jd.txt` (Job Description) and `resume.txt` from the local directory dynamically to construct an expert system prompt tailored to the candidate's background.
* **API Orchestration:** Contains REST clients for OpenAI. It formats requests based on the modality (vision, audio, text), handles the HTTP stream, parses SSE (Server-Sent Events), and forwards text chunks back to the frontend using IPC.

### The Preload Script (`preload.js`)
Acts as a secure Context Bridge between the Node.js backend and the Vue frontend.
* Exposes `window.overlayApi`, ensuring the renderer cannot directly access Node.js APIs or the file system.
* Handles bi-directional IPC channels like `openai:run`, `app:capture-screen`, and streams events like `openai:delta`.

### The Renderer Process (`WorkspaceScreen.vue`)
The reactive UI layer.
* **State Machine:** Manages states: `idle`, `recording`, and `answering`.
* **Audio Pipeline:** When recording starts, it initializes an `AudioContext`, captures audio via a `ScriptProcessorNode`, mixes channels to mono, and accumulates audio chunks in memory.
* **WAV Encoding:** Upon stopping, it downsamples the collected audio array to 16kHz, encodes it into a standard WAV buffer, converts it to base64, and sends it to the main process.
* **Dynamic UI Resizing:** Uses a `ResizeObserver` on the root DOM element. As the AI streams its answer back, the text grows; Vue dynamically sends an IPC call to the main process to resize the native Electron window height to perfectly fit the newly rendered content.

---

## 3. End-to-End Application Flow

### Flow 1: Stealth Initialization
1. **Launch:** The user runs the Electron app.
2. **Window Creation:** `main.js` creates a frameless, transparent window.
3. **Capture Exclusion:** `main.js` converts the Electron window handle to a raw pointer and invokes `SetWindowDisplayAffinity(hwnd, 0x11)`. The window becomes invisible to screen recording tools.
4. **UI Load:** `WorkspaceScreen.vue` loads via Vite. The UI is a minimal control bar at the top of the screen.

### Flow 2: Audio Question Pipeline
1. **Record:** User clicks the "rec" pill (or presses `PageUp`).
2. **Audio Capture:** The Vue frontend accesses the system microphone via `navigator.mediaDevices.getUserMedia` and continuously stores audio chunks.
3. **Submit:** User clicks "Answer Question" (or presses `PageDown`).
4. **Processing:** Vue stops the recording, downsamples the audio, encodes it to a base64 WAV file, and sends an `openai:run` IPC message containing the audio data.
5. **Context Building:** `main.js` receives the IPC. It reads `jd.txt` and `resume.txt` and concatenates them with a strict system prompt instructing the AI to act as an expert interview assistant.
6. **AI Request:** `main.js` sends the payload to OpenAI's `gpt-4o-audio-preview` model.
7. **Streaming:** As OpenAI streams the answer back, `main.js` parses the JSON stream, extracts text deltas, and fires `openai:delta` events to the renderer.
8. **Display:** `WorkspaceScreen.vue` appends the text to the UI. The `ResizeObserver` detects the height change and tells `main.js` to expand the window downwards so the text remains visible.

### Flow 3: Screen Analysis Pipeline
1. **Trigger:** User clicks "Analyze Screen" on the UI.
2. **Capture IPC:** Vue calls `window.overlayApi.captureScreen()`.
3. **Desktop Capture:** `main.js` uses Electron's `desktopCapturer` to take a 1080p screenshot of the primary display. It converts the frame to a base64 PNG.
4. **AI Request:** `main.js` packages the image base64, the JD/Resume context, and the system prompt, sending it to OpenAI's `gpt-4o` vision model.
5. **Streaming:** The vision model analyzes the code or technical question on the screen and streams the answer back via `openai:delta` IPC messages.
6. **Display:** The frontend renders the streaming answer in real-time, auto-resizing the window exactly like the audio flow.
