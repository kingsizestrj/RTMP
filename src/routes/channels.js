// Canais: emissoras RTMP 24/7 com playlist padrão, grade de programação,
// vinhetas e fallback de entrada ao vivo.
const express = require('express');
const db = require('../db');
const sm = require('../streamManager');
const asrun = require('../asrun');

const router = express.Router();

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function defaultPlaylistVideoIds(channel) {
  const pl = db.get().playlists.find((p) => p.id === channel.defaultPlaylistId);
  return pl ? (pl.videoIds || []) : [];
}

function readyCount(channel) {
  const byId = new Map(db.get().videos.map((v) => [v.id, v]));
  return defaultPlaylistVideoIds(channel).filter((vid) => {
    const v = byId.get(vid);
    return v && v.normalized && v.normalized.status === 'ready';
  }).length;
}

function publicView(channel) {
  return Object.assign(
    {
      readyCount: readyCount(channel),
      defaultPlaylistSize: defaultPlaylistVideoIds(channel).length
    },
    channel,
    sm.statusOf(channel.id)
  );
}

// Valida os blocos da grade: dias 0-6, horários HH:MM com início < fim e
// playlist existente. Retorna null se algo for inválido.
function sanitizeSchedule(blocks, state) {
  if (!Array.isArray(blocks) || blocks.length > 500) return null;
  const out = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') return null;
    const days = Array.isArray(b.days)
      ? [...new Set(b.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
      : [];
    if (days.length === 0) return null;
    if (typeof b.start !== 'string' || !TIME_RE.test(b.start)) return null;
    if (typeof b.end !== 'string' || !TIME_RE.test(b.end)) return null;
    // início == fim é ambíguo (zero ou 24h); início > fim é válido e significa
    // que o bloco vira a meia-noite (ex.: 23:00→02:00 ou 23:00→00:00).
    if (b.start === b.end) return null;
    if (!state.playlists.some((p) => p.id === b.playlistId)) return null;
    out.push({ id: b.id || db.id(), days, start: b.start, end: b.end, playlistId: b.playlistId });
  }
  return out;
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
    defaultPlaylistId: '',
    schedule: [],          // [{ id, days[0-6], start 'HH:MM', end 'HH:MM', playlistId }]
    breakVideoIds: [],     // vinhetas/comerciais
    breakMode: 'count',    // 'count' (a cada N vídeos) | 'minutes' (a cada N min)
    breakEvery: 0,         // a cada N vídeos de conteúdo (0 = sem intervalos)
    breakEveryMin: 0,      // a cada N minutos de conteúdo (modo 'minutes')
    liveInputId: '',       // entrada ao vivo prioritária (fallback)
    logo: false,           // overlay de marca d'água (custa CPU — re-encoda)
    logoPosition: 'tr',    // tr | tl | br | bl
    shuffle: false,
    mode: 'normalized',    // 'normalized' | 'transcode' | 'copy'
    resolution: '1280x720',
    videoBitrate: '2500k',
    audioBitrate: '128k',
    fps: 30,
    preset: 'veryfast',
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
  if (typeof b.defaultPlaylistId === 'string') {
    if (b.defaultPlaylistId === '' || state.playlists.some((p) => p.id === b.defaultPlaylistId)) {
      channel.defaultPlaylistId = b.defaultPlaylistId;
    }
  }
  if (b.schedule !== undefined) {
    const schedule = sanitizeSchedule(b.schedule, state);
    if (schedule === null) return res.status(400).json({ error: 'Grade inválida: confira dias, horários (início < fim) e playlists dos blocos' });
    channel.schedule = schedule;
  }
  if (Array.isArray(b.breakVideoIds)) {
    const valid = new Set(state.videos.map((v) => v.id));
    channel.breakVideoIds = b.breakVideoIds.filter((id) => valid.has(id));
  }
  if (b.breakMode === 'count' || b.breakMode === 'minutes') channel.breakMode = b.breakMode;
  if (Number.isInteger(b.breakEvery) && b.breakEvery >= 0 && b.breakEvery <= 100) channel.breakEvery = b.breakEvery;
  if (Number.isInteger(b.breakEveryMin) && b.breakEveryMin >= 0 && b.breakEveryMin <= 600) channel.breakEveryMin = b.breakEveryMin;
  if (typeof b.logo === 'boolean') channel.logo = b.logo;
  if (['tr', 'tl', 'br', 'bl'].includes(b.logoPosition)) channel.logoPosition = b.logoPosition;
  if (typeof b.liveInputId === 'string') {
    // Fonte ao vivo: entrada (OBS) ou relay
    if (b.liveInputId === '' ||
        state.inputs.some((i) => i.id === b.liveInputId) ||
        state.relays.some((r) => r.id === b.liveInputId)) {
      channel.liveInputId = b.liveInputId;
    }
  }
  if (typeof b.shuffle === 'boolean') channel.shuffle = b.shuffle;
  if (['normalized', 'transcode', 'copy'].includes(b.mode)) channel.mode = b.mode;
  if (['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].includes(b.preset)) channel.preset = b.preset;
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
  if (defaultPlaylistVideoIds(channel).length === 0) {
    return res.status(400).json({ error: 'Defina uma playlist padrão com vídeos antes de iniciar (aba Playlists)' });
  }
  if (channel.mode === 'normalized' && readyCount(channel) === 0) {
    return res.status(400).json({
      error: 'Nenhum vídeo da playlist padrão terminou de normalizar ainda — acompanhe na aba Vídeos, ou mude o modo do canal para "Transcodificar".'
    });
  }
  sm.startChannel(channel.id);
  res.json(publicView(channel));
});

router.post('/:id/stop', (req, res) => {
  const channel = db.get().channels.find((c) => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Canal não encontrado' });
  sm.stop(channel.id);
  asrun.record({ channelId: channel.id, channel: channel.name, type: 'offair', title: '(canal parado)' });
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
