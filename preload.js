'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('overlayApi', {
  quitApp: () => ipcRenderer.invoke('app:quit'),
  runOpenAiRequest: (payload) => ipcRenderer.send('openai:run', payload),
  transcribeAudio: (payload) => ipcRenderer.invoke('whisper:transcribe', payload),
  onWindowState: (callback) => subscribe('app:window-state', callback),
  onSystemError: (callback) => subscribe('app:system-error', callback),
  onOpenAiStarted: (callback) => subscribe('openai:started', callback),
  onOpenAiDelta: (callback) => subscribe('openai:delta', callback),
  onOpenAiDone: (callback) => subscribe('openai:done', callback),
  onOpenAiError: (callback) => subscribe('openai:error', callback)
});
