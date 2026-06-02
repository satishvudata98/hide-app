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

let overlayWindow = null;
let isClickThrough = false;
let currentOpacity = 1.0;

const activeRequests = new Map(); // requestId → AbortController

let realtimeWs = null;
let realtimeConfirmedTranscript = '';
let realtimeDraftTranscript = '';
let realtimeAudioQueue = [];
let realtimeStopResolver = null;

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
    ['CommandOrControl+Shift+O', toggleOverlayVisibility],
    ['CommandOrControl+Shift+X', toggleClickThrough],
    ['CommandOrControl+Shift+Up', () => adjustOpacity(OPACITY_STEP)],
    ['CommandOrControl+Shift+Down', () => adjustOpacity(-OPACITY_STEP)],
    ['PageUp', () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('shortcut:pageup');
      }
    }],
    ['PageDown', () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('shortcut:pagedown');
      }
    }]
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

const EXPERT_SYSTEM_PROMPT = `You are a senior software engineer with 7+ years of experience, currently being interviewed. Respond in first person as the candidate — confident, specific, and natural. Use the candidate's resume and job description to make every answer feel personal and authentic.

OUTPUT FORMAT (strict markdown):

## Answer
3–6 sentences. Lead with a direct answer, then expand — explain your reasoning, mention a real project or decision, include numbers or outcomes where possible. Sound like someone who has lived this, not someone reciting a definition.

## Key Points
- 4–6 concrete supporting points
- Each point ties to specific technologies, decisions made, trade-offs weighed, or results achieved
- For behavioral questions: follow STAR (Situation → Task → Action → Result) across the points
- Reference the candidate's resume and job requirements directly

## Code Example
Only for coding, algorithm, or system design questions. Clean, working code under 30 lines with brief inline comments on non-obvious parts. Show best practices and awareness of edge cases.

RULES:
- Omit Code Example for behavioral, culture-fit, or process questions
- Never give textbook definitions — always ground answers in real context from the resume and JD
- Use "I" naturally throughout — this is a spoken interview answer
- Show engineering depth: mention alternatives you considered, why you chose this approach, what you'd do differently at scale
- For system design questions: cover scale, trade-offs, and failure modes
- Never mention being an AI or assistant
- For screen/image analysis: focus only on code and technical questions visible; ignore faces and PII`;

function getContextFiles() {
  let jd = '';
  let resume = '';

  const baseDir = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;

  try {
    const jdPath = path.join(baseDir, 'jd.txt');
    if (fs.existsSync(jdPath)) jd = fs.readFileSync(jdPath, 'utf8');
  } catch (e) {
    console.warn('Failed to read jd.txt', e);
  }

  try {
    const resumePath = path.join(baseDir, 'resume.txt');
    if (fs.existsSync(resumePath)) resume = fs.readFileSync(resumePath, 'utf8');
  } catch (e) {
    console.warn('Failed to read resume.txt', e);
  }

  return { jd, resume };
}

function buildExpertUserContent(userText, includeContext = true) {
  let content = '';
  if (includeContext) {
    const { jd, resume } = getContextFiles();
    if (jd) content += `Job Description:\n${jd}\n\n`;
    if (resume) content += `Candidate Resume:\n${resume}\n\n`;
  }
  content += `User Prompt:\n${userText || 'Transcribe and answer the question'}`;
  return content;
}

function createTextRequestBody(systemPrompt, userText, conversationHistory = []) {
  return {
    model: 'gpt-4o',
    stream: true,
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content: EXPERT_SYSTEM_PROMPT
      },
      ...conversationHistory.slice(-4),
      {
        role: 'user',
        content: buildExpertUserContent(userText)
      }
    ]
  };
}

