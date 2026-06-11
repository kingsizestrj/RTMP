// Entradas ao vivo: chaves de publicação para transmitir do OBS/encoder
// direto para o servidor e distribuir pelo link RTMP/FLV gerado.
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(db.get().inputs);
});

router.post('/', async (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
  const state = db.get();
  const input = {
    id: db.id(),
    name: String(name).trim(),
    key: db.streamKey(),
    createdAt: new Date().toISOString()
  };
  state.inputs.push(input);
  await db.save();
  res.json(input);
});

router.post('/:id/regenerate-key', async (req, res) => {
  const state = db.get();
  const input = state.inputs.find((i) => i.id === req.params.id);
  if (!input) return res.status(404).json({ error: 'Entrada não encontrada' });
  input.key = db.streamKey();
  await db.save();
  res.json(input);
});

router.delete('/:id', async (req, res) => {
  const state = db.get();
  const idx = state.inputs.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Entrada não encontrada' });
  state.inputs.splice(idx, 1);
  await db.save();
  res.json({ ok: true });
});

module.exports = router;
