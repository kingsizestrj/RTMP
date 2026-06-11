// Canais: playlists de vídeos transmitidas em loop via RTMP.
const express = require('express');
const db = require('../db');
const sm = require('../streamManager');

const router = express.Router();

function publicView(channel) {
  return Object.assign({}, channel, sm.statusOf(channel.id));
}

router.get('/', (req, res) => {
  res.json(db.get().channels.map(publicView));
});

router.post('/', async (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
  const state = db.get();
  const channel = {
    id: db.id(),
    name: String(name).trim(),
    key: db.streamKey(),
    videoIds: [],
    shuffle: false,
    mode: 'transcode',           // 'transcode' | 'copy'
    resolution: '1280x720',
    videoBitrate: '2500k',
    audioBitrate: '128k',
    fps: 30,
    autostart: false,
    createdAt: new Date().toISOString()
  };
  state.channels.push(channel);
  await db.save();
  res.json(publicView(channel));
});

router.patch('/:id', async (req, res) => {
  const state = db.get();
  const channel = state.channels.find((c) => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Canal não encontrado' });

  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) channel.name = b.name.trim();
  if (Array.isArray(b.videoIds)) {
    const valid = new Set(state.videos.map((v) => v.id));
    channel.videoIds = b.videoIds.filter((id) => valid.has(id));
  }
  if (typeof b.shuffle === 'boolean') channel.shuffle = b.shuffle;
  if (b.mode === 'transcode' || b.mode === 'copy') channel.mode = b.mode;
  if (typeof b.resolution === 'string' && /^\d{2,5}x\d{2,5}$/.test(b.resolution)) channel.resolution = b.resolution;
  if (typeof b.videoBitrate === 'string' && /^\d+k$/.test(b.videoBitrate)) channel.videoBitrate = b.videoBitrate;
  if (typeof b.audioBitrate === 'string' && /^\d+k$/.test(b.audioBitrate)) channel.audioBitrate = b.audioBitrate;
  if (Number.isInteger(b.fps) && b.fps >= 1 && b.fps <= 120) channel.fps = b.fps;
  if (typeof b.autostart === 'boolean') channel.autostart = b.autostart;

  await db.save();
  // Aplica alterações em tempo real se o canal estiver no ar
  sm.restartIfRunning(channel.id, 'channel');
  res.json(publicView(channel));
});

router.post('/:id/start', (req, res) => {
  const channel = db.get().channels.find((c) => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Canal não encontrado' });
  if ((channel.videoIds || []).length === 0) {
    return res.status(400).json({ error: 'Adicione vídeos à playlist antes de iniciar' });
  }
  sm.startChannel(channel.id);
  res.json(publicView(channel));
});

router.post('/:id/stop', (req, res) => {
  const channel = db.get().channels.find((c) => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Canal não encontrado' });
  sm.stop(channel.id);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const state = db.get();
  const idx = state.channels.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Canal não encontrado' });
  sm.stop(req.params.id);
  state.channels.splice(idx, 1);
  await db.save();
  res.json({ ok: true });
});

module.exports = router;
