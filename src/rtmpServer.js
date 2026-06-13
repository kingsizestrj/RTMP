// Servidor RTMP + HTTP-FLV usando node-media-server.
// Publicações são validadas contra as chaves cadastradas (canais, relays e
// entradas ao vivo), a menos que ALLOW_ANY_PUBLISH=true.
const NodeMediaServer = require('node-media-server');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');

let nms = null;

// O trans server (HLS) exige o caminho ABSOLUTO e executável do ffmpeg —
// resolve o nome via PATH quando FFMPEG_PATH não é um caminho.
function resolveFfmpeg() {
  const p = config.FFMPEG_PATH;
  if (p.includes('/')) return p;
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const full = path.join(dir, p);
    try { fs.accessSync(full, fs.constants.X_OK); return full; } catch {}
  }
  return p;
}

// Eventos de publicação ('publish'/'unpublish' com a chave) e registro das
// chaves no ar — usados pelo fallback de live dos canais.
const events = new EventEmitter();
const publishing = new Set();

function keyOf(streamPath) {
  return (streamPath || '').split('/').pop();
}

function isKeyLive(key) {
  return publishing.has(key);
}

function knownKeys() {
  const state = db.get();
  const keys = new Set();
  for (const c of state.channels) keys.add(c.key);
  for (const r of state.relays) keys.add(r.key);
  for (const i of state.inputs) keys.add(i.key);
  return keys;
}

function start() {
  const conf = {
    rtmp: {
      port: config.RTMP_PORT,
      chunk_size: 60000,
      gop_cache: config.GOP_CACHE,
      ping: 30,
      ping_timeout: 60
    },
    http: {
      port: config.HTTP_MEDIA_PORT,
      allow_origin: '*',
      mediaroot: config.DATA_DIR
    },
    logType: 2
  };
  // HLS: remux (-c copy) de todo stream da app 'live' para .m3u8 + segmentos.
  if (config.HLS_ENABLED) {
    conf.trans = {
      ffmpeg: resolveFfmpeg(),
      tasks: [{
        app: 'live',
        hls: true,
        hlsFlags: '[hls_time=2:hls_list_size=4:hls_flags=delete_segments]'
      }]
    };
  }
  // Contorna um bug do node-media-server v2.7.4: o trans server (HLS) loga
  // `ffmpeg version: ${version}` com `version` não declarado, lançando
  // ReferenceError no boot. Definir global.version faz o identificador
  // resolver e o log sair sem quebrar (o HLS em si funciona).
  if (typeof global.version === 'undefined') global.version = '';

  nms = new NodeMediaServer(conf);

  nms.on('prePublish', (id, streamPath, args) => {
    if (config.ALLOW_ANY_PUBLISH) return;
    const key = keyOf(streamPath);
    const state = db.get();
    const isInput = state.inputs.some((i) => i.key === key);
    const isChannelOrRelay = state.channels.some((c) => c.key === key) || state.relays.some((r) => r.key === key);
    const session = nms.getSession(id);
    if (isInput) return; // entradas (OBS) publicam de qualquer lugar
    if (isChannelOrRelay) {
      // Canais/relays só são publicados pelo nosso próprio ffmpeg (localhost).
      // Isso impede que alguém com a chave (agora exposta no player público)
      // sequestre o canal publicando conteúdo próprio.
      if (session && session.isLocal) return;
      console.log(`[rtmp] publicação rejeitada (canal/relay só do localhost): ${streamPath}`);
      if (session) session.reject();
      return;
    }
    console.log(`[rtmp] publicação rejeitada (chave desconhecida): ${streamPath}`);
    if (session) session.reject();
  });

  nms.on('postPublish', (id, streamPath) => {
    const key = keyOf(streamPath);
    publishing.add(key);
    events.emit('publish', key);
  });

  nms.on('donePublish', (id, streamPath) => {
    const key = keyOf(streamPath);
    publishing.delete(key);
    events.emit('unpublish', key);
  });

  nms.run();
  console.log(`[rtmp] RTMP em rtmp://0.0.0.0:${config.RTMP_PORT}/live | HTTP-FLV em :${config.HTTP_MEDIA_PORT}`);
  return nms;
}

// Lista de streams sendo publicados agora (para o dashboard).
function liveStreams() {
  const result = [];
  if (!nms) return result;
  // node-media-server expõe as sessões em nms.sessions / contexto interno
  try {
    const context = require('node-media-server/src/node_core_ctx');
    for (const [, session] of context.sessions) {
      if (session.isPublishing) {
        result.push({
          path: session.publishStreamPath,
          key: (session.publishStreamPath || '').split('/').pop(),
          connectTime: session.connectTime,
          viewers: session.players ? session.players.size : 0
        });
      }
    }
  } catch {
    // estrutura interna pode variar entre versões; falha silenciosa
  }
  return result;
}

module.exports = { start, liveStreams, isKeyLive, events };
