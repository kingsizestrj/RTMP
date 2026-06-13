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
const asrun = require('./asrun');

const LOG_LINES = 60;
const MAX_BACKOFF_MS = 30000;
const WATCHDOG_INTERVAL_MS = 5000;

// id -> { proc, type, status, startedAt, restarts, backoff, logs[], stopping,
//         retryTimer, watchdog, lastProgressAt, stats }
const running = new Map();

// Preserva os logs entre paradas/reinícios (a entrada do mapa é recriada)
const lastLogs = new Map();

// Mata o helper (yt-dlp) e TODA a sua árvore de processos. O yt-dlp cria um
// ffmpeg filho para baixar HLS; matar só o pai deixa o filho órfão baixando
// para sempre (vaza banda/CPU a cada restart). O helper é criado com
// detached:true (grupo de processos próprio) justamente para o kill(-pid).
function killHelper(entry) {
  const h = entry.helper;
  if (!h) return;
  entry.helper = null;
  // Solta os fds dos pipes: mesmo que algo sobreviva, leva EPIPE na hora
  try { if (h.stdout) h.stdout.destroy(); } catch {}
  try { if (h.stderr) h.stderr.destroy(); } catch {}
  try {
    process.kill(-h.pid, 'SIGKILL');
  } catch {
    try { h.kill('SIGKILL'); } catch {}
  }
}

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

function toMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

// Um bloco está ativo neste dia/minuto? Trata blocos que viram a meia-noite
// (fim <= início, ex.: 23:00→00:00 ou 23:00→02:00): valem da hora de início
// até a meia-noite no dia de início, e da meia-noite até o fim no dia seguinte.
// 'days' são os dias em que o bloco COMEÇA.
function blockActiveAt(b, day, mins) {
  const s = toMin(b.start);
  const e = toMin(b.end);
  const days = b.days || [];
  if (s < e) {
    return days.includes(day) && mins >= s && mins < e;
  }
  // cruza a meia-noite
  const prevDay = (day + 6) % 7;
  return (days.includes(day) && mins >= s) || (days.includes(prevDay) && mins < e);
}

