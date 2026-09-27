'use strict';

const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  session
} = require('electron');

let ffi = null;
let ref = null;
let ffiLoadError = null;

try {
  ffi = require('ffi-napi');
  ref = require('ref-napi');
} catch (error) {
  ffiLoadError = error;
}

const isWindows = process.platform === 'win32';
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;
const OPACITY_STEP = 0.1;
const MIN_OPACITY = 0.75;
const MAX_OPACITY = 1.0;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_ANSWER_MODEL = 'gpt-4o'; // override with "answerModel" in the settings file
const HEADERS_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 20_000;
const WHISPER_TIMEOUT_MS = 30_000;
const REALTIME_STOP_TIMEOUT_MS = 3_000;
const MAX_SCREENSHOT_SIDE = 2048;

// Global hotkeys. Change here if any of these clash with another app.
const SHORTCUTS = {
  toggleVisibility: 'CommandOrControl+Shift+O',
  toggleClickThrough: 'CommandOrControl+Shift+X',
  opacityUp: 'CommandOrControl+Shift+Up',
  opacityDown: 'CommandOrControl+Shift+Down',
  toggleRecord: 'CommandOrControl+Shift+Space',
  answer: 'CommandOrControl+Shift+Enter',
  analyzeScreen: 'CommandOrControl+Shift+S'
};

let overlayWindow = null;
let isClickThrough = false;
let currentOpacity = 1.0;

const activeRequests = new Map(); // requestId → AbortController

let realtimeWs = null;
let realtimeAudioQueue = [];
// Transcript segments keyed by item_id, kept in commit order so late or
// out-of-order completions still assemble correctly.
let realtimeItems = new Map(); // item_id → { text, done }
let realtimeOrder = [];
let realtimeAwaitingCommit = false; // speech started (or manual commit sent) but not yet committed
let realtimeVadSeen = false; // server VAD reported speech at least once this session
let realtimeHasUncommittedAudio = false;
let realtimeAcceptingEvents = true; // false while waiting for a buffer clear to be confirmed
let realtimeStopWaiter = null; // (force?) => void, re-checked whenever an item changes

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'screnshield-settings.json');
}

function readSettings() {
  try {
    const p = getSettingsPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return {};
}

function writeSettings(updates) {
  try {
    const p = getSettingsPath();
    const current = readSettings();
    fs.writeFileSync(p, JSON.stringify({ ...current, ...updates }, null, 2), 'utf8');
  } catch {}
}

const user32 = isWindows && ffi
  ? ffi.Library('user32', {
    SetWindowDisplayAffinity: ['bool', ['pointer', 'uint32']]
  })
  : null;

const kernel32 = isWindows && ffi
  ? ffi.Library('kernel32', {
    GetLastError: ['uint32', []]
  })
  : null;

function hwndBufferToPointer(nativeHandleBuffer) {
  if (!ref) {
    throw new Error('ref-napi is not available, so HWND pointer conversion cannot run.');
  }

  if (!Buffer.isBuffer(nativeHandleBuffer)) {
    throw new TypeError('Expected BrowserWindow.getNativeWindowHandle() to return a Buffer.');
  }

  if (nativeHandleBuffer.length !== ref.sizeof.pointer) {
    throw new Error(
      `Native HWND size mismatch. Buffer length was ${nativeHandleBuffer.length}, pointer size is ${ref.sizeof.pointer}.`
    );
  }

  // Electron returns HWND as a Buffer whose bytes contain the native handle value.
  // readPointer() interprets those bytes using the current process pointer size,
  // so the same code works on both 32-bit and 64-bit Windows builds.
  return ref.readPointer(nativeHandleBuffer, 0, 0);
}

function formatNativeHandle(nativeHandleBuffer) {
  if (nativeHandleBuffer.length === 8) {
    return `0x${nativeHandleBuffer.readBigUInt64LE(0).toString(16)}`;
  }

  if (nativeHandleBuffer.length === 4) {
    return `0x${nativeHandleBuffer.readUInt32LE(0).toString(16)}`;
  }

  return nativeHandleBuffer.toString('hex');
}

function emitToRenderer(channel, payload) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  overlayWindow.webContents.send(channel, payload);
}

