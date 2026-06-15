// Multistream: empurra a saída de um canal para um RTMP externo (YouTube Live
// etc.). Cada destino liga/desliga automaticamente conforme o canal está no ar
// (gerenciado pelo reconciliador do streamManager).
const express = require('express');
const db = require('../db');
const sm = require('../streamManager');

const router = express.Router();

const RTMP_RE = /^rtmps?:\/\/.+/i;

function publicView(rs) {
  const st = sm.statusOf(rs.id);
  return Object.assign({}, rs, { status: st.status, stats: st.stats, restarts: st.restarts });
}

function sanitize(b, state, base) {
  const rs = Object.assign({}, base);
  if (typeof b.name === 'string' && b.name.trim()) rs.name = b.name.trim();
  if (typeof b.server === 'string' && RTMP_RE.test(b.server.trim())) rs.server = b.server.trim();
  if (typeof b.streamKey === 'string') rs.streamKey = b.streamKey.trim();
  if (typeof b.enabled === 'boolean') rs.enabled = b.enabled;
  return rs;
}

router.get('/', (req, res) => {
  let list = db.get().restreams;
  if (req.query.channelId) list = list.filter((r) => r.channelId === req.query.channelId);
  res.json(list.map(publicView));
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  const state = db.get();
  if (!state.channels.some((c) => c.id === b.channelId)) return res.status(400).json({ error: 'Canal inválido' });
  if (!b.streamKey || !String(b.streamKey).trim()) return res.status(400).json({ error: 'Informe a chave de transmissão' });
  const rs = sanitize(b, state, {
    id: db.id(),
    channelId: b.channelId,
    name: 'YouTube',
    server: 'rtmp://a.rtmp.youtube.com/live2',
    streamKey: '',
    enabled: true,
    createdAt: new Date().toISOString()
  });
  state.restreams.push(rs);
  await db.save();
  sm.reconcileRestreams();
  res.json(publicView(rs));
});

router.patch('/:id', async (req, res) => {
  const state = db.get();
  const rs = state.restreams.find((r) => r.id === req.params.id);
  if (!rs) return res.status(404).json({ error: 'Destino não encontrado' });
  Object.assign(rs, sanitize(req.body || {}, state, rs));
  await db.save();
  // Aplica mudança de chave/servidor reiniciando o push se já estiver no ar.
  sm.stop(rs.id);
  sm.reconcileRestreams();
  res.json(publicView(rs));
});

router.delete('/:id', async (req, res) => {
  const state = db.get();
  const idx = state.restreams.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Destino não encontrado' });
  sm.stop(req.params.id);
  state.restreams.splice(idx, 1);
  await db.save();
  res.json({ ok: true });
});

module.exports = router;
