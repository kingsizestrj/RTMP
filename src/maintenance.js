// Manutenção: mantém o yt-dlp atualizado (o YouTube quebra os extratores com
// frequência) e cuida do disco (uso por pasta, limpeza de cache e de arquivos
// órfãos). A limpeza de órfãos é conservadora: nunca apaga arquivo referenciado
// no banco nem recém-criado (download/normalização em curso).
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');

const ytdlp = { version: null, lastUpdate: null, lastResult: null, updating: false };

function getVersion() {
  return new Promise((resolve) => {
    execFile(config.YTDLP_PATH, ['--version'], { timeout: 15000 }, (err, out) => {
      if (!err) ytdlp.version = String(out).trim();
      resolve(ytdlp.version);
    });
  });
}

// Auto-update via binário do yt-dlp (yt-dlp -U). Em instalações por pip falha,
// e o erro é apenas reportado (não quebra nada).
function update() {
  return new Promise((resolve) => {
    if (ytdlp.updating) return resolve({ ok: false, message: 'Atualização já em andamento' });
    ytdlp.updating = true;
    execFile(config.YTDLP_PATH, ['-U'], { timeout: 120000, maxBuffer: 1024 * 1024 }, async (err, out, errout) => {
      ytdlp.updating = false;
      ytdlp.lastUpdate = new Date().toISOString();
      const text = `${out || ''}${errout || ''}`.trim();
      const lastLine = text.split('\n').filter(Boolean).pop() || (err ? err.message : 'atualizado');
      ytdlp.lastResult = (err ? 'erro: ' : '') + lastLine;
      console.log('[yt-dlp update]', ytdlp.lastResult);
      await getVersion();
      resolve({ ok: !err, message: ytdlp.lastResult, version: ytdlp.version });
    });
  });
}

function ytdlpInfo() {
  return { version: ytdlp.version, lastUpdate: ytdlp.lastUpdate, lastResult: ytdlp.lastResult, updating: ytdlp.updating, auto: config.YTDLP_AUTO_UPDATE };
}

// ---- disco ----

function dirSize(dir) {
  let bytes = 0; let count = 0;
  let files;
  try { files = fs.readdirSync(dir); } catch { return { bytes: 0, count: 0 }; }
  for (const f of files) {
    try { const st = fs.statSync(path.join(dir, f)); if (st.isFile()) { bytes += st.size; count += 1; } } catch {}
  }
  return { bytes, count };
}

function diskInfo() {
  try {
    const st = fs.statfsSync(config.DATA_DIR);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { totalBytes: total, freeBytes: free, usedPct: total ? Math.round((1 - free / total) * 100) : 0 };
  } catch {
    return { totalBytes: 0, freeBytes: 0, usedPct: 0 };
  }
}

function storage() {
  return {
    disk: diskInfo(),
    uploads: dirSize(config.UPLOAD_DIR),
    normalized: dirSize(config.NORMALIZED_DIR),
    cache: dirSize(config.CACHE_DIR)
  };
}

// Esvazia o cache de VOD do YouTube (será rebaixado sob demanda).
function cleanCache() {
  let bytes = 0; let count = 0;
  let files;
  try { files = fs.readdirSync(config.CACHE_DIR); } catch { return { bytes, count }; }
  for (const f of files) {
    try { const p = path.join(config.CACHE_DIR, f); const st = fs.statSync(p); fs.unlinkSync(p); bytes += st.size; count += 1; } catch {}
  }
  return { bytes, count };
}

// Remove arquivos não referenciados no banco (uploads/normalized) e os
// playlist-*.txt de canais que não existem mais. Pula arquivos recentes (< 10
// min) para não pegar downloads/normalizações em andamento.
function cleanOrphans() {
  const RECENT_MS = 10 * 60 * 1000;
  const now = Date.now();
  const state = db.get();
  const uploadRef = new Set(state.videos.map((v) => v.filename).filter(Boolean));
  const normRef = new Set(state.videos.map((v) => v.normalized && v.normalized.filename).filter(Boolean));
  const channelIds = new Set(state.channels.map((c) => c.id));
  let bytes = 0; let count = 0;

  const sweep = (dir, refSet) => {
    let files;
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const f of files) {
      const p = path.join(dir, f);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      if (now - st.mtimeMs < RECENT_MS) continue;          // em andamento
      if (!f.endsWith('.tmp') && refSet.has(f)) continue;  // referenciado (.tmp sempre é lixo)
      try { fs.unlinkSync(p); bytes += st.size; count += 1; } catch {}
    }
  };
  sweep(config.UPLOAD_DIR, uploadRef);
  sweep(config.NORMALIZED_DIR, normRef);

  try {
    for (const f of fs.readdirSync(config.DATA_DIR)) {
      const m = f.match(/^playlist-(.+)\.txt$/);
      if (m && !channelIds.has(m[1])) {
        try { const p = path.join(config.DATA_DIR, f); const st = fs.statSync(p); fs.unlinkSync(p); bytes += st.size; count += 1; } catch {}
      }
    }
  } catch {}
  return { bytes, count };
}

function start() {
  getVersion();
  if (config.YTDLP_AUTO_UPDATE) {
    setTimeout(() => update(), 10000); // logo após o boot
    setInterval(() => update(), Math.max(1, config.YTDLP_UPDATE_INTERVAL_HOURS) * 3600 * 1000);
  }
  // Limpeza segura de órfãos no boot
  try {
    const r = cleanOrphans();
    if (r.count) console.log(`[maintenance] ${r.count} arquivo(s) órfão(s) removido(s) (${(r.bytes / 1e6).toFixed(1)} MB)`);
  } catch {}
}

module.exports = { getVersion, update, ytdlpInfo, diskInfo, storage, cleanCache, cleanOrphans, start };
