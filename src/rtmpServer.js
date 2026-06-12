// Servidor RTMP + HTTP-FLV usando node-media-server.
// Publicações são validadas contra as chaves cadastradas (canais, relays e
// entradas ao vivo), a menos que ALLOW_ANY_PUBLISH=true.
const NodeMediaServer = require('node-media-server');
const { EventEmitter } = require('events');
const config = require('./config');
const db = require('./db');

let nms = null;

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
  nms = new NodeMediaServer({
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
  });

  nms.on('prePublish', (id, streamPath, args) => {
    if (config.ALLOW_ANY_PUBLISH) return;
    const key = keyOf(streamPath);
    if (!knownKeys().has(key)) {
      console.log(`[rtmp] publicação rejeitada (chave desconhecida): ${streamPath}`);
      const session = nms.getSession(id);
      if (session) session.reject();
    }
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
