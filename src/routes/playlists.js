// Playlists: listas ordenadas de vídeos, reutilizáveis pela playlist padrão
// dos canais e pelos blocos da grade de programação.
const express = require('express');
const db = require('../db');
const sm = require('../streamManager');

const router = express.Router();

// Canais que usam esta playlist (padrão ou em bloco da grade)
function usedBy(playlistId) {
  return db.get().channels.filter((c) =>
    c.defaultPlaylistId === playlistId ||
    (c.schedule || []).some((b) => b.playlistId === playlistId)
  );
}

router.get('/', (req, res) => {
  res.json(db.get().playlists);
});

router.post('/', async (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
  const state = db.get();
  const playlist = {
    id: db.id(),
    name: String(name).trim(),
    videoIds: [],
    createdAt: new Date().toISOString()
  };
  state.playlists.push(playlist);
  await db.save();
  res.json(playlist);
});

router.patch('/:id', async (req, res) => {
  const state = db.get();
  const playlist = state.playlists.find((p) => p.id === req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist não encontrada' });

  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) playlist.name = b.name.trim();
  if (Array.isArray(b.videoIds)) {
    const valid = new Set(state.videos.map((v) => v.id));
    playlist.videoIds = b.videoIds.filter((id) => valid.has(id));
  }
  await db.save();
  // Canais no ar usando esta playlist recarregam o conteúdo
  for (const c of usedBy(playlist.id)) sm.restartIfRunning(c.id, 'channel');
  res.json(playlist);
});

router.delete('/:id', async (req, res) => {
  const state = db.get();
  const idx = state.playlists.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist não encontrada' });
  const channels = usedBy(req.params.id);
  if (channels.length > 0) {
    return res.status(409).json({
      error: `Playlist em uso pelos canais: ${channels.map((c) => c.name).join(', ')}. Remova as referências antes de excluir.`
    });
  }
  state.playlists.splice(idx, 1);
  await db.save();
  res.json({ ok: true });
});

module.exports = router;
