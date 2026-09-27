'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'screnshield-settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[settings] could not read settings:', error.message);
    return {};
  }
}

// Write to a temp file and rename, so a crash mid-write can't corrupt the file.
function writeSettings(updates) {
  const filePath = getSettingsPath();
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ ...readSettings(), ...updates }, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

module.exports = { readSettings, writeSettings };
