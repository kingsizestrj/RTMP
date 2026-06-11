// Gerencia processos FFmpeg: canais (playlist em loop) e relays (HTTP -> RTMP).
// Cada stream ativo tem auto-restart com backoff exponencial e guarda as
// últimas linhas de log do ffmpeg para exibição no painel.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');

const LOG_LINES = 60;
const MAX_BACKOFF_MS = 30000;

// id -> { proc, type, status, startedAt, restarts, backoff, logs[], stopping, retryTimer }
const running = new Map();

function rtmpUrlFor(key) {
  return `rtmp://127.0.0.1:${config.RTMP_PORT}/live/${key}`;
}

function pushLog(entry, line) {
  const text = line.toString().trim();
  if (!text) return;
  for (const l of text.split('\n')) {
    entry.logs.push(`[${new Date().toISOString()}] ${l}`);
    if (entry.logs.length > LOG_LINES) entry.logs.shift();
  }
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Gera o arquivo de concat do ffmpeg com os vídeos da playlist.
function buildConcatFile(channel) {
  const state = db.get();
  const byId = new Map(state.videos.map((v) => [v.id, v]));
  let ids = (channel.videoIds || []).filter((vid) => byId.has(vid));
  if (channel.shuffle) ids = shuffleArray(ids);
  if (ids.length === 0) return null;

  const lines = ['ffconcat version 1.0'];
  for (const vid of ids) {
    const file = path.join(config.UPLOAD_DIR, byId.get(vid).filename);
    // Escapa aspas simples para o formato do concat demuxer
    lines.push(`file '${file.replace(/'/g, "'\\''")}'`);
  }
  const listPath = path.join(config.DATA_DIR, `playlist-${channel.id}.txt`);
  fs.writeFileSync(listPath, lines.join('\n') + '\n');
  return listPath;
}

function transcodeArgs(opts) {
  const res = opts.resolution || '1280x720';
  const [w, h] = res.split('x').map(Number);
  const vb = opts.videoBitrate || '2500k';
  const ab = opts.audioBitrate || '128k';
  const fps = opts.fps || 30;
  const bufsize = parseInt(vb, 10) * 2 + 'k';
  return [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', vb,
    '-maxrate', vb,
    '-bufsize', bufsize,
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-r', String(fps),
    '-g', String(fps * 2),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', ab,
    '-ar', '44100',
    '-ac', '2'
  ];
}

function buildChannelArgs(channel) {
  const listPath = buildConcatFile(channel);
  if (!listPath) return null;
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-re',
    '-fflags', '+genpts',
    '-stream_loop', '-1',
    '-f', 'concat', '-safe', '0',
    '-i', listPath
  ];
  if (channel.mode === 'copy') {
    args.push('-c', 'copy');
  } else {
    args.push(...transcodeArgs(channel));
  }
  args.push('-f', 'flv', rtmpUrlFor(channel.key));
  return args;
}

function buildRelayArgs(relay) {
  const args = ['-hide_banner', '-loglevel', 'warning'];
  // Para fontes VOD (arquivo http) usamos -re para ritmo de tempo real;
  // -stream_loop -1 repete a fonte indefinidamente quando "loop" está ativo.
  if (relay.loop) args.push('-re', '-stream_loop', '-1');
  args.push(
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '10',
    '-i', relay.sourceUrl
  );
  if (relay.mode === 'transcode') {
    args.push(...transcodeArgs(relay));
  } else {
    args.push('-c', 'copy');
  }
  args.push('-f', 'flv', rtmpUrlFor(relay.key));
  return args;
}

