// Persistência simples em JSON (data/db.json). Escritas são serializadas
// e feitas de forma atômica (write em tmp + rename).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const DB_FILE = path.join(config.DATA_DIR, 'db.json');

const DEFAULTS = {
  videos: [],   // { id, name, filename, size, duration, createdAt }
  channels: [], // { id, name, key, videoIds, shuffle, mode, resolution, videoBitrate, audioBitrate, fps, autostart }
  relays: [],   // { id, name, key, sourceUrl, mode, loop, autostart }
  inputs: [],   // { id, name, key, createdAt }  -> entradas ao vivo (OBS etc.)
  settings: {}
};

let state = null;
let writeQueue = Promise.resolve();

function load() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    state = Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch {
    state = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return state;
}

function get() {
  if (!state) load();
  return state;
}

function save() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(() => new Promise((resolve) => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, snapshot, (err) => {
      if (err) { console.error('[db] erro ao salvar:', err.message); return resolve(); }
      fs.rename(tmp, DB_FILE, (err2) => {
        if (err2) console.error('[db] erro ao salvar:', err2.message);
        resolve();
      });
    });
  }));
  return writeQueue;
}

function id() {
  return crypto.randomBytes(8).toString('hex');
}

function streamKey() {
  return crypto.randomBytes(12).toString('hex');
}

module.exports = { get, save, id, streamKey, DB_FILE };
