'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Returns an unsubscribe function.
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('overlayApi', {
  // App / window
  quitApp: () => ipcRenderer.invoke('app:quit'),
  resizeHeight: (height) => ipcRenderer.send('app:resize-height', height),
  captureScreen: () => ipcRenderer.invoke('app:capture-screen'),
  onWindowState: (callback) => subscribe('app:window-state', callback),

  // Settings and context files
  getSettings: (key) => ipcRenderer.invoke('settings:get', key),
  setSettings: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  getContextStatus: () => ipcRenderer.invoke('context:status'),

  // Answers
  runOpenAiRequest: (payload) => ipcRenderer.send('openai:run', payload),
  cancelRequest: (requestId) => ipcRenderer.send('openai:cancel', requestId),
  clearConversation: () => ipcRenderer.invoke('conversation:clear'),
  onOpenAiDelta: (callback) => subscribe('openai:delta', callback),
  onOpenAiDone: (callback) => subscribe('openai:done', callback),
  onOpenAiError: (callback) => subscribe('openai:error', callback),
  writeTrace: (record) => ipcRenderer.send('trace:write', record),

  // Transcription
  transcribeAudio: (payload) => ipcRenderer.invoke('whisper:transcribe', payload),
  startRealtimeSession: (payload) => ipcRenderer.invoke('realtime:start', payload),
  sendRealtimeAudioChunk: (pcm) => ipcRenderer.send('realtime:audio-chunk', pcm),
  takeQuestionBlock: () => ipcRenderer.invoke('realtime:take-block'),
  resetQuestionBlock: () => ipcRenderer.invoke('realtime:reset-block'),
  onRealtimePending: (callback) => subscribe('realtime:pending', callback),
  onRealtimeStatus: (callback) => subscribe('realtime:status', callback),
  onRealtimeError: (callback) => subscribe('realtime:error', callback),

  // Global hotkeys
  onShortcutToggleListen: (callback) => subscribe('shortcut:toggle-listen', callback),
  onShortcutAnswer: (callback) => subscribe('shortcut:answer', callback),
  onShortcutScreen: (callback) => subscribe('shortcut:screen', callback),
  onShortcutRegenerate: (callback) => subscribe('shortcut:regenerate', callback),
  onShortcutFollowUp: (callback) => subscribe('shortcut:follow-up', callback) // payload: 'shorter' | 'deeper' | 'with code'
});