function spawnStream(id, type, buildArgs, getItem) {
  const existing = running.get(id);
  const entry = existing || {
    proc: null, type, status: 'starting', startedAt: null,
    restarts: 0, backoff: 1000, logs: [], stopping: false, retryTimer: null
  };
  entry.type = type;
  entry.stopping = false;
  running.set(id, entry);

  const item = getItem();
  if (!item) { running.delete(id); return; }

  let args;
  try {
    args = buildArgs(item);
  } catch (err) {
    entry.status = 'error';
    pushLog(entry, `Erro ao montar comando: ${err.message}`);
    return;
  }
  if (!args) {
    entry.status = 'error';
    pushLog(entry, 'Playlist vazia — adicione vídeos ao canal antes de iniciar.');
    return;
  }

  pushLog(entry, `Iniciando: ${config.FFMPEG_PATH} ${args.join(' ')}`);
  let proc;
  try {
    proc = spawn(config.FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    entry.status = 'error';
    pushLog(entry, `Falha ao iniciar ffmpeg: ${err.message}`);
    return;
  }

  entry.proc = proc;
  entry.status = 'running';
  entry.startedAt = Date.now();

  proc.stderr.on('data', (d) => pushLog(entry, d));

  proc.on('error', (err) => {
    entry.status = 'error';
    pushLog(entry, `Erro do processo: ${err.message} (ffmpeg instalado?)`);
  });

  proc.on('exit', (code, signal) => {
    entry.proc = null;
    pushLog(entry, `ffmpeg encerrou (code=${code} signal=${signal || '-'})`);
    if (entry.stopping) {
      entry.status = 'stopped';
      running.delete(id);
      return;
    }
    // Auto-restart com backoff. Se rodou por um bom tempo, zera o backoff.
    const ranMs = Date.now() - entry.startedAt;
    if (ranMs > 60000) entry.backoff = 1000;
    entry.status = 'restarting';
    entry.restarts += 1;
    const wait = entry.backoff;
    entry.backoff = Math.min(entry.backoff * 2, MAX_BACKOFF_MS);
    pushLog(entry, `Reiniciando em ${Math.round(wait / 1000)}s...`);
    entry.retryTimer = setTimeout(() => {
      if (!entry.stopping) spawnStream(id, type, buildArgs, getItem);
    }, wait);
  });
}

function startChannel(channelId) {
  const getItem = () => db.get().channels.find((c) => c.id === channelId);
  if (!getItem()) throw new Error('Canal não encontrado');
  spawnStream(channelId, 'channel', buildChannelArgs, getItem);
}

function startRelay(relayId) {
  const getItem = () => db.get().relays.find((r) => r.id === relayId);
  if (!getItem()) throw new Error('Relay não encontrado');
  spawnStream(relayId, 'relay', buildRelayArgs, getItem);
}

function stop(id) {
  const entry = running.get(id);
  if (!entry) return false;
  entry.stopping = true;
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  if (entry.proc) {
    entry.proc.kill('SIGTERM');
    const proc = entry.proc;
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
  } else {
    running.delete(id);
  }
  return true;
}

// Reinicia (ex.: playlist alterada) se estiver rodando.
function restartIfRunning(id, type) {
  if (!running.has(id)) return;
  const entry = running.get(id);
  const wasStopping = entry.stopping;
  stop(id);
  if (wasStopping) return;
  setTimeout(() => {
    if (type === 'channel') startChannel(id);
    else startRelay(id);
  }, 1500);
}

function statusOf(id) {
  const entry = running.get(id);
  if (!entry) return { status: 'stopped', restarts: 0, uptime: 0, logs: [] };
  return {
    status: entry.status,
    restarts: entry.restarts,
    uptime: entry.startedAt && entry.status === 'running' ? Date.now() - entry.startedAt : 0,
    logs: entry.logs.slice(-LOG_LINES)
  };
}

function isRunning(id) {
  const entry = running.get(id);
  return !!entry && (entry.status === 'running' || entry.status === 'restarting' || entry.status === 'starting');
}

// Sobe tudo que estava marcado como autostart.
function autostartAll() {
  const state = db.get();
  for (const c of state.channels) {
    if (c.autostart) {
      try { startChannel(c.id); } catch (e) { console.error('[autostart canal]', e.message); }
    }
  }
  for (const r of state.relays) {
    if (r.autostart) {
      try { startRelay(r.id); } catch (e) { console.error('[autostart relay]', e.message); }
    }
  }
}

function shutdown() {
  for (const id of running.keys()) stop(id);
}

module.exports = {
  startChannel, startRelay, stop, restartIfRunning,
  statusOf, isRunning, autostartAll, shutdown
};
