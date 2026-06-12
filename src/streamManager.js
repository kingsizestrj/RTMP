// Gerencia processos FFmpeg: canais (playlist em loop) e relays (HTTP -> RTMP).
// Cada stream ativo tem auto-restart com backoff exponencial, watchdog de
// travamento (reinicia se o ffmpeg parar de produzir frames), estatísticas em
// tempo real (velocidade/fps/bitrate via -progress) e guarda as últimas linhas
// de log para exibição no painel.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const db = require('./db');
const rtmpServer = require('./rtmpServer');

const LOG_LINES = 60;
const MAX_BACKOFF_MS = 30000;
const WATCHDOG_INTERVAL_MS = 5000;

// id -> { proc, type, status, startedAt, restarts, backoff, logs[], stopping,
//         retryTimer, watchdog, lastProgressAt, stats }
const running = new Map();

// Preserva os logs entre paradas/reinícios (a entrada do mapa é recriada)
const lastLogs = new Map();

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

// Bloco da grade ativo para o canal neste momento (horário local do servidor;
// defina TZ no ambiente para o fuso correto).
function currentBlock(channel, now) {
  const d = now || new Date();
  const day = d.getDay();
  const mins = d.getHours() * 60 + d.getMinutes();
  for (const b of channel.schedule || []) {
    const [sh, sm] = b.start.split(':').map(Number);
    const [eh, em] = b.end.split(':').map(Number);
    if ((b.days || []).includes(day) && mins >= sh * 60 + sm && mins < eh * 60 + em) return b;
  }
  return null;
}

function playlistIds(playlistId) {
  const pl = db.get().playlists.find((p) => p.id === playlistId);
  return pl ? (pl.videoIds || []).slice() : [];
}

// Resolve ids -> vídeos utilizáveis pelo canal (no modo "normalized" só os
// que já terminaram de normalizar).
function selectEntries(channel, ids) {
  const byId = new Map(db.get().videos.map((v) => [v.id, v]));
  let entries = ids.map((vid) => byId.get(vid)).filter(Boolean);
  if (channel.mode === 'normalized') {
    entries = entries.filter((v) => v.normalized && v.normalized.status === 'ready');
  }
  return entries;
}

// Gera o arquivo de concat do ffmpeg: playlist do bloco da grade ativo (ou a
// padrão), com embaralhamento opcional e vinhetas intercaladas a cada N
// vídeos. Registra no entry a ordem de reprodução (para o "agora exibindo")
// e a assinatura da fonte (para o agendador detectar trocas de bloco).
function buildConcatFile(channel, entry) {
  const block = currentBlock(channel);
  let source = block ? `block:${block.id}` : 'default';
  let entries = selectEntries(channel, playlistIds(block ? block.playlistId : channel.defaultPlaylistId));
  if (block && entries.length === 0) {
    // Bloco sem vídeos utilizáveis: cai para a playlist padrão
    entries = selectEntries(channel, playlistIds(channel.defaultPlaylistId));
    source = `fallback:${block.id}`;
  }
  if (channel.shuffle) entries = shuffleArray(entries);

  // Vinhetas/comerciais a cada N vídeos de conteúdo
  const breaks = selectEntries(channel, channel.breakVideoIds || []);
  if (breaks.length > 0 && channel.breakEvery > 0 && entries.length > 0) {
    const woven = [];
    entries.forEach((v, i) => {
      woven.push(v);
      if ((i + 1) % channel.breakEvery === 0) woven.push(...breaks);
    });
    entries = woven;
  }

  if (entries.length === 0) return null;

  const lines = ['ffconcat version 1.0'];
  for (const v of entries) {
    const file = channel.mode === 'normalized'
      ? path.join(config.NORMALIZED_DIR, v.normalized.filename)
      : path.join(config.UPLOAD_DIR, v.filename);
    // Escapa aspas simples para o formato do concat demuxer
    lines.push(`file '${file.replace(/'/g, "'\\''")}'`);
  }
  const listPath = path.join(config.DATA_DIR, `playlist-${channel.id}.txt`);
  fs.writeFileSync(listPath, lines.join('\n') + '\n');

  if (entry) {
    entry.sourceKind = 'playlist';
    entry.sourceSig = source;
    entry.playOrder = entries.map((v) => ({
      id: v.id, name: v.name, duration: v.durationSec || v.duration || 0
    }));
  }
  return listPath;
}

