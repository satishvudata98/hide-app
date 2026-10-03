'use strict';

const path = require('node:path');
const { app, BrowserWindow, globalShortcut, screen } = require('electron');

const WINDOW_WIDTH = 720;
const MIN_HEIGHT = 80;
const OPACITY_STEP = 0.1;
const MIN_OPACITY = 0.75;
const MAX_OPACITY = 1.0;

// Global hotkeys. Change here if any of these clash with another app.
const SHORTCUTS = {
  toggleVisibility: 'CommandOrControl+Shift+O',
  toggleClickThrough: 'CommandOrControl+Shift+X',
  opacityUp: 'CommandOrControl+Shift+Up',
  opacityDown: 'CommandOrControl+Shift+Down',
  toggleListen: 'CommandOrControl+Shift+Space', // pause / resume listening
  answer: 'CommandOrControl+Shift+Enter', // answer everything heard since the last answer
  analyzeScreen: 'CommandOrControl+Shift+S',
  regenerate: 'CommandOrControl+Shift+R',
  shorter: 'CommandOrControl+Shift+1',
  deeper: 'CommandOrControl+Shift+2',
  withCode: 'CommandOrControl+Shift+3'
};

let overlayWindow = null;
let isClickThrough = false;
let currentOpacity = 1.0;

function getWindow() {
  return overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null;
}

function emitToRenderer(channel, payload) {
  getWindow()?.webContents.send(channel, payload);
}

function emitWindowState() {
  const win = getWindow();
  if (!win) return;
  emitToRenderer('app:window-state', {
    visible: win.isVisible(),
    clickThrough: isClickThrough,
    opacity: Number(currentOpacity.toFixed(2))
  });
}

function keepOnTop(win) {
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.moveTop();
}

function toggleVisibility() {
  const win = getWindow();
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.show(); // the 'show' handler re-applies always-on-top
  emitWindowState();
}

function toggleClickThrough() {
  const win = getWindow();
  if (!win) return;
  isClickThrough = !isClickThrough;
  win.setIgnoreMouseEvents(isClickThrough, { forward: true });
  emitWindowState();
}

function adjustOpacity(delta) {
  const win = getWindow();
  if (!win) return;
  currentOpacity = Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, Number((currentOpacity + delta).toFixed(2))));
  win.setOpacity(currentOpacity);
  emitWindowState();
}

// Grow or shrink to fit the content, never past the bottom of the screen.
function resizeHeight(height) {
  const win = getWindow();
  if (!win) return;
  const bounds = win.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  const maxHeight = workArea.y + workArea.height - bounds.y;
  const clamped = Math.min(maxHeight, Math.max(MIN_HEIGHT, Math.round(height)));
  if (clamped !== bounds.height) win.setBounds({ ...bounds, height: clamped });
}

function registerShortcuts() {
  const bindings = [
    [SHORTCUTS.toggleVisibility, toggleVisibility],
    [SHORTCUTS.toggleClickThrough, toggleClickThrough],
    [SHORTCUTS.opacityUp, () => adjustOpacity(OPACITY_STEP)],
    [SHORTCUTS.opacityDown, () => adjustOpacity(-OPACITY_STEP)],
    [SHORTCUTS.toggleListen, () => emitToRenderer('shortcut:toggle-listen')],
    [SHORTCUTS.answer, () => emitToRenderer('shortcut:answer')],
    [SHORTCUTS.analyzeScreen, () => emitToRenderer('shortcut:screen')],
    [SHORTCUTS.regenerate, () => emitToRenderer('shortcut:regenerate')],
    [SHORTCUTS.shorter, () => emitToRenderer('shortcut:follow-up', 'shorter')],
    [SHORTCUTS.deeper, () => emitToRenderer('shortcut:follow-up', 'deeper')],
    [SHORTCUTS.withCode, () => emitToRenderer('shortcut:follow-up', 'with code')]
  ];

  for (const [accelerator, handler] of bindings) {
    if (!globalShortcut.register(accelerator, handler)) {
      console.warn(`Failed to register shortcut: ${accelerator}`);
    }
  }
}

function createOverlayWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  overlayWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: MIN_HEIGHT, // resized to fit the content once rendered
    minWidth: WINDOW_WIDTH,
    minHeight: MIN_HEIGHT,
    x: workArea.x + Math.round((workArea.width - WINDOW_WIDTH) / 2),
    y: workArea.y + 12,
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
      preload: path.join(__dirname, '..', 'preload.js')
    }
  });

  overlayWindow.setMenuBarVisibility(false);
  overlayWindow.setOpacity(currentOpacity);
  keepOnTop(overlayWindow);

  if (process.env.VITE_DEV_SERVER_URL) {
    overlayWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    overlayWindow.loadFile(path.join(__dirname, '..', 'dist-vue', 'index.html'));
  }

  overlayWindow.webContents.on('did-finish-load', () => {
    emitWindowState();
    if (!app.isPackaged) overlayWindow.webContents.openDevTools({ mode: 'detach' });
  });

  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show();
    // Calls SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) on Windows 10 2004+
    overlayWindow.setContentProtection(true);
  });

  for (const eventName of ['show', 'restore']) {
    overlayWindow.on(eventName, () => {
      keepOnTop(overlayWindow);
      emitWindowState();
    });
  }

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

module.exports = { createOverlayWindow, emitToRenderer, registerShortcuts, resizeHeight };
