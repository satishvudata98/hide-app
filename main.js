'use strict';

const path = require('path');
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
    ['CommandOrControl+Shift+Down', () => adjustOpacity(-OPACITY_STEP)]
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

function createTextRequestBody(systemPrompt, userText) {
  return {
    model: 'gpt-4o',
    stream: true,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content:
          systemPrompt && systemPrompt.trim()
            ? systemPrompt.trim()
            : 'You are a fast desktop assistant. Answer concisely and clearly.'
      },
      {
        role: 'user',
        content: userText
      }
    ]
  };
}

function createVisionRequestBody(systemPrompt, userText, imageBase64) {
  return {
    model: 'gpt-4o',
    stream: true,
    temperature: 0.3,
    max_tokens: 1024,
    messages: [
      {
        role: 'system',
        content:
          systemPrompt && systemPrompt.trim()
            ? systemPrompt.trim()
            : 'You are a fast desktop assistant. Analyze the screenshot and answer concisely. Use bullet points for structured answers.'
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: userText || 'Analyze this screenshot and describe what you see. If there is a question visible, answer it.'
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${imageBase64}`,
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
        content:
          'You are a fast desktop assistant. First transcribe the audio faithfully. Then answer the user prompt clearly. Keep the response concise and easy to read.'
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              prompt && prompt.trim()
                ? prompt.trim()
                : 'Transcribe the recording and respond with a concise helpful answer.'
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
  const prompt = payload?.prompt || '';
  const format = payload?.format || 'wav';

  if (!apiKey) {
    throw new Error('Enter your OpenAI API key before sending.');
  }

  // Determine request type: vision, text, or audio
  const isVisionRequest = !!imageBase64;
  const isTextRequest = format === 'text' && transcribedText;

  if (!isVisionRequest && !isTextRequest && !audioBase64) {
    throw new Error('No content to send. Start listening first.');
  }

  sender.send('openai:started', { requestId });

  let requestBody;
  if (isVisionRequest) {
    requestBody = createVisionRequestBody(prompt, transcribedText || '', imageBase64);
  } else if (isTextRequest) {
    requestBody = createTextRequestBody(prompt, transcribedText);
  } else {
    requestBody = createAudioRequestBody(prompt, audioBase64, format);
  }

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const finalText = contentType.includes('text/event-stream')
    ? await readStreamedCompletion(response, sender, requestId)
    : await readNonStreamCompletion(response);

  sender.send('openai:done', { requestId, text: finalText || '' });
}

function registerIpcHandlers() {
  ipcMain.handle('app:quit', () => {
    app.quit();
  });

  ipcMain.on('openai:run', (event, payload) => {
    runOpenAiRequest(event.sender, payload).catch((error) => {
      event.sender.send('openai:error', {
        requestId: payload?.requestId || null,
        message: error.message || 'Unknown OpenAI request error.'
      });
    });
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
      const pngBuffer = thumbnail.toPNG();
      const base64 = pngBuffer.toString('base64');

      return { imageBase64: base64 };
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
}

function createWindow() {
  // Position window top-center of primary display
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workAreaSize;
  const winWidth = 580;
  const winHeight = 110; // compact initial height, will auto-resize
  const xPos = Math.round((workArea.width - winWidth) / 2);
  const yPos = 12; // small gap from top edge

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
