'use strict';

const { desktopCapturer, screen, session } = require('electron');

const MEDIA_PERMISSIONS = ['media', 'display-capture', 'audio-capture', 'microphone'];
const MAX_SCREENSHOT_SIDE = 2048;
const JPEG_QUALITY = 85; // ~5-10x smaller than PNG, which keeps vision requests fast

// Mic and system-audio capture are granted without prompting. getDisplayMedia()
// resolves to the whole screen plus loopback audio; the renderer drops the
// video track and keeps only the system audio.
function configureMediaPermissions() {
  const { defaultSession } = session;

  defaultSession.setPermissionCheckHandler((_webContents, permission) => MEDIA_PERMISSIONS.includes(permission));
  defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(MEDIA_PERMISSIONS.includes(permission));
  });

  defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      callback({ video: sources[0], audio: 'loopback' });
    } catch (error) {
      console.error('Display media request failed:', error);
      callback({});
    }
  }, { useSystemPicker: false });
}

// Screenshot of the display under the cursor, native aspect ratio, long side ≤ 2048px.
async function captureScreen() {
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const nativeWidth = display.size.width * display.scaleFactor;
    const nativeHeight = display.size.height * display.scaleFactor;
    const scale = Math.min(1, MAX_SCREENSHOT_SIDE / Math.max(nativeWidth, nativeHeight));

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(nativeWidth * scale), height: Math.round(nativeHeight * scale) }
    });
    if (!sources.length) return { error: 'No screen sources found.' };

    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    return { imageBase64: source.thumbnail.toJPEG(JPEG_QUALITY).toString('base64'), imageType: 'jpeg' };
  } catch (error) {
    return { error: error.message || 'Screen capture failed.' };
  }
}

module.exports = { configureMediaPermissions, captureScreen };
