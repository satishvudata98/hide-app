'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

// jd.txt and resume.txt live next to the app: the project folder in dev,
// the folder containing the exe when packaged.
function getContextDir() {
  if (!app.isPackaged) return path.join(__dirname, '..');
  // The portable build runs from a temp extraction folder; this env var points
  // at the folder the user actually launched the exe from.
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
}

const cache = new Map(); // fileName → { mtimeMs, text }

function readContextFile(fileName) {
  const filePath = path.join(getContextDir(), fileName);
  try {
    const { mtimeMs } = fs.statSync(filePath);
    const cached = cache.get(fileName);
    if (cached && cached.mtimeMs === mtimeMs) return cached.text;
    const text = fs.readFileSync(filePath, 'utf8').trim();
    cache.set(fileName, { mtimeMs, text });
    return text;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[context] failed to read ${fileName}:`, error.message);
    cache.delete(fileName);
    return '';
  }
}

function getContext() {
  return { jd: readContextFile('jd.txt'), resume: readContextFile('resume.txt') };
}

function getContextStatus() {
  const { jd, resume } = getContext();
  return { dir: getContextDir(), hasJd: !!jd, hasResume: !!resume };
}

module.exports = { getContext, getContextStatus };