function emitWindowState() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  emitToRenderer('app:window-state', {
    visible: overlayWindow.isVisible(),
    clickThrough: isClickThrough,
    opacity: Number(currentOpacity.toFixed(2))
  });
}

function applyCaptureExclusion(win) {
  if (!isWindows) {
    return;
  }

  if (!user32 || !kernel32 || !ref) {
    // Electron documents that setContentProtection(true) maps to
    // SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) on Windows.
    win.setContentProtection(true);
    console.warn(
      `ffi-napi/ref-napi unavailable, using BrowserWindow.setContentProtection(true) instead: ${ffiLoadError ? ffiLoadError.message : 'native bindings not loaded'}`
    );
    return;
  }

  // BrowserWindow#getNativeWindowHandle() returns the HWND bytes for the
  // top-level native window that Electron created on Windows.
  const nativeHandleBuffer = win.getNativeWindowHandle();
  const hwnd = hwndBufferToPointer(nativeHandleBuffer);
  // WDA_EXCLUDEFROMCAPTURE asks the Windows compositor to keep the window
  // visible on the local monitor while omitting it from supported capture APIs.
  const success = user32.SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);

  if (!success) {
    const errorCode = kernel32.GetLastError();
    throw new Error(
      `SetWindowDisplayAffinity failed for HWND ${formatNativeHandle(nativeHandleBuffer)} (GetLastError=${errorCode}).`
    );
  }

  console.log(
    `Capture exclusion enabled for HWND ${formatNativeHandle(nativeHandleBuffer)} using WDA_EXCLUDEFROMCAPTURE.`
  );
}

function enforceOverlayBehavior(win) {
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.moveTop();
}

function clampOpacity(value) {
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, value));
}

function setOverlayVisibility(visible) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  if (visible) {
    overlayWindow.show();
    enforceOverlayBehavior(overlayWindow);
    emitWindowState();
    return;
  }

  overlayWindow.hide();
  emitWindowState();
}

function toggleOverlayVisibility() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  setOverlayVisibility(!overlayWindow.isVisible());
}

function toggleClickThrough() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  isClickThrough = !isClickThrough;
  overlayWindow.setIgnoreMouseEvents(isClickThrough, { forward: true });
  emitWindowState();
}

function adjustOpacity(delta) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  currentOpacity = clampOpacity(Number((currentOpacity + delta).toFixed(2)));
  overlayWindow.setOpacity(currentOpacity);
  emitWindowState();
}

function registerShortcuts() {
  const bindings = [
    [SHORTCUTS.toggleVisibility, toggleOverlayVisibility],
    [SHORTCUTS.toggleClickThrough, toggleClickThrough],
    [SHORTCUTS.opacityUp, () => adjustOpacity(OPACITY_STEP)],
    [SHORTCUTS.opacityDown, () => adjustOpacity(-OPACITY_STEP)],
    [SHORTCUTS.toggleRecord, () => emitToRenderer('shortcut:toggle-record')],
    [SHORTCUTS.answer, () => emitToRenderer('shortcut:answer')],
    [SHORTCUTS.analyzeScreen, () => emitToRenderer('shortcut:screen')]
  ];

  for (const [accelerator, handler] of bindings) {
    const registered = globalShortcut.register(accelerator, handler);

    if (!registered) {
      console.warn(`Failed to register shortcut: ${accelerator}`);
    }
  }
}

