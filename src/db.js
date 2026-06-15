// Persistência simples em JSON (data/db.json). Escritas são serializadas
// e feitas de forma atômica (write em tmp + rename).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const DB_FILE = path.join(config.DATA_DIR, 'db.json');

const DEFAULTS = {
  videos: [],    // { id, name, folder, filename, size, duration, durationSec, normalized, createdAt }
  playlists: [], // { id, name, videoIds, createdAt }
  channels: [],  // { id, name, key, defaultPlaylistId, schedule[], breakVideoIds, breakEvery, liveInputId, shuffle, mode, ... }
  relays: [],    // { id, name, key, sourceUrl, ytdlp, mode, loop, autostart }
  inputs: [],    // { id, name, key, createdAt }  -> entradas ao vivo (OBS etc.)
  campaigns: [], // { id, name, videoId, start, end, channelIds[], enabled } -> comerciais
  restreams: [], // { id, channelId, name, server, streamKey, enabled } -> multistream (YouTube etc.)
  settings: {}
};

// Migra bancos antigos: a playlist embutida do canal (videoIds) vira uma
// entidade Playlist referenciada por defaultPlaylistId.
function migrate(s) {
  let changed = false;
  for (const c of s.channels) {
    if (!c.defaultPlaylistId) {
      const pl = {
        id: id(),
        name: `${c.name} — padrão`,
        videoIds: Array.isArray(c.videoIds) ? c.videoIds : [],
        createdAt: new Date().toISOString()
      };
      s.playlists.push(pl);
      c.defaultPlaylistId = pl.id;
      changed = true;
    }
    if ('videoIds' in c) { delete c.videoIds; changed = true; }
    if (!Array.isArray(c.schedule)) { c.schedule = []; changed = true; }
    if (!Array.isArray(c.breakVideoIds)) { c.breakVideoIds = []; changed = true; }
    if (typeof c.breakEvery !== 'number') { c.breakEvery = 0; changed = true; }
    if (c.breakMode !== 'minutes' && c.breakMode !== 'count') { c.breakMode = 'count'; changed = true; }
    if (typeof c.breakEveryMin !== 'number') { c.breakEveryMin = 0; changed = true; }
    if (typeof c.liveInputId !== 'string') { c.liveInputId = ''; changed = true; }
    if (typeof c.logo !== 'boolean') { c.logo = false; changed = true; }
    if (typeof c.logoPosition !== 'string') { c.logoPosition = 'tr'; changed = true; }
    if (typeof c.seamless !== 'boolean') { c.seamless = false; changed = true; }
  }
  for (const p of s.playlists) {
    // Classificação indicativa do programa (''=sem; L,10,12,14,16,18)
    if (typeof p.rating !== 'string') { p.rating = ''; changed = true; }
  }
  for (const v of s.videos) {
    // Pasta de organização do acervo ('' = sem pasta)
    if (typeof v.folder !== 'string') { v.folder = ''; changed = true; }
  }
  return changed;
}

let state = null;
let writeQueue = Promise.resolve();

function load() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    state = Object.assign({}, JSON.parse(JSON.stringify(DEFAULTS)), JSON.parse(raw));
  } catch {
    state = JSON.parse(JSON.stringify(DEFAULTS));
  }
  if (migrate(state)) save();
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