function createVisionRequestBody(systemPrompt, userText, imageBase64, imageType = 'png') {
  return {
    model: 'gpt-4o',
    stream: true,
    temperature: 0.4,
    max_tokens: 2048,
    messages: [
      {
        role: 'system',
        content: EXPERT_SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildExpertUserContent(userText || 'This is a screenshot of a technical environment. Please extract the technical question or code visible and provide a solution.', true)
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/${imageType};base64,${imageBase64}`,
              detail: 'high'
            }
          }
        ]
      }
    ]
  };
}

function createAudioRequestBody(prompt, audioBase64, format) {
  return {
    model: 'gpt-4o-audio-preview',
    stream: true,
    modalities: ['text'],
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: EXPERT_SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildExpertUserContent(prompt)
          },
          {
            type: 'input_audio',
            input_audio: {
              data: audioBase64,
              format
            }
          }
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

async function readStreamedCompletion(response, sender, requestId) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedText = '';

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

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
  const transcribedText = payload?.transcribedText;
  const audioBase64 = payload?.audioBase64;
  const imageBase64 = payload?.imageBase64;
  const imageType = payload?.imageType || 'png';
  const prompt = payload?.prompt || '';
  const format = payload?.format || 'wav';
  const conversationHistory = Array.isArray(payload?.conversationHistory) ? payload.conversationHistory : [];

  if (!apiKey) {
    throw new Error('Enter your OpenAI API key before sending.');
  }

  const isVisionRequest = !!imageBase64;
  const isTextRequest = format === 'text' && transcribedText;

  if (!isVisionRequest && !isTextRequest && !audioBase64) {
    throw new Error('No content to send. Start listening first.');
  }

  sender.send('openai:started', { requestId });

  let requestBody;
  if (isVisionRequest) {
    requestBody = createVisionRequestBody(prompt, transcribedText || '', imageBase64, imageType);
  } else if (isTextRequest) {
    requestBody = createTextRequestBody(prompt, transcribedText, conversationHistory);
  } else {
    requestBody = createAudioRequestBody(prompt, audioBase64, format);
  }

  const controller = new AbortController();
  activeRequests.set(requestId, controller);

  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);

  console.log(`[openai] request started: ${requestId}`);

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    console.log(`[openai] response: ${response.status} ${response.headers.get('content-type')}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const finalText = contentType.includes('text/event-stream')
      ? await readStreamedCompletion(response, sender, requestId)
      : await readNonStreamCompletion(response);

    console.log(`[openai] done: ${finalText.length} chars`);
    sender.send('openai:done', { requestId, text: finalText || '' });
  } catch (error) {
    if (error.name === 'AbortError' && timedOut) {
      throw new Error('Request timed out (60s). Check your network and try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    activeRequests.delete(requestId);
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
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      });

      if (!sources || sources.length === 0) {
        return { error: 'No screen sources found.' };
      }

      const primarySource = sources[0];
      const thumbnail = primarySource.thumbnail;
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
    overlayWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: Math.max(80, Math.round(height)) });
  });

  // Whisper transcription for live audio chunks
  ipcMain.handle('whisper:transcribe', async (_event, payload) => {
    const apiKey = payload?.apiKey?.trim();
    const audioBase64 = payload?.audioBase64;

    if (!apiKey || !audioBase64) {
      return { text: '', error: 'Missing API key or audio data.' };
    }

    try {
      // Convert base64 to Buffer
      const audioBuffer = Buffer.from(audioBase64, 'base64');

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
        body
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { text: '', error: `Whisper failed (${response.status}): ${errorText}` };
      }

      const result = await response.json();
      return { text: result.text || '' };
    } catch (error) {
      return { text: '', error: error.message || 'Whisper transcription error.' };
    }
  });

  // ── Realtime transcription via OpenAI Realtime API (WebSocket) ──
  ipcMain.handle('realtime:start', (_event, { apiKey }) => {
    if (realtimeWs) {
      try { realtimeWs.close(); } catch {}
      realtimeWs = null;
    }
    realtimeConfirmedTranscript = '';
    realtimeDraftTranscript = '';
    realtimeAudioQueue = [];
    realtimeStopResolver = null;
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

        // Log every event so we can see the exact schema
        console.log('[realtime] event:', event.type, event.error ? JSON.stringify(event.error) : '');

        if (event.type === 'session.created' || event.type === 'session.updated') {
          console.log('[realtime] session object:', JSON.stringify(event.session));
        }

        if (event.type === 'conversation.item.added' || event.type === 'conversation.item.done') {
          console.log('[realtime] item:', JSON.stringify(event.item));
        }

        if (event.type === 'error') {
          console.error('[realtime] API error:', JSON.stringify(event.error));
          emitToRenderer('realtime:error', { message: event.error?.message || 'Realtime API error' });
        }

        if (event.type === 'conversation.item.input_audio_transcription.delta') {
          realtimeDraftTranscript += event.delta || '';
          emitToRenderer('realtime:transcript-delta', {
            delta: event.delta,
            displayText: realtimeConfirmedTranscript + realtimeDraftTranscript
          });
        }

        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          realtimeConfirmedTranscript += (event.transcript || '') + ' ';
          realtimeDraftTranscript = '';
          const full = realtimeConfirmedTranscript.trim();
          emitToRenderer('realtime:transcript-done', { transcript: full });
          if (realtimeStopResolver) {
            realtimeStopResolver(full);
            realtimeStopResolver = null;
          }
        }
      });

      ws.on('error', (err) => {
        console.error('[realtime] WebSocket error:', err.message);
        emitToRenderer('realtime:error', { message: err.message });
        reject(err);
      });

      ws.on('close', () => {
        clearTimeout(openTimeout);
        if (realtimeWs === ws) realtimeWs = null;
        if (realtimeStopResolver) {
          realtimeStopResolver((realtimeConfirmedTranscript + realtimeDraftTranscript).trim());
          realtimeStopResolver = null;
        }
      });
    });
  });

  ipcMain.on('realtime:audio-chunk', (_event, { audioBase64 }) => {
    if (!realtimeWs) return;
    if (realtimeWs.readyState === WebSocket.OPEN) {
      realtimeWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audioBase64 }));
    } else if (realtimeWs.readyState === WebSocket.CONNECTING) {
      realtimeAudioQueue.push(audioBase64);
    }
  });

  ipcMain.handle('realtime:stop', () => {
    return new Promise((resolve) => {
      if (!realtimeWs || realtimeWs.readyState !== WebSocket.OPEN) {
        resolve({ transcript: (realtimeConfirmedTranscript + realtimeDraftTranscript).trim() });
        return;
      }
      realtimeWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      const timeout = setTimeout(() => {
        realtimeStopResolver = null;
        resolve({ transcript: (realtimeConfirmedTranscript + realtimeDraftTranscript).trim() });
      }, 3000);
      realtimeStopResolver = (transcript) => {
        clearTimeout(timeout);
        resolve({ transcript });
      };
    });
  });

  ipcMain.on('realtime:close', () => {
    realtimeStopResolver = null;
    if (realtimeWs) {
      try { realtimeWs.close(); } catch {}
      realtimeWs = null;
    }
    realtimeConfirmedTranscript = '';
    realtimeDraftTranscript = '';
    realtimeAudioQueue = [];
  });
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
});