// Bloco da grade ativo para o canal neste momento (horário local do servidor;
// defina TZ no ambiente para o fuso correto).
function currentBlock(channel, now) {
  const d = now || new Date();
  const day = d.getDay();
  const mins = d.getHours() * 60 + d.getMinutes();
  for (const b of channel.schedule || []) {
    if (blockActiveAt(b, day, mins)) return b;
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

// Comerciais ativos para o canal agora: campanhas habilitadas, dentro da
// janela de datas, direcionadas a este canal (lista vazia = todos), com o
// vídeo pronto. Devolve itens {v, kind:'ad', campaignId, name}.
function activeAds(channel) {
  const state = db.get();
  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map(state.videos.map((v) => [v.id, v]));
  const out = [];
  for (const c of state.campaigns || []) {
    if (!c.enabled) continue;
    if (c.start && today < c.start) continue;
    if (c.end && today > c.end) continue;
    if (Array.isArray(c.channelIds) && c.channelIds.length && !c.channelIds.includes(channel.id)) continue;
    const v = byId.get(c.videoId);
    if (!v) continue;
    if (channel.mode === 'normalized' && !(v.normalized && v.normalized.status === 'ready')) continue;
    out.push({ v, kind: 'ad', campaignId: c.id, name: c.name });
  }
  return out;
}

function wrapProgram(v) { return { v, kind: 'program', name: v.name }; }
function itemDur(it) { return it.v.durationSec || it.v.duration || 0; }

// Bloco de intervalo do canal = comerciais ativos + vinhetas fixas.
function breakItemsFor(channel) {
  return [
    ...activeAds(channel),
    ...selectEntries(channel, channel.breakVideoIds || []).map((v) => ({ v, kind: 'break', name: v.name }))
  ];
}

// Intercala os intervalos no conteúdo: por contagem (a cada N vídeos) ou por
// tempo (a cada N minutos de conteúdo acumulado).
function weave(channel, items, breakItems) {
  if (!breakItems.length || !items.length) return items;
  if (channel.breakMode === 'minutes' && channel.breakEveryMin > 0) {
    const threshold = channel.breakEveryMin * 60;
    const out = [];
    let acc = 0;
    for (const it of items) {
      out.push(it);
      acc += itemDur(it);
      if (acc >= threshold) { out.push(...breakItems); acc = 0; }
    }
    return out;
  }
  if (channel.breakEvery > 0) {
    const out = [];
    items.forEach((it, i) => {
      out.push(it);
      if ((i + 1) % channel.breakEvery === 0) out.push(...breakItems);
    });
    return out;
  }
  return items;
}

// Conteúdo (já com intervalos) de um bloco/playlist, embaralhado se for o caso.
function contentItemsFor(channel, playlistId, fallbackPlaylistId) {
  let content = selectEntries(channel, playlistIds(playlistId));
  if (content.length === 0 && fallbackPlaylistId) {
    content = selectEntries(channel, playlistIds(fallbackPlaylistId));
  }
  if (channel.shuffle) content = shuffleArray(content);
  return weave(channel, content.map(wrapProgram), breakItemsFor(channel));
}

// Escreve o arquivo de concat e registra no entry a ordem de reprodução.
function writeConcat(channel, items, entry, sourceSig) {
  if (!items || items.length === 0) return null;
  const lines = ['ffconcat version 1.0'];
  for (const { v } of items) {
    const file = channel.mode === 'normalized'
      ? path.join(config.NORMALIZED_DIR, v.normalized.filename)
      : path.join(config.UPLOAD_DIR, v.filename);
    lines.push(`file '${file.replace(/'/g, "'\\''")}'`);
  }
  const listPath = path.join(config.DATA_DIR, `playlist-${channel.id}.txt`);
  fs.writeFileSync(listPath, lines.join('\n') + '\n');
  if (entry) {
    entry.sourceKind = 'playlist';
    entry.sourceSig = sourceSig;
    entry.playOrder = items.map((it) => ({
      id: it.v.id, name: it.name, duration: itemDur(it),
      kind: it.kind, campaignId: it.campaignId || null
    }));
  }
  return listPath;
}

// Concat do bloco atual (ou playlist padrão), tocado em loop (-stream_loop -1).
// Usado quando a transição sem corte está desligada.
function buildConcatFile(channel, entry) {
  const block = currentBlock(channel);
  let sig = block ? `block:${block.id}` : 'default';
  const items = contentItemsFor(channel, block ? block.playlistId : channel.defaultPlaylistId, channel.defaultPlaylistId);
  // Se o bloco estava vazio e caímos na padrão, marca como fallback.
  if (block && selectEntries(channel, playlistIds(block.playlistId)).length === 0) sig = `fallback:${block.id}`;
  return writeConcat(channel, items, entry, sig);
}

// Transição sem corte (abordagem A): pré-computa a linha do tempo das próximas
// horas, encadeando os blocos da grade como arquivos consecutivos. O ffmpeg
// flui pela virada de bloco SEM reiniciar (concat demuxer toca os arquivos em
// sequência, sem buraco). A troca acontece na fronteira do programa (o vídeo
// em andamento termina antes), igual à transição suave. A lista é finita; ao
// terminar o horizonte, o ffmpeg encerra e o auto-restart regenera a partir do
// novo "agora" (único ponto com um pequeno corte, a cada SEAMLESS_HORIZON_SEC).
function buildSeamlessConcat(channel, entry) {
  const horizon = Math.max(600, config.SEAMLESS_HORIZON_SEC) * 1000;
  const start = Date.now();
  const cursor = new Date(start);
  const items = [];
  let curSig = null;
  let woven = [];
  let idx = 0;
  let guard = 0;
  const MAX_ITEMS = 200000;
  while (cursor.getTime() - start < horizon && items.length < MAX_ITEMS && guard++ < 500000) {
    const block = currentBlock(channel, cursor);
    const sig = block ? `b:${block.id}` : 'default';
    if (sig !== curSig) {
      curSig = sig;
      woven = contentItemsFor(channel, block ? block.playlistId : channel.defaultPlaylistId, channel.defaultPlaylistId);
      idx = 0;
    }
    if (woven.length === 0) { cursor.setTime(cursor.getTime() + 60000); continue; } // bloco vazio: pula 1 min
    const it = woven[idx % woven.length];
    idx += 1;
    const d = itemDur(it);
    if (d <= 0) { // sem duração: evita loop infinito
      if (idx % woven.length === 0) cursor.setTime(cursor.getTime() + 1000);
      continue;
    }
    items.push(it);
    cursor.setTime(cursor.getTime() + d * 1000);
  }
  return writeConcat(channel, items, entry, 'seamless');
}

function seamlessActive(channel) {
  return !!channel.seamless && (channel.schedule || []).length > 0;
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

// Só o codec de vídeo (sem áudio), para quando precisamos re-encodar o vídeo
// mas copiar o áudio (caso do overlay de logo sobre conteúdo já normalizado).
function x264VideoArgs(opts) {
  const vb = opts.videoBitrate || config.NORMALIZE_VIDEO_BITRATE;
  const fps = opts.fps || config.NORMALIZE_FPS;
  const preset = PRESETS.has(opts.preset) ? opts.preset : 'veryfast';
  const bufsize = parseInt(vb, 10) * 2 + 'k';
  const args = [
    '-c:v', 'libx264', '-preset', preset,
    '-b:v', vb, '-maxrate', vb, '-bufsize', bufsize,
    '-g', String(fps * 2), '-sc_threshold', '0', '-pix_fmt', 'yuv420p'
  ];
  if (config.FFMPEG_THREADS) args.push('-threads', config.FFMPEG_THREADS);
  return args;
}

const LOGO_POS = {
  tr: 'W-w-20:20', tl: '20:20', br: 'W-w-20:H-h-20', bl: '20:H-h-20'
};

function logoEnabled(channel) {
  return channel.logo && fs.existsSync(config.LOGO_PATH);
}

// Fonte para os textos sobrepostos (classificação indicativa).
const FONT_CANDIDATES = [
  config.FONT_PATH,
  '/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'
].filter(Boolean);
function findFont() {
  return FONT_CANDIDATES.find((f) => { try { return fs.existsSync(f); } catch { return false; } });
}

// Cores oficiais da classificação indicativa (ClassInd/BR).
const RATING_COLOR = { L: '0x009933', 10: '0x0a3bbf', 12: '0xf2c400', 14: '0xf07800', 16: '0xcc0000', 18: '0x000000' };

// Filtro drawtext do selo de classificação no canto superior esquerdo.
function ratingDraw(rating) {
  const font = findFont();
  if (!font || !RATING_COLOR[rating]) return null;
  const fontcolor = rating === '12' ? 'black' : 'white';
  return `drawtext=fontfile=${font}:text='${rating}':fontcolor=${fontcolor}:fontsize=34:` +
    `box=1:boxcolor=${RATING_COLOR[rating]}@0.9:boxborderw=14:x=24:y=24`;
}

// Saída que re-encoda o vídeo aplicando, em sequência: escala (modo transcode),
// overlay de logo e selo de classificação. Custa CPU (overlay exige re-encode),
// mas o áudio segue em cópia quando possível. audioMode: 'copy-ts' | 'copy' |
// 'encode'. Pressupõe que a fonte principal já é o input 0.
function encodedTail(channel, audioMode, rating) {
  const inputs = [];
  const fc = [];
  let cur = '[0:v]';
  let li = 0;
  const next = () => `[v${li++}]`;

  if (channel.mode === 'transcode') {
    const [w, h] = (channel.resolution || '1280x720').split('x').map(Number);
    const o = next();
    fc.push(`${cur}scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1${o}`);
    cur = o;
  }
  if (logoEnabled(channel)) {
    inputs.push('-i', config.LOGO_PATH); // input 1
    const o = next();
    fc.push(`${cur}[1:v]overlay=${LOGO_POS[channel.logoPosition] || LOGO_POS.tr}${o}`);
    cur = o;
  }
  const rd = rating ? ratingDraw(rating) : null;
  if (rd) {
    const o = next();
    fc.push(`${cur}${rd}${o}`);
    cur = o;
  }
  if (fc.length === 0) return null; // nada para sobrepor

  const out = [...inputs, '-filter_complex', fc.join(';'), '-map', cur, '-map', '0:a?', ...x264VideoArgs(channel)];
  if (audioMode === 'encode') out.push('-c:a', 'aac', '-b:a', channel.audioBitrate || '128k', '-ar', '44100', '-ac', '2');
  else if (audioMode === 'copy-ts') out.push('-c:a', 'copy', '-bsf:a', 'aac_adtstoasc');
  else out.push('-c:a', 'copy');
  return out;
}

// Precisa re-encodar o vídeo? (overlay de logo/classificação ou transcode)
function needsEncode(channel, rating) {
  return logoEnabled(channel) || !!(rating && RATING_COLOR[rating] && findFont()) || channel.mode === 'transcode';
}

// Classificação indicativa ativa: vem do programa (playlist) que está no ar.
function activeRating(channel, block) {
  const plId = block ? block.playlistId : channel.defaultPlaylistId;
  const pl = db.get().playlists.find((p) => p.id === plId);
  return pl ? (pl.rating || '') : '';
}

// Fonte ao vivo prioritária do canal: uma entrada (OBS) OU um relay.
// Com um relay "somente ao vivo" como fonte, o canal vira o "algo entre uma
// live e outra": playlist de espera no ar, corta para o relay quando a live
// engata e volta sozinho quando ela termina.
function liveSourceFor(channel) {
  if (!channel.liveInputId) return null;
  const state = db.get();
  const input = state.inputs.find((i) => i.id === channel.liveInputId);
  if (input) return { key: input.key, name: input.name };
  const relay = state.relays.find((r) => r.id === channel.liveInputId);
  if (relay) return { key: relay.key, name: relay.name };
  return null;
}

function buildChannelArgs(channel, entry) {
  // Fallback de live: se a fonte ao vivo vinculada estiver publicando,
  // o canal retransmite a live em vez da playlist.
  const liveSrc = liveSourceFor(channel);
  if (liveSrc && rtmpServer.isKeyLive(liveSrc.key)) {
    if (entry) {
      entry.sourceKind = 'live';
      entry.sourceSig = `live:${liveSrc.key}`;
      entry.playOrder = null;
    }
    const liveArgs = [
      '-hide_banner', '-loglevel', 'warning',
      '-nostats', '-progress', 'pipe:1',
      '-i', `rtmp://127.0.0.1:${config.RTMP_PORT}/live/${liveSrc.key}`
    ];
    // Live geralmente não leva selo de classificação (esportes/jornalismo).
    const liveTail = needsEncode(channel, '') ? encodedTail(channel, 'copy', '') : null;
    if (liveTail) liveArgs.push(...liveTail);
    else if (channel.mode === 'transcode') liveArgs.push(...transcodeArgs(channel));
    else liveArgs.push('-c', 'copy');
    liveArgs.push(...outputArgs(channel.key));
    return liveArgs;
  }

  const block = currentBlock(channel);
  const rating = activeRating(channel, block);
  const seamless = seamlessActive(channel);
  const listPath = seamless ? buildSeamlessConcat(channel, entry) : buildConcatFile(channel, entry);
  if (!listPath) return null;
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-nostats', '-progress', 'pipe:1',
    '-re',
    '-fflags', '+genpts'
  ];
  // Modo normal: loop infinito da playlist do bloco. Modo sem corte: lista
  // finita já encadeando os blocos (regenera ao fim do horizonte).
  if (!seamless) args.push('-stream_loop', '-1');
  args.push('-f', 'concat', '-safe', '0', '-i', listPath);
  if (needsEncode(channel, rating)) {
    // Overlay (logo/classificação) ou transcode: re-encoda o vídeo. O áudio
    // segue em cópia (com bsf para o AAC em TS do modo normalized).
    const audioMode = channel.mode === 'normalized' ? 'copy-ts' : (channel.mode === 'copy' ? 'copy' : 'encode');
    args.push(...encodedTail(channel, audioMode, rating));
  } else if (channel.mode === 'normalized') {
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
  if (config.YTDLP_JS_RUNTIME) args.push('--js-runtimes', config.YTDLP_JS_RUNTIME);
  args.push(...config.YTDLP_EXTRA_ARGS);
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

// URL da aba de transmissões do canal (para listar lives simultâneas).
function channelStreamsUrl(channelUrl) {
  const base = channelUrl.replace(/\/live\/?$/i, '').replace(/\/$/, '');
  return /\/streams$/i.test(base) ? base : base + '/streams';
}

const CHANNEL_URL_RE = /(https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+))/i;

// Descobre a URL do canal a partir de QUALQUER URL do YouTube: URLs de canal
// são reconhecidas direto; links de vídeo (watch?v=...) são resolvidos pelo
// yt-dlp (channel_url do vídeo) e o resultado fica em cache.
const channelUrlCache = new Map();

async function resolveChannelUrl(sourceUrl) {
  const m = sourceUrl.match(CHANNEL_URL_RE);
  if (m) return m[1];
  if (channelUrlCache.has(sourceUrl)) return channelUrlCache.get(sourceUrl);
  const url = await new Promise((resolve, reject) => {
    execFile(
      config.YTDLP_PATH,
      [...ytdlpBaseArgs(), '--print', 'channel_url', sourceUrl],
      { timeout: 60000, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const reason = (stderr || err.message).trim().split('\n').pop() || 'falha desconhecida';
          return reject(new Error(`não consegui descobrir o canal desta URL (${reason})`));
        }
        const u = stdout.trim().split('\n')[0];
        if (!/^https?:\/\//.test(u)) return reject(new Error('canal não identificado para esta URL'));
        resolve(u);
      }
    );
  });
  channelUrlCache.set(sourceUrl, url);
  return url;
}

// Lista as lives NO AR de um canal (título + id). Usado quando o canal pode
// ter várias transmissões simultâneas e o relay escolhe pelo título. Aceita
// qualquer URL do YouTube — o canal é descoberto automaticamente.
async function listChannelLives(sourceUrl) {
  const channelUrl = await resolveChannelUrl(sourceUrl);
  return new Promise((resolve, reject) => {
    const args = ['--no-warnings', '--socket-timeout', '30'];
    if (config.YTDLP_COOKIES) args.push('--cookies', config.YTDLP_COOKIES);
    if (config.YTDLP_JS_RUNTIME) args.push('--js-runtimes', config.YTDLP_JS_RUNTIME);
    args.push(...config.YTDLP_EXTRA_ARGS);
    args.push(
      '--flat-playlist', '--playlist-items', '1-20',
      '--print', '%(id)s\t%(live_status)s\t%(title)s',
      channelStreamsUrl(channelUrl)
    );
    execFile(config.YTDLP_PATH, args, { timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const reason = (stderr || err.message).trim().split('\n').pop() || 'falha desconhecida';
        return reject(new Error(`yt-dlp: ${reason}`));
      }
      const lives = [];
      for (const line of stdout.split('\n')) {
        const [id, status, ...title] = line.trim().split('\t');
        if (id && status === 'is_live') lives.push({ id, title: title.join('\t') || '(sem título)' });
      }
      resolve(lives);
    });
  });
}

// Filtro de título: regex case-insensitive; se inválida, vira busca simples.
function pickByTitle(lives, filter) {
  let re = null;
  try { re = new RegExp(filter, 'i'); } catch {}
  return lives.find((l) => re ? re.test(l.title) : l.title.toLowerCase().includes(filter.toLowerCase()));
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
      ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
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
    let targetUrl = relay.sourceUrl;
    let isLive;
    if (relay.titleFilter && relay.titleFilter.trim()) {
      // Canal com várias lives simultâneas: lista as transmissões no ar e
      // escolhe pelo título (ex.: "jogo" pega a partida, não a cobertura).
      const lives = await listChannelLives(relay.sourceUrl);
      const match = pickByTitle(lives, relay.titleFilter.trim());
      if (!match) {
        const noAr = lives.length ? ` (no ar: ${lives.map((l) => `"${l.title}"`).join(', ')})` : '';
        throw new Error(`nenhuma live corresponde ao filtro "${relay.titleFilter}"${noAr} — aguardando`);
      }
      if (entry) pushLog(entry, `Filtro de título: usando a live "${match.title}"`);
      targetUrl = `https://www.youtube.com/watch?v=${match.id}`;
      isLive = true;
    } else {
      isLive = await ytdlpIsLive(targetUrl);
      // "Somente ao vivo": para URLs permanentes tipo youtube.com/@canal/live —
      // se não há live agora (ou a URL caiu no VOD do jogo encerrado), aguarda
      // e tenta de novo em vez de baixar o VOD. O backoff (máx. 30s) vira um
      // vigia: quando a próxima live começar, o relay engata sozinho.
      if (relay.liveOnly && !isLive) {
        throw new Error('fonte não está ao vivo agora — aguardando a próxima live');
      }
    }
    if (isLive) {
      // Live: o yt-dlp baixa o stream (com toda a lógica de headers/anti-bot)
      // e entrega ao ffmpeg pela entrada padrão.
      args.push('-i', 'pipe:0');
      helper = {
        cmd: config.YTDLP_PATH,
        args: [
          ...ytdlpBaseArgs(), '--no-progress',
          // ffmpeg interno do yt-dlp sem spam de stats nos logs
          '--downloader-args', 'ffmpeg:-nostats -loglevel warning',
          '-f', config.YTDLP_LIVE_FORMAT, '-o', '-', targetUrl
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
    proc: null, helper: null, preparing: false, type, status: 'starting', startedAt: null,
    restarts: 0, backoff: 1000, logs: lastLogs.get(id) || [], stopping: false,
    retryTimer: null, watchdog: null, lastProgressAt: 0, stats: {}
  };
  entry.type = type;
  entry.stopping = false;
  running.set(id, entry);

  // Start manual durante a espera do retry: cancela o timer e tenta agora
  if (entry.retryTimer) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }
  // Start duplicado (clique duplo etc.): já existe um ffmpeg vivo — ou uma
  // preparação assíncrona em andamento (yt-dlp resolvendo/baixando) — para
  // este stream. Abrir outro pipeline publicaria na mesma chave, o RTMP
  // rejeitaria o novo e o antigo viraria órfão. Ignora.
  if (entry.proc || entry.preparing) {
    pushLog(entry, 'Start ignorado: o stream já está em execução/preparação.');
    return;
  }
  entry.status = 'starting';

  const item = getItem();
  if (!item) { stopWatchdog(entry); running.delete(id); return; }

  let plan;
  entry.preparing = true;
  try {
    // Pode envolver rede/disco (yt-dlp consulta ou baixa a origem)
    plan = await buildArgs(item, entry);
  } catch (err) {
    entry.preparing = false;
    pushLog(entry, `Erro ao preparar origem: ${err.message}`);
    if (!entry.stopping) scheduleRetry(entry, id, type, buildArgs, getItem);
    return;
  }
  entry.preparing = false;
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
      // detached: grupo de processos próprio, para matar yt-dlp + filhos juntos
      helper = spawn(plan.helper.cmd, plan.helper.args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
    killHelper(entry);
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
  if (entry.transitionTimer) clearTimeout(entry.transitionTimer);
  stopWatchdog(entry);
  killHelper(entry);
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
      const cur = order[i];
      const nxt = order[(i + 1) % order.length];
      return {
        now: { id: cur.id, name: cur.name, kind: cur.kind || 'program', campaignId: cur.campaignId || null },
        next: { id: nxt.id, name: nxt.name }
      };
    }
    pos -= order[i].duration || 0;
  }
  return null;
}

// Quantos segundos faltam para o programa (vídeo) atual terminar, a partir da
// posição do ffmpeg na playlist. Usado para a transição suave de grade.
function currentItemRemaining(entry) {
  if (!entry || entry.sourceKind !== 'playlist' || !entry.playOrder) return 0;
  const order = entry.playOrder;
  const out = entry.stats ? entry.stats.outTimeSec : null;
  if (out == null || order.length === 0) return 0;
  const total = order.reduce((s, v) => s + (v.duration || 0), 0);
  if (total <= 0) return 0;
  let pos = out % total;
  for (const it of order) {
    const d = it.duration || 0;
    if (pos < d) return Math.max(0, d - pos);
    pos -= d;
  }
  return 0;
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
  const liveSrc = liveSourceFor(channel);
  if (liveSrc && rtmpServer.isKeyLive(liveSrc.key)) return `live:${liveSrc.key}`;
  // No modo sem corte, a virada de bloco já está encadeada no concat — não é
  // uma troca de fonte (não reinicia). Só live entra/sai como troca.
  if (seamlessActive(channel)) return 'seamless';
  const block = currentBlock(channel);
  return block ? `block:${block.id}` : 'default';
}

function clearTransition(entry) {
  if (entry.transitionTimer) {
    clearTimeout(entry.transitionTimer);
    entry.transitionTimer = null;
  }
  entry.transitionPending = null;
}

function checkChannelSource(channel, reason) {
  const entry = running.get(channel.id);
  if (!entry || entry.type !== 'channel' || entry.status !== 'running') return;
  const desired = desiredSourceSig(channel);

  if (entry.sourceSig === desired) { clearTransition(entry); return; }
  // 'fallback:<block>' significa que o bloco estava sem vídeos utilizáveis e
  // a playlist padrão assumiu — não fica reiniciando em loop por causa disso.
  if (desired.startsWith('block:') && entry.sourceSig === `fallback:${desired.slice(6)}`) {
    clearTransition(entry);
    return;
  }

  // Transições que envolvem a fonte ao vivo são IMEDIATAS: corta para a live
  // assim que ela sobe e volta para a programação assim que ela cai.
  const involvesLive = desired.startsWith('live:') || entry.sourceKind === 'live';
  if (involvesLive) {
    clearTransition(entry);
    pushLog(entry, `Trocando fonte (${reason}): ${entry.sourceSig || '?'} -> ${desired}`);
    restartIfRunning(channel.id, 'channel');
    return;
  }

  // Troca de bloco (playlist -> playlist): espera o programa atual terminar
  // antes de cortar — comportamento de emissora, sem corte no meio do episódio.
  if (entry.transitionTimer && entry.transitionPending === desired) return;
  clearTransition(entry);

  const remaining = currentItemRemaining(entry);
  const wait = Math.min(remaining, config.BLOCK_GRACE_MAX_SEC);
  if (wait <= 2) {
    pushLog(entry, `Trocando fonte (${reason}): ${entry.sourceSig || '?'} -> ${desired}`);
    restartIfRunning(channel.id, 'channel');
    return;
  }

  entry.transitionPending = desired;
  pushLog(entry, `Grade (${reason}): programa atual termina em ~${Math.round(wait)}s — troca para ${desired} agendada`);
  entry.transitionTimer = setTimeout(() => {
    entry.transitionTimer = null;
    entry.transitionPending = null;
    const e2 = running.get(channel.id);
    if (!e2 || e2.status !== 'running') return;
    const ch2 = db.get().channels.find((c) => c.id === channel.id);
    if (!ch2) return;
    const want = desiredSourceSig(ch2);
    if (e2.sourceSig === want) return;
    pushLog(e2, `Grade: programa terminou — trocando ${e2.sourceSig || '?'} -> ${want}`);
    restartIfRunning(channel.id, 'channel');
  }, wait * 1000);
}

setInterval(() => {
  for (const c of db.get().channels) {
    try { checkChannelSource(c, 'grade'); } catch (e) { console.error('[agendador]', e.message); }
  }
}, Math.max(2, config.SCHEDULER_INTERVAL_SEC) * 1000);

// As-run: amostra o que está no ar e registra quando muda de programa/comercial
// ou entra/sai do ao vivo.
function sampleAsRun(id, entry) {
  if (entry.type !== 'channel' || entry.status !== 'running') return;
  let cur, rec;
  if (entry.sourceKind === 'live') {
    cur = '__live__';
    rec = { type: 'live', title: '(ao vivo)' };
  } else {
    const np = nowPlayingOf(entry);
    if (!np) return;
    cur = `${np.now.kind}:${np.now.id}`;
    rec = { type: np.now.kind, title: np.now.name, videoId: np.now.id };
    if (np.now.campaignId) rec.campaignId = np.now.campaignId;
  }
  if (cur === entry.lastLoggedItem) return;
  entry.lastLoggedItem = cur;
  const ch = db.get().channels.find((c) => c.id === id);
  asrun.record(Object.assign({ channelId: id, channel: ch ? ch.name : id }, rec));
}
setInterval(() => {
  for (const [id, entry] of running) {
    try { sampleAsRun(id, entry); } catch (e) { console.error('[asrun]', e.message); }
  }
}, 2000);

// Fonte ao vivo vinculada ligou/desligou: reage na hora, sem esperar o tick
function handleLiveEdge(key) {
  for (const c of db.get().channels) {
    const src = liveSourceFor(c);
    if (src && src.key === key) checkChannelSource(c, 'fonte ao vivo');
  }
}
rtmpServer.events.on('publish', handleLiveEdge);
rtmpServer.events.on('unpublish', handleLiveEdge);

module.exports = {
  startChannel, startRelay, stop, restartIfRunning,
  statusOf, isRunning, autostartAll, shutdown, isYtdlpUrl, listChannelLives,
  currentBlock, blockActiveAt, toMin
};