function configureCapturePermissions() {
  const electronSession = session.defaultSession;

  // Grant all media permissions: microphone, audio-capture, display-capture
  // This is required for webkitSpeechRecognition to access the mic
  electronSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowed = ['media', 'display-capture', 'audio-capture', 'microphone'];
    return allowed.includes(permission);
  });

  electronSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'display-capture', 'audio-capture', 'microphone'];
    callback(allowed.includes(permission));
  });

  electronSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1, height: 1 }
        });

        callback({
          video: sources[0],
          audio: 'loopback'
        });
      } catch (error) {
        console.error('Display media request failed:', error);
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

const EXPERT_SYSTEM_PROMPT = `You help a software engineer answer questions in a live technical interview. Write what the candidate should say: first person, natural, easy to say out loud. Match the candidate's real seniority and experience as shown in their resume below.

OUTPUT FORMAT (markdown):

**Say:** 1–2 sentences the candidate can say immediately. Direct answer first.

## Key Points
- 3–4 short bullets: supporting detail, trade-offs, or talking points for a follow-up
- For behavioral questions, cover Situation → Task → Action → Result across the bullets

## Code
Only for coding, algorithm, or system design questions: clean, working code under 30 lines with brief comments on non-obvious parts. Leave this section out otherwise.

RULES:
- Only mention projects, companies, technologies and numbers that appear in the resume. If the resume has nothing relevant, answer from general engineering knowledge without claiming specific experience. Never invent projects or metrics.
- Keep sentences short and speakable; use "I" naturally.
- Prefer practical reasoning over textbook definitions: why this approach, what the alternatives are, what changes at scale.
- For system design: briefly cover scale, trade-offs and failure modes.
- Never mention being an AI or assistant.
- For screenshots: focus only on the code or technical question visible; ignore faces and personal data.`;

function getContextDir() {
  if (!app.isPackaged) return __dirname;
  // The portable build runs from a temp extraction folder; this env var points
  // at the folder the user actually launched the exe from.
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
}

const contextCache = new Map(); // fileName → { mtimeMs, text }

function readContextFile(fileName) {
  const filePath = path.join(getContextDir(), fileName);
  try {
    const { mtimeMs } = fs.statSync(filePath);
    const cached = contextCache.get(fileName);
    if (cached && cached.mtimeMs === mtimeMs) return cached.text;
    const text = fs.readFileSync(filePath, 'utf8');
    contextCache.set(fileName, { mtimeMs, text });
    return text;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Failed to read ${fileName}`, error);
    contextCache.delete(fileName);
    return '';
  }
}

function getContextFiles() {
  return { jd: readContextFile('jd.txt'), resume: readContextFile('resume.txt') };
}

// System prompt + JD + resume form one stable prefix, so OpenAI's automatic
// prompt caching can reuse it across questions.
function buildSystemMessage() {
  const { jd, resume } = getContextFiles();
  let content = EXPERT_SYSTEM_PROMPT;
  if (jd.trim()) content += `

# Job Description
${jd.trim()}`;
  if (resume.trim()) content += `

# Candidate Resume
${resume.trim()}`;
  return { role: 'system', content };
}

function getAnswerModel() {
  return readSettings().answerModel || DEFAULT_ANSWER_MODEL;
}

function createTextRequestBody(question, conversationHistory = []) {
  return {
    model: getAnswerModel(),
    stream: true,
    temperature: 0.4,
    max_tokens: 700,
    messages: [
      buildSystemMessage(),
      ...conversationHistory.slice(-4),
      { role: 'user', content: `Interviewer question:
${question}` }
    ]
  };
}

function createVisionRequestBody(imageBase64, imageType, conversationHistory = []) {
  return {
    model: getAnswerModel(),
    stream: true,
    temperature: 0.4,
    max_tokens: 1200,
    messages: [
      buildSystemMessage(),
      ...conversationHistory.slice(-4),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'This is a screenshot of the interview screen. Extract the technical question or code shown and answer it.' },
          { type: 'image_url', image_url: { url: `data:image/${imageType};base64,${imageBase64}`, detail: 'high' } }
        ]
      }
    ]
  };
}

function extractTextFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (!part || typeof part !== 'object') {
        return '';
      }

      if (part.type === 'text' || part.type === 'output_text') {
        return typeof part.text === 'string' ? part.text : part.value || '';
      }

      return '';
    })
    .join('');
}

function extractTextDelta(parsedChunk) {
  const choice = parsedChunk?.choices?.[0];

  if (!choice) {
    return '';
  }

  const delta = choice.delta || {};

  if (typeof delta.content === 'string') {
    return delta.content;
  }

  const deltaContent = extractTextFromContent(delta.content);

  if (deltaContent) {
    return deltaContent;
  }

  const message = choice.message || {};
  return extractTextFromContent(message.content);
}

async function readStreamedCompletion(response, sender, requestId, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedText = '';

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    onChunk();

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      const lines = event
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'));

      for (const line of lines) {
        const payload = line.slice(5).trim();

        if (!payload) {
          continue;
        }

        if (payload === '[DONE]') {
          return accumulatedText;
        }

        let parsedChunk;

        try {
          parsedChunk = JSON.parse(payload);
        } catch (_error) {
          continue;
        }

        const textDelta = extractTextDelta(parsedChunk);

        if (textDelta) {
          accumulatedText += textDelta;
          sender.send('openai:delta', { requestId, delta: textDelta, text: accumulatedText });
        }
      }
    }
  }

  return accumulatedText;
}

async function readNonStreamCompletion(response) {
  const parsed = await response.json();
  return extractTextDelta(parsed);
}

async function runOpenAiRequest(sender, payload) {
  const requestId = payload?.requestId || `req_${Date.now()}`;
  const apiKey = payload?.apiKey?.trim();
  const question = payload?.transcribedText?.trim();
  const imageBase64 = payload?.imageBase64;
  const imageType = payload?.imageType || 'jpeg';
  const conversationHistory = Array.isArray(payload?.conversationHistory) ? payload.conversationHistory : [];

  if (!apiKey) {
    throw new Error('Enter your OpenAI API key before sending.');
  }

  if (!imageBase64 && !question) {
    throw new Error('No question to answer. Record, paste text or analyze the screen first.');
  }

  sender.send('openai:started', { requestId });

  const requestBody = imageBase64
    ? createVisionRequestBody(imageBase64, imageType, conversationHistory)
    : createTextRequestBody(question, conversationHistory);

  const controller = new AbortController();
  activeRequests.set(requestId, controller);

  // One timer, re-armed as the request progresses: first waiting for headers,
  // then waiting between stream chunks. Whichever fires records why.
  let timeoutReason = null;
  let timer = null;
  const armTimer = (ms, reason) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timeoutReason = reason; controller.abort(); }, ms);
  };

  console.log(`[openai] request started: ${requestId}`);

  try {
    const response = await fetchWithRetry(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    }, () => armTimer(HEADERS_TIMEOUT_MS, 'headers'));

    console.log(`[openai] response: ${response.status} ${response.headers.get('content-type')}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
    }

    armTimer(STREAM_IDLE_TIMEOUT_MS, 'idle');
    const contentType = response.headers.get('content-type') || '';
    const finalText = contentType.includes('text/event-stream')
      ? await readStreamedCompletion(response, sender, requestId, () => armTimer(STREAM_IDLE_TIMEOUT_MS, 'idle'))
      : await readNonStreamCompletion(response);

    console.log(`[openai] done: ${finalText.length} chars`);
    sender.send('openai:done', { requestId, text: finalText || '' });
  } catch (error) {
    if (error.name === 'AbortError' && timeoutReason === 'headers') {
      throw new Error(`No response from OpenAI after ${HEADERS_TIMEOUT_MS / 1000}s. Check your network and try again.`);
    }
    if (error.name === 'AbortError' && timeoutReason === 'idle') {
      throw new Error(`Answer stream stalled for ${STREAM_IDLE_TIMEOUT_MS / 1000}s and was stopped. Try again.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    activeRequests.delete(requestId);
  }
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

// Retries once on a network error or a 429/5xx. Only covers the phase before
// any token is streamed, so a retry never duplicates visible output.
async function fetchWithRetry(url, options, onAttempt) {
  for (let attempt = 0; ; attempt++) {
    onAttempt();
    const isLastAttempt = attempt >= 1;
    try {
      const response = await fetch(url, options);
      if (isLastAttempt || !isRetryableStatus(response.status)) return response;
      console.warn(`[openai] ${response.status}, retrying once`);
    } catch (error) {
      if (error.name === 'AbortError' || isLastAttempt) throw error;
      console.warn(`[openai] network error, retrying once: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (options.signal?.aborted) {
      throw Object.assign(new Error('Request aborted.'), { name: 'AbortError' });
    }
  }
}

function registerIpcHandlers() {
  ipcMain.handle('app:quit', () => {
    app.quit();
  });

  ipcMain.on('openai:run', (event, payload) => {
    runOpenAiRequest(event.sender, payload).catch((error) => {
      console.error('[openai] error:', error.message);
      if (error.name === 'AbortError') return; // user-cancelled
      event.sender.send('openai:error', {
        requestId: payload?.requestId || null,
        message: error.message || 'Unknown OpenAI request error.'
      });
    });
  });

  ipcMain.on('openai:cancel', (_event, reqId) => {
    const controller = activeRequests.get(reqId);
    if (controller) {
      controller.abort();
      activeRequests.delete(reqId);
    }
  });

  ipcMain.handle('settings:get', (_event, key) => readSettings()[key] ?? null);

  ipcMain.handle('settings:set', (_event, key, value) => {
    writeSettings({ [key]: value });
  });

  // Screen capture for "analyze screen" feature
  ipcMain.handle('app:capture-screen', async () => {
    try {
      // Capture the display the cursor is on, at native aspect ratio, long side ≤ 2048px
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const nativeWidth = display.size.width * display.scaleFactor;
      const nativeHeight = display.size.height * display.scaleFactor;
      const scale = Math.min(1, MAX_SCREENSHOT_SIDE / Math.max(nativeWidth, nativeHeight));
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(nativeWidth * scale), height: Math.round(nativeHeight * scale) }
      });

      if (!sources || sources.length === 0) {
        return { error: 'No screen sources found.' };
      }

      const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
      const thumbnail = source.thumbnail;
      // JPEG at 85% quality is ~5-10x smaller than PNG — critical for fast API response
      const jpegBuffer = thumbnail.toJPEG(85);
      const base64 = jpegBuffer.toString('base64');

      return { imageBase64: base64, imageType: 'jpeg' };
    } catch (error) {
      return { error: error.message || 'Screen capture failed.' };
    }
  });

  // Resize the overlay window height dynamically
  ipcMain.on('app:resize-height', (_event, height) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const bounds = overlayWindow.getBounds();
    const { workArea } = screen.getDisplayMatching(bounds);
    const maxHeight = workArea.y + workArea.height - bounds.y;
    const clamped = Math.min(maxHeight, Math.max(80, Math.round(height)));
    if (clamped !== bounds.height) overlayWindow.setBounds({ ...bounds, height: clamped });
  });

  // Whisper transcription, used when the realtime session produced no transcript
  ipcMain.handle('whisper:transcribe', async (_event, payload) => {
    const apiKey = payload?.apiKey?.trim();

    if (!apiKey || !payload?.wav) {
      return { text: '', error: 'Missing API key or audio data.' };
    }

    try {
      const audioBuffer = Buffer.from(payload.wav);

      // Build multipart form data manually
      const boundary = '----WhisperBoundary' + Date.now();
      const modelPart = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`;
      const languagePart = `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`;
      const filePart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
      const endPart = `\r\n--${boundary}--\r\n`;

      const bodyParts = [
        Buffer.from(modelPart, 'utf-8'),
        Buffer.from(languagePart, 'utf-8'),
        Buffer.from(filePart, 'utf-8'),
        audioBuffer,
        Buffer.from(endPart, 'utf-8')
      ];
      const body = Buffer.concat(bodyParts);

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body,
        signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS)
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { text: '', error: `Whisper failed (${response.status}): ${errorText}` };
      }

      const result = await response.json();
      return { text: result.text || '' };
    } catch (error) {
      if (error.name === 'TimeoutError') {
        return { text: '', error: `Whisper did not respond within ${WHISPER_TIMEOUT_MS / 1000}s.` };
      }
      return { text: '', error: error.message || 'Whisper transcription error.' };
    }
  });

  ipcMain.handle('context:status', () => {
    const { jd, resume } = getContextFiles();
    return { dir: getContextDir(), hasJd: !!jd.trim(), hasResume: !!resume.trim() };
  });

  // ── Realtime transcription via OpenAI Realtime API (WebSocket) ──
  // The socket stays open between recordings. Starting again on an open socket
  // just clears the server-side buffer; events are ignored until the server
  // confirms the clear, so leftovers from the previous recording can't leak in.
  ipcMain.handle('realtime:start', (_event, { apiKey }) => {
    resetRealtimeTranscript();

    if (realtimeWs?.readyState === WebSocket.OPEN) {
      realtimeAcceptingEvents = false;
      realtimeWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
      console.log('[realtime] reusing open session');
      return { ok: true };
    }
    if (realtimeWs?.readyState === WebSocket.CONNECTING) {
      return { ok: true };
    }

    realtimeAudioQueue = [];
    realtimeAcceptingEvents = true;
    console.log('[realtime] starting session...');

    return new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
        headers: {
          Authorization: `Bearer ${apiKey}`
        }
      });

      realtimeWs = ws;

      const openTimeout = setTimeout(() => {
        ws.terminate();
        reject(new Error('Realtime WebSocket connection timed out.'));
      }, 10000);

      ws.on('open', () => {
        clearTimeout(openTimeout);
        console.log('[realtime] WebSocket connected, configuring session');
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                transcription: {
                  model: 'gpt-4o-transcribe',
                  language: 'en'
                }
              }
            }
          }
        }));
        for (const chunk of realtimeAudioQueue) {
          ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk }));
        }
        realtimeAudioQueue = [];
        resolve({ ok: true });
      });

      ws.on('message', (data) => {
        let event;
        try { event = JSON.parse(data.toString()); } catch { return; }
        if (realtimeWs !== ws) return; // late event from a replaced session
        handleRealtimeEvent(event);
      });

      ws.on('error', (err) => {
        console.error('[realtime] WebSocket error:', err.message);
        emitToRenderer('realtime:error', { message: err.message });
        reject(err);
      });

      ws.on('close', () => {
        clearTimeout(openTimeout);
        if (realtimeWs !== ws) return;
        realtimeWs = null;
        if (realtimeStopWaiter) realtimeStopWaiter(true);
      });
    });
  });

  ipcMain.on('realtime:audio-chunk', (_event, pcm) => {
    if (!realtimeWs) return;
    const audioBase64 = Buffer.from(pcm).toString('base64');
    realtimeHasUncommittedAudio = true;
    if (realtimeWs.readyState === WebSocket.OPEN) {
      realtimeWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audioBase64 }));
    } else if (realtimeWs.readyState === WebSocket.CONNECTING) {
      realtimeAudioQueue.push(audioBase64);
    }
  });

  // Resolves once every committed segment has its final transcript, so the
  // tail of the question is not lost. Returns immediately when nothing is pending.
  ipcMain.handle('realtime:stop', () => new Promise((resolve) => {
    let timeout = null;
    const finish = () => {
      clearTimeout(timeout);
      realtimeStopWaiter = null;
      resolve({ transcript: getRealtimeTranscript() });
    };

    if (!realtimeWs || realtimeWs.readyState !== WebSocket.OPEN) {
      finish();
      return;
    }

    // With server VAD the buffer is usually already committed once the speaker
    // pauses; only commit when speech is still open (or VAD never reported).
    const vadMissing = !realtimeVadSeen && realtimeHasUncommittedAudio;
    if (realtimeAwaitingCommit || vadMissing) {
      realtimeAwaitingCommit = true;
      realtimeWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    }

    if (!hasPendingRealtimeItems()) {
      finish();
      return;
    }

    timeout = setTimeout(finish, REALTIME_STOP_TIMEOUT_MS);
    realtimeStopWaiter = (force = false) => {
      if (force || !hasPendingRealtimeItems()) finish();
    };
  }));
}

function resetRealtimeTranscript() {
  realtimeItems = new Map();
  realtimeOrder = [];
  realtimeAwaitingCommit = false;
  realtimeVadSeen = false;
  realtimeHasUncommittedAudio = false;
}

function getRealtimeItem(itemId) {
  if (!realtimeItems.has(itemId)) {
    realtimeItems.set(itemId, { text: '', done: false });
    realtimeOrder.push(itemId);
  }
  return realtimeItems.get(itemId);
}

function getRealtimeTranscript() {
  return realtimeOrder
    .map((id) => realtimeItems.get(id).text.trim())
    .filter(Boolean)
    .join(' ');
}

function hasPendingRealtimeItems() {
  return realtimeAwaitingCommit || realtimeOrder.some((id) => !realtimeItems.get(id).done);
}

function handleRealtimeEvent(event) {
  if (!realtimeAcceptingEvents) {
    if (event.type === 'input_audio_buffer.cleared') realtimeAcceptingEvents = true;
    return;
  }

  switch (event.type) {
    case 'input_audio_buffer.speech_started':
      realtimeVadSeen = true;
      realtimeAwaitingCommit = true;
      break;

    case 'input_audio_buffer.committed':
      realtimeAwaitingCommit = false;
      realtimeHasUncommittedAudio = false;
      getRealtimeItem(event.item_id);
      break;

    case 'conversation.item.input_audio_transcription.delta': {
      const item = realtimeItems.get(event.item_id);
      if (!item) return;
      item.text += event.delta || '';
      emitToRenderer('realtime:transcript-delta', { displayText: getRealtimeTranscript() });
      break;
    }

    case 'conversation.item.input_audio_transcription.completed': {
      const item = realtimeItems.get(event.item_id);
      if (!item) return;
      item.text = event.transcript || '';
      item.done = true;
      emitToRenderer('realtime:transcript-done', { transcript: getRealtimeTranscript() });
      break;
    }

    case 'conversation.item.input_audio_transcription.failed': {
      const item = realtimeItems.get(event.item_id);
      if (!item) return;
      item.done = true;
      console.warn('[realtime] transcription failed:', JSON.stringify(event.error));
      break;
    }

    case 'error':
      // A commit on an empty buffer is expected when VAD already committed it.
      realtimeAwaitingCommit = false;
      if (event.error?.code === 'input_audio_buffer_commit_empty' || /buffer only has/i.test(event.error?.message || '')) break;
      console.error('[realtime] API error:', JSON.stringify(event.error));
      emitToRenderer('realtime:error', { message: event.error?.message || 'Realtime API error' });
      break;

    default:
      return;
  }

  if (realtimeStopWaiter) realtimeStopWaiter();
}

function createWindow() {
  // Position window top-center of primary display
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;
  const winWidth = 720;
  const winHeight = 50; // extremely compact single row, will auto-resize
  const xPos = workArea.x + Math.round((workArea.width - winWidth) / 2);
  const yPos = workArea.y + 12; // small gap from top edge

  overlayWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: winWidth,
    minHeight: 80,
    x: xPos,
    y: yPos,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  overlayWindow.setMenuBarVisibility(false);
  overlayWindow.setOpacity(currentOpacity);
  enforceOverlayBehavior(overlayWindow);

  if (process.env.VITE_DEV_SERVER_URL) {
    overlayWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    overlayWindow.loadFile(path.join(__dirname, 'dist-vue', 'index.html'));
  }

  overlayWindow.webContents.on('did-finish-load', () => {
    emitWindowState();
    if (!app.isPackaged) {
      overlayWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  overlayWindow.once('ready-to-show', () => {
    setOverlayVisibility(true);

    if (isWindows) {
      try {
        applyCaptureExclusion(overlayWindow);
      } catch (error) {
        console.error(error.message);
        emitToRenderer('app:system-error', { message: error.message });
      }
    }
  });

  overlayWindow.on('show', () => {
    enforceOverlayBehavior(overlayWindow);
    emitWindowState();
  });

  overlayWindow.on('restore', () => {
    enforceOverlayBehavior(overlayWindow);
    emitWindowState();
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

app.whenReady().then(() => {
  if (!isWindows) {
    console.warn('This demo is intended for Windows 10 (2004+) and Windows 11.');
  }

  configureCapturePermissions();
  registerIpcHandlers();
  createWindow();
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (realtimeWs) realtimeWs.close();
});