const PRESETS = new Set(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium']);

function transcodeArgs(opts) {
  const res = opts.resolution || '1280x720';
  const [w, h] = res.split('x').map(Number);
  const vb = opts.videoBitrate || '2500k';
  const ab = opts.audioBitrate || '128k';
  const fps = opts.fps || 30;
  const preset = PRESETS.has(opts.preset) ? opts.preset : 'veryfast';
  const bufsize = parseInt(vb, 10) * 2 + 'k';
  const args = [
    '-c:v', 'libx264',
    '-preset', preset,
    '-b:v', vb,
    '-maxrate', vb,
    '-bufsize', bufsize,
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-r', String(fps),
    '-g', String(fps * 2),
    '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', ab,
    '-ar', '44100',
    '-ac', '2'
  ];
  if (config.FFMPEG_THREADS) args.push('-threads', config.FFMPEG_THREADS);
  return args;
}

function outputArgs(key) {
  return ['-f', 'flv', '-flvflags', 'no_duration_filesize', rtmpUrlFor(key)];
}

function buildChannelArgs(channel, entry) {
  // Fallback de live: se a entrada ao vivo vinculada estiver publicando,
  // o canal retransmite a live em vez da playlist.
  const liveInput = channel.liveInputId
    ? db.get().inputs.find((i) => i.id === channel.liveInputId)
    : null;
  if (liveInput && rtmpServer.isKeyLive(liveInput.key)) {
    if (entry) {
      entry.sourceKind = 'live';
      entry.sourceSig = `live:${liveInput.key}`;
      entry.playOrder = null;
    }
    const liveArgs = [
      '-hide_banner', '-loglevel', 'warning',
      '-nostats', '-progress', 'pipe:1',
      '-i', `rtmp://127.0.0.1:${config.RTMP_PORT}/live/${liveInput.key}`
    ];
    if (channel.mode === 'transcode') liveArgs.push(...transcodeArgs(channel));
    else liveArgs.push('-c', 'copy');
    liveArgs.push(...outputArgs(channel.key));
    return liveArgs;
  }

  const listPath = buildConcatFile(channel, entry);
  if (!listPath) return null;
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-nostats', '-progress', 'pipe:1',
    '-re',
    '-fflags', '+genpts',
    '-stream_loop', '-1',
    '-f', 'concat', '-safe', '0',
    '-i', listPath
  ];
  if (channel.mode === 'normalized') {
    // Arquivos pré-normalizados (MPEG-TS uniforme): cópia direta, CPU ~zero.
    // O bsf converte o AAC de ADTS (TS) para o formato esperado pelo FLV.
    args.push('-c', 'copy', '-bsf:a', 'aac_adtstoasc');
  } else if (channel.mode === 'copy') {
    args.push('-c', 'copy');
  } else {
    args.push(...transcodeArgs(channel));
  }
  args.push(...outputArgs(channel.key));
  return args;
}

// Sites que precisam do yt-dlp para extrair a URL de mídia real.
function isYtdlpUrl(url) {
  return /(youtube\.com|youtu\.be|twitch\.tv|kick\.com|dailymotion\.com|vimeo\.com)/i.test(url || '');
}

// Flags comuns a toda chamada do yt-dlp.
function ytdlpBaseArgs() {
  const args = ['--no-playlist', '--no-warnings', '--socket-timeout', '30'];
  if (config.YTDLP_COOKIES) args.push('--cookies', config.YTDLP_COOKIES);
  return args;
}

// Pergunta ao yt-dlp se o link é uma transmissão ao vivo ou um vídeo (VOD).
function ytdlpIsLive(pageUrl) {
  return new Promise((resolve, reject) => {
    execFile(
      config.YTDLP_PATH,
      [...ytdlpBaseArgs(), '--print', 'is_live', pageUrl],
      { timeout: 60000, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const reason = (stderr || err.message).trim().split('\n').pop() || 'falha desconhecida';
          return reject(new Error(`yt-dlp: ${reason}`));
        }
        resolve(stdout.trim().split('\n')[0] === 'True');
      }
    );
  });
}

