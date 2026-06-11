// Upload e gerência de vídeos (acervo da playlist).
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');
const db = require('../db');

const router = express.Router();

const ALLOWED_EXT = new Set(['.mp4', '.mkv', '.mov', '.avi', '.flv', '.ts', '.m4v', '.webm']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${db.id()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return cb(new Error(`Extensão não permitida: ${ext}`));
    cb(null, true);
  }
});

// Duração via ffprobe (melhor esforço; segue sem se não houver ffprobe).
function probeDuration(filePath) {
  return new Promise((resolve) => {
    execFile(
      config.FFPROBE_PATH,
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const d = parseFloat(stdout.trim());
        resolve(Number.isFinite(d) ? Math.round(d) : null);
      }
    );
  });
}

router.get('/', (req, res) => {
  res.json(db.get().videos);
});

router.post('/upload', upload.array('videos', 20), async (req, res) => {
  const state = db.get();
  const added = [];
  for (const file of req.files || []) {
    const duration = await probeDuration(file.path);
    const video = {
      id: path.parse(file.filename).name,
      name: Buffer.from(file.originalname, 'latin1').toString('utf8'),
      filename: file.filename,
      size: file.size,
      duration,
      createdAt: new Date().toISOString()
    };
    state.videos.push(video);
    added.push(video);
  }
  await db.save();
  res.json({ ok: true, added });
});

router.patch('/:id', async (req, res) => {
  const state = db.get();
  const video = state.videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) {
    video.name = req.body.name.trim();
  }
  await db.save();
  res.json(video);
});

router.delete('/:id', async (req, res) => {
  const state = db.get();
  const idx = state.videos.findIndex((v) => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Vídeo não encontrado' });

  const inUse = state.channels.filter((c) => (c.videoIds || []).includes(req.params.id));
  if (inUse.length > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: `Vídeo em uso nos canais: ${inUse.map((c) => c.name).join(', ')}. Use force=true para remover mesmo assim.`
    });
  }

  const [video] = state.videos.splice(idx, 1);
  for (const c of state.channels) {
    c.videoIds = (c.videoIds || []).filter((vid) => vid !== video.id);
  }
  fs.unlink(path.join(config.UPLOAD_DIR, video.filename), () => {});
  await db.save();
  res.json({ ok: true });
});

module.exports = router;
