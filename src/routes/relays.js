// Relays: pegam uma fonte HTTP/HLS/RTMP/RTSP e retransmitem via RTMP local.
const express = require('express');
const db = require('../db');
const sm = require('../streamManager');

const router = express.Router();

const URL_RE = /^(https?|rtmp|rtmps|rtsp|srt|udp):\/\/.+/i;

function publicView(relay) {
  return Object.assign({}, relay, sm.statusOf(relay.id));
}

router.get('/', (req, res) => {
  res.json(db.get().relays.map(publicView));
});

router.post('/', async (req, res) => {
  const { name, sourceUrl } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
  if (!sourceUrl || !URL_RE.test(String(sourceUrl).trim())) {
    return res.status(400).json({ error: 'URL de origem inválida (use http(s)://, rtmp://, rtsp://, srt:// ou udp://)' });
  }
  const state = db.get();
  const relay = {
    id: db.id(),
    name: String(name).trim(),
    key: db.streamKey(),
    sourceUrl: String(sourceUrl).trim(),
    mode: 'copy',        // 'copy' | 'transcode'
    loop: false,         // true para fontes VOD (arquivo de vídeo via http)
    resolution: '1280x720',
    videoBitrate: '2500k',
    audioBitrate: '128k',
    fps: 30,
    autostart: false,
    createdAt: new Date().toISOString()
  };
  state.relays.push(relay);
  await db.save();
  res.json(publicView(relay));
});

router.patch('/:id', async (req, res) => {
  const state = db.get();
  const relay = state.relays.find((r) => r.id === req.params.id);
  if (!relay) return res.status(404).json({ error: 'Relay não encontrado' });

  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) relay.name = b.name.trim();
  if (typeof b.sourceUrl === 'string' && URL_RE.test(b.sourceUrl.trim())) relay.sourceUrl = b.sourceUrl.trim();
  if (b.mode === 'transcode' || b.mode === 'copy') relay.mode = b.mode;
  if (['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].includes(b.preset)) relay.preset = b.preset;
  if (typeof b.loop === 'boolean') relay.loop = b.loop;
  if (typeof b.resolution === 'string' && /^\d{2,5}x\d{2,5}$/.test(b.resolution)) relay.resolution = b.resolution;
  if (typeof b.videoBitrate === 'string' && /^\d+k$/.test(b.videoBitrate)) relay.videoBitrate = b.videoBitrate;
  if (typeof b.audioBitrate === 'string' && /^\d+k$/.test(b.audioBitrate)) relay.audioBitrate = b.audioBitrate;
  if (Number.isInteger(b.fps) && b.fps >= 1 && b.fps <= 120) relay.fps = b.fps;
  if (typeof b.autostart === 'boolean') relay.autostart = b.autostart;

  await db.save();
  sm.restartIfRunning(relay.id, 'relay');
  res.json(publicView(relay));
});

router.post('/:id/start', (req, res) => {
  const relay = db.get().relays.find((r) => r.id === req.params.id);
  if (!relay) return res.status(404).json({ error: 'Relay não encontrado' });
  sm.startRelay(relay.id);
  res.json(publicView(relay));
});

router.post('/:id/stop', (req, res) => {
  const relay = db.get().relays.find((r) => r.id === req.params.id);
  if (!relay) return res.status(404).json({ error: 'Relay não encontrado' });
  sm.stop(relay.id);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const state = db.get();
  const idx = state.relays.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Relay não encontrado' });
  sm.stop(req.params.id);
  state.relays.splice(idx, 1);
  await db.save();
  res.json({ ok: true });
});

module.exports = router;