// Baixa um VOD do YouTube uma única vez para o cache local. Streaming de URL
// resolvida direto no ffmpeg leva 403 (o YouTube amarra a URL ao cliente que
// resolveu o desafio anti-bot) — quem baixa precisa ser o próprio yt-dlp.
// O arquivo em cache também elimina re-downloads a cada loop/restart.
function ensureVodCached(relay, entry) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(config.CACHE_DIR, { recursive: true });
    const hash = require('crypto').createHash('md5').update(relay.sourceUrl).digest('hex').slice(0, 10);
    const file = path.join(config.CACHE_DIR, `${relay.id}-${hash}.mp4`);
    if (fs.existsSync(file)) return resolve(file);

    // URL do relay mudou: descarta o cache da URL antiga
    for (const f of fs.readdirSync(config.CACHE_DIR)) {
      if (f.startsWith(relay.id + '-')) fs.unlink(path.join(config.CACHE_DIR, f), () => {});
    }

    entry.status = 'downloading';
    pushLog(entry, 'Baixando vídeo com yt-dlp (apenas na primeira vez)...');
    let proc;
    try {
      proc = spawn(config.YTDLP_PATH, [
        ...ytdlpBaseArgs(), '--no-progress',
        '-f', config.YTDLP_FORMAT, '--merge-output-format', 'mp4',
        '-o', file, relay.sourceUrl
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      return reject(new Error(`yt-dlp: ${err.message}`));
    }
    entry.helper = proc;
    // Download em prioridade baixa, como a normalização
    try { os.setPriority(proc.pid, 10); } catch {}

    let tail = '';
    proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-600); });
    proc.on('error', (err) => {
      entry.helper = null;
      reject(new Error(`yt-dlp: ${err.message} (yt-dlp instalado?)`));
    });
    proc.on('exit', (code) => {
      entry.helper = null;
      if (code === 0 && fs.existsSync(file)) {
        pushLog(entry, 'Download concluído — usando o cache local daqui em diante.');
        return resolve(file);
      }
      reject(new Error(`yt-dlp: ${tail.trim().split('\n').pop() || `download falhou (code=${code})`}`));
    });
  });
}

function httpInputFlags() {
  return [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '10',
    // Derruba conexões mortas em 15s; o auto-restart religa em seguida
    '-rw_timeout', '15000000'
  ];
}

// Monta o plano de execução do relay: { args } ou { args, helper } quando o
// yt-dlp alimenta o ffmpeg via pipe (lives).
async function buildRelayArgs(relay, entry) {
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-nostats', '-progress', 'pipe:1'
  ];
  let helper = null;

  if (relay.ytdlp) {
    const isLive = await ytdlpIsLive(relay.sourceUrl);
    // "Somente ao vivo": para URLs permanentes tipo youtube.com/@canal/live —
    // se não há live agora (ou a URL caiu no VOD do jogo encerrado), aguarda
    // e tenta de novo em vez de baixar o VOD. O backoff (máx. 30s) vira um
    // vigia: quando a próxima live começar, o relay engata sozinho.
    if (relay.liveOnly && !isLive) {
      throw new Error('fonte não está ao vivo agora — aguardando a próxima live');
    }
    if (isLive) {
      // Live: o yt-dlp baixa o stream (com toda a lógica de headers/anti-bot)
      // e entrega ao ffmpeg pela entrada padrão.
      args.push('-i', 'pipe:0');
      helper = {
        cmd: config.YTDLP_PATH,
        args: [
          ...ytdlpBaseArgs(), '--no-progress',
          '-f', config.YTDLP_LIVE_FORMAT, '-o', '-', relay.sourceUrl
        ]
      };
    } else {
      // VOD: baixa uma única vez para o cache e transmite o arquivo local.
      const file = await ensureVodCached(relay, entry);
      args.push('-re');
      if (relay.loop) args.push('-stream_loop', '-1');
      args.push('-i', file);
    }
  } else {
    // Para fontes VOD (arquivo http) usamos -re para ritmo de tempo real;
    // -stream_loop -1 repete a fonte indefinidamente quando "loop" está ativo.
    if (relay.loop) args.push('-re', '-stream_loop', '-1');
    if (/^https?:\/\//i.test(relay.sourceUrl)) {
      args.push(...httpInputFlags());
    } else if (/^rtsp:\/\//i.test(relay.sourceUrl)) {
      // TCP evita perda de pacotes (vídeo picotado) comum no RTSP via UDP
      args.push('-rtsp_transport', 'tcp');
    }
    args.push('-i', relay.sourceUrl);
  }

  if (relay.mode === 'transcode') {
    args.push(...transcodeArgs(relay));
  } else {
    args.push('-c', 'copy');
  }
  args.push(...outputArgs(relay.key));
  return { args, helper };
}

