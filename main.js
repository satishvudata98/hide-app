'use strict';

const { app, BrowserWindow, globalShortcut } = require('electron');
const { configureMediaPermissions } = require('./electron/capture');
const { registerIpcHandlers } = require('./electron/ipc');
const { createRealtimeSession } = require('./electron/realtime');
const { createOverlayWindow, emitToRenderer, registerShortcuts } = require('./electron/window');

const realtime = createRealtimeSession(emitToRenderer);

app.whenReady().then(() => {
  if (process.platform !== 'win32') {
    console.warn('Screnshield is built for Windows 10 (2004+) and Windows 11.');
  }

  configureMediaPermissions();
  registerIpcHandlers(realtime);
  createOverlayWindow();
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  realtime.close();
});
