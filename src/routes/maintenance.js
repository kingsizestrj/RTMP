// Manutenção: status/atualização do yt-dlp e gestão de disco.
const express = require('express');
const maintenance = require('../maintenance');

const router = express.Router();

router.get('/storage', (req, res) => res.json(maintenance.storage()));
router.get('/ytdlp', (req, res) => res.json(maintenance.ytdlpInfo()));

router.post('/ytdlp-update', async (req, res) => {
  res.json(await maintenance.update());
});

router.post('/clean-cache', (req, res) => res.json(maintenance.cleanCache()));
router.post('/clean-orphans', (req, res) => res.json(maintenance.cleanOrphans()));

module.exports = router;