// Consome as linhas key=value do -progress (stdout) e atualiza as estatísticas
// usadas pelo watchdog e pelo painel.
function handleProgress(entry, chunk) {
  for (const line of chunk.toString().split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === 'speed' && value !== 'N/A') entry.stats.speed = parseFloat(value) || null;
    else if (key === 'fps' && value !== 'N/A') entry.stats.fps = Math.round(parseFloat(value)) || null;
    else if (key === 'bitrate' && value !== 'N/A') entry.stats.bitrate = value;
    else if (key === 'out_time_ms' && value !== 'N/A') entry.stats.outTimeSec = Math.floor(parseInt(value, 10) / 1e6);
    else if (key === 'progress') entry.lastProgressAt = Date.now();
  }
}

function startWatchdog(id, entry) {
  if (config.STALL_TIMEOUT_SEC <= 0) return;
  stopWatchdog(entry);
  entry.watchdog = setInterval(() => {
    if (entry.status !== 'running' || !entry.proc) return;
    const silentMs = Date.now() - entry.lastProgressAt;
    if (silentMs > config.STALL_TIMEOUT_SEC * 1000) {
      pushLog(entry, `Watchdog: sem progresso há ${Math.round(silentMs / 1000)}s — reiniciando ffmpeg travado`);
      // SIGKILL: processo possivelmente congelado não responde a SIGTERM.
      // O handler de exit cuida do restart automático.
      try { entry.proc.kill('SIGKILL'); } catch {}
    }
  }, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog(entry) {
  if (entry.watchdog) {
    clearInterval(entry.watchdog);
    entry.watchdog = null;
  }
}

// Agenda nova tentativa com backoff exponencial (queda do ffmpeg ou falha
// ao resolver a origem).
function scheduleRetry(entry, id, type, buildArgs, getItem) {
  entry.status = 'restarting';
  entry.restarts += 1;
  const wait = entry.backoff;
  entry.backoff = Math.min(entry.backoff * 2, MAX_BACKOFF_MS);
  pushLog(entry, `Nova tentativa em ${Math.round(wait / 1000)}s...`);
  entry.retryTimer = setTimeout(() => {
    if (!entry.stopping) spawnStream(id, type, buildArgs, getItem);
  }, wait);
}

async function spawnStream(id, type, buildArgs, getItem) {
  const existing = running.get(id);
  const entry = existing || {
    proc: null, helper: null, type, status: 'starting', startedAt: null,
    restarts: 0, backoff: 1000, logs: lastLogs.get(id) || [], stopping: false,
    retryTimer: null, watchdog: null, lastProgressAt: 0, stats: {}
  };
  entry.type = type;
  entry.status = 'starting';
  entry.stopping = false;
  running.set(id, entry);

  // Start manual durante a espera do retry: cancela o timer e tenta agora
  if (entry.retryTimer) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }
  // Start duplicado (clique duplo etc.): já existe um ffmpeg vivo para este
  // stream — abrir outro publicaria na mesma chave, o RTMP rejeitaria o novo
  // e o antigo viraria órfão segurando a chave. Ignora.
  if (entry.proc) {
    pushLog(entry, 'Start ignorado: o stream já está em execução.');
    entry.status = 'running';
    return;
  }

  const item = getItem();
  if (!item) { stopWatchdog(entry); running.delete(id); return; }

  let plan;
  try {
    // Pode envolver rede/disco (yt-dlp consulta ou baixa a origem)
    plan = await buildArgs(item, entry);
  } catch (err) {
    pushLog(entry, `Erro ao preparar origem: ${err.message}`);
    if (!entry.stopping) scheduleRetry(entry, id, type, buildArgs, getItem);
    return;
  }
  // O usuário pode ter parado o stream enquanto a origem era preparada
  if (entry.stopping) {
    entry.status = 'stopped';
    running.delete(id);
    return;
  }
  if (Array.isArray(plan)) plan = { args: plan, helper: null };
  if (!plan) {
    entry.status = 'error';
    pushLog(entry, item.mode === 'normalized'
      ? 'Nenhum vídeo normalizado pronto — aguarde a normalização concluir (aba Vídeos).'
      : 'Playlist vazia — adicione vídeos ao canal antes de iniciar.');
    return;
  }
  const args = plan.args;

  pushLog(entry, `Iniciando: ${config.FFMPEG_PATH} ${args.join(' ')}`);
  let proc;
  try {
    proc = spawn(config.FFMPEG_PATH, args, {
      stdio: [plan.helper ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    entry.status = 'error';
    pushLog(entry, `Falha ao iniciar ffmpeg: ${err.message}`);
    return;
  }

  // Processo auxiliar (yt-dlp) alimentando o ffmpeg via pipe
  if (plan.helper) {
    pushLog(entry, `Origem via ${plan.helper.cmd} ${plan.helper.args.join(' ')}`);
    let helper = null;
    try {
      helper = spawn(plan.helper.cmd, plan.helper.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      pushLog(entry, `Falha ao iniciar yt-dlp: ${err.message}`);
    }
    if (helper) {
      entry.helper = helper;
      try { os.setPriority(helper.pid, -5); } catch {}
      proc.stdin.on('error', () => {});           // ffmpeg pode sair primeiro (EPIPE)
      helper.stdout.pipe(proc.stdin);
      helper.stderr.on('data', (d) => pushLog(entry, d));
      helper.on('error', (err) => pushLog(entry, `yt-dlp: ${err.message} (yt-dlp instalado?)`));
      helper.on('exit', (code) => {
        if (entry.helper === helper) entry.helper = null;
        // EOF no stdin encerra o ffmpeg; o auto-restart reconecta (ex.: live caiu)
        pushLog(entry, `yt-dlp encerrou (code=${code})`);
      });
    } else {
      try { proc.kill('SIGKILL'); } catch {}
    }
  }

  entry.proc = proc;
  entry.status = 'running';
  entry.startedAt = Date.now();
  entry.lastProgressAt = Date.now();
  entry.stats = {};

  // Prioridade acima do normal: streaming não pode disputar CPU de igual
  // para igual com normalização e outras tarefas (ignorado sem permissão).
  try { os.setPriority(proc.pid, -5); } catch {}

  proc.stdout.on('data', (d) => handleProgress(entry, d));
  proc.stderr.on('data', (d) => pushLog(entry, d));
  startWatchdog(id, entry);

  proc.on('error', (err) => {
    entry.status = 'error';
    pushLog(entry, `Erro do processo: ${err.message} (ffmpeg instalado?)`);
  });

  proc.on('exit', (code, signal) => {
    entry.proc = null;
    entry.stats = {};
    stopWatchdog(entry);
    if (entry.helper) {
      try { entry.helper.kill('SIGKILL'); } catch {}
      entry.helper = null;
    }
    pushLog(entry, `ffmpeg encerrou (code=${code} signal=${signal || '-'})`);
    if (entry.stopping) {
      entry.status = 'stopped';
      lastLogs.set(id, entry.logs);
      running.delete(id);
      return;
    }
    // Auto-restart com backoff. Se rodou por um bom tempo, zera o backoff.
    const ranMs = Date.now() - entry.startedAt;
    if (ranMs > 60000) entry.backoff = 1000;
    scheduleRetry(entry, id, type, buildArgs, getItem);
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
  stopWatchdog(entry);
  if (entry.helper) {
    try { entry.helper.kill('SIGKILL'); } catch {}
    entry.helper = null;
  }
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
  const entry = running.get(id);
  if (!entry || entry.stopping) return;
  stop(id);
  // Espera o processo antigo morrer de verdade antes de religar: se o novo
  // ffmpeg subir com a chave ainda publicada, o RTMP o rejeita (I/O error).
  // O stop força SIGKILL em 5s, então o polling cobre com folga.
  const tryStart = (attemptsLeft) => {
    const old = running.get(id);
    if (old && old.proc) {
      if (attemptsLeft > 0) setTimeout(() => tryStart(attemptsLeft - 1), 500);
      return;
    }
    if (type === 'channel') startChannel(id);
    else startRelay(id);
  };
  setTimeout(() => tryStart(14), 800);
}

// Calcula o vídeo no ar e o próximo a partir da posição do ffmpeg (outTime)
// dentro do ciclo da playlist — sem precisar de processo extra.
function nowPlayingOf(entry) {
  if (!entry || entry.sourceKind !== 'playlist' || !entry.playOrder) return null;
  const order = entry.playOrder;
  const out = entry.stats ? entry.stats.outTimeSec : null;
  if (out == null || order.length === 0) return null;
  const total = order.reduce((s, v) => s + (v.duration || 0), 0);
  if (total <= 0) return null;
  let pos = out % total;
  for (let i = 0; i < order.length; i++) {
    if (pos < (order[i].duration || 0)) {
      return {
        now: { id: order[i].id, name: order[i].name },
        next: { id: order[(i + 1) % order.length].id, name: order[(i + 1) % order.length].name }
      };
    }
    pos -= order[i].duration || 0;
  }
  return null;
}

function statusOf(id) {
  const entry = running.get(id);
  if (!entry) {
    return {
      status: 'stopped', restarts: 0, uptime: 0, stats: {},
      sourceKind: null, nowPlaying: null, upNext: null,
      logs: (lastLogs.get(id) || []).slice(-LOG_LINES)
    };
  }
  const np = nowPlayingOf(entry);
  return {
    status: entry.status,
    restarts: entry.restarts,
    uptime: entry.startedAt && entry.status === 'running' ? Date.now() - entry.startedAt : 0,
    stats: entry.stats || {},
    sourceKind: entry.status === 'running' ? (entry.sourceKind || null) : null,
    nowPlaying: np ? np.now : null,
    upNext: np ? np.next : null,
    logs: entry.logs.slice(-LOG_LINES)
  };
}

function isRunning(id) {
  const entry = running.get(id);
  return !!entry && ['running', 'restarting', 'starting', 'downloading'].includes(entry.status);
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

// ---------------------------------------------------------------------------
// Agendador da grade: confere a cada 20s se algum canal no ar precisa trocar
// de fonte (entrou/saiu um bloco da grade, ou a live vinculada ligou/desligou)
// e reinicia o ffmpeg para reconstruir o conteúdo.
// ---------------------------------------------------------------------------

function desiredSourceSig(channel) {
  const liveInput = channel.liveInputId
    ? db.get().inputs.find((i) => i.id === channel.liveInputId)
    : null;
  if (liveInput && rtmpServer.isKeyLive(liveInput.key)) return `live:${liveInput.key}`;
  const block = currentBlock(channel);
  return block ? `block:${block.id}` : 'default';
}

function checkChannelSource(channel, reason) {
  const entry = running.get(channel.id);
  if (!entry || entry.type !== 'channel' || entry.status !== 'running') return;
  const desired = desiredSourceSig(channel);
  if (entry.sourceSig === desired) return;
  // 'fallback:<block>' significa que o bloco estava sem vídeos utilizáveis e
  // a playlist padrão assumiu — não fica reiniciando em loop por causa disso.
  if (desired.startsWith('block:') && entry.sourceSig === `fallback:${desired.slice(6)}`) return;
  pushLog(entry, `Trocando fonte (${reason}): ${entry.sourceSig || '?'} -> ${desired}`);
  restartIfRunning(channel.id, 'channel');
}

setInterval(() => {
  for (const c of db.get().channels) {
    try { checkChannelSource(c, 'grade'); } catch (e) { console.error('[agendador]', e.message); }
  }
}, 20000);

// Live vinculada ligou/desligou: reage na hora, sem esperar o tick
function handleLiveEdge(key) {
  const state = db.get();
  for (const c of state.channels) {
    if (!c.liveInputId) continue;
    const input = state.inputs.find((i) => i.id === c.liveInputId);
    if (input && input.key === key) checkChannelSource(c, 'entrada ao vivo');
  }
}
rtmpServer.events.on('publish', handleLiveEdge);
rtmpServer.events.on('unpublish', handleLiveEdge);

module.exports = {
  startChannel, startRelay, stop, restartIfRunning,
  statusOf, isRunning, autostartAll, shutdown, isYtdlpUrl
};
