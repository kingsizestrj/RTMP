// Comerciais (campanhas publicitárias): um vídeo veiculado nos intervalos dos
// canais durante uma janela de datas. As inserções ficam registradas no as-run
// (relatório de veiculação).
const express = require('express');
const db = require('../db');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sanitize(b, state, base) {
  const c = Object.assign({}, base);
  if (typeof b.name === 'string' && b.name.trim()) c.name = b.name.trim();
  if (typeof b.videoId === 'string' && state.videos.some((v) => v.id === b.videoId)) c.videoId = b.videoId;
  if (typeof b.start === 'string' && (b.start === '' || DATE_RE.test(b.start))) c.start = b.start;
  if (typeof b.end === 'string' && (b.end === '' || DATE_RE.test(b.end))) c.end = b.end;
  if (Array.isArray(b.channelIds)) {
    const valid = new Set(state.channels.map((x) => x.id));
    c.channelIds = b.channelIds.filter((id) => valid.has(id));
  }
  if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
  return c;
}

router.get('/', (req, res) => res.json(db.get().campaigns));

router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
  const state = db.get();
  if (!state.videos.some((v) => v.id === b.videoId)) return res.status(400).json({ error: 'Selecione um vídeo do acervo' });
  const campaign = sanitize(b, state, {
    id: db.id(), name: '', videoId: '', start: '', end: '', channelIds: [], enabled: true,
    createdAt: new Date().toISOString()
  });
  state.campaigns.push(campaign);
  await db.save();
  res.json(campaign);
});

router.patch('/:id', async (req, res) => {
  const state = db.get();
  const c = state.campaigns.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Campanha não encontrada' });
  Object.assign(c, sanitize(req.body || {}, state, c));
  await db.save();
  res.json(c);
});

router.delete('/:id', async (req, res) => {
  const state = db.get();
  const idx = state.campaigns.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Campanha não encontrada' });
  state.campaigns.splice(idx, 1);
  await db.save();
  res.json({ ok: true });
});

module.exports = router;
