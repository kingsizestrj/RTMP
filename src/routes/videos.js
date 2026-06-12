// Upload e gerência de vídeos (acervo da playlist).
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const config = require('../config');
const db = require('../db');
const normalizer = require('../normalizer');

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
        resolve(Number.isFinite(d) ? d : null);
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
      duration: duration != null ? Math.round(duration) : null,
      durationSec: duration,
      normalized: { status: config.NORMALIZE_ENABLED ? 'pending' : 'disabled' },
      createdAt: new Date().toISOString()
    };
    state.videos.push(video);
    added.push(video);
  }
  await db.save();
  for (const v of added) normalizer.enqueue(v.id);
  res.json({ ok: true, added });
});

// Serve o arquivo original (com suporte a Range) para o player do divisor.
router.get('/:id/file', (req, res) => {
  const video = db.get().videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado' });
  res.sendFile(path.join(config.UPLOAD_DIR, video.filename));
});

// Divisor de episódios: corta o vídeo nos pontos indicados (em segundos),
// sem re-encode (-c copy, ajustado ao keyframe mais próximo). Cada parte vira
// um novo vídeo do acervo e entra na fila de normalização.
router.post('/:id/split', (req, res) => {
  const video = db.get().videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado' });

  let cuts = Array.isArray(req.body && req.body.cuts) ? req.body.cuts : null;
  if (!cuts || cuts.length === 0 || cuts.length > 100) {
    return res.status(400).json({ error: 'Informe os pontos de corte (em segundos)' });
  }
  cuts = [...new Set(cuts.map(Number))].filter((c) => Number.isFinite(c) && c > 0).sort((a, b) => a - b);
  if (cuts.length === 0) return res.status(400).json({ error: 'Pontos de corte inválidos' });
  if (video.duration && cuts[cuts.length - 1] >= video.duration) {
    return res.status(400).json({ error: 'Há corte além da duração do vídeo' });
  }

  // [0..c1], [c1..c2], ..., [cn..fim]
  const segments = [];
  let prev = 0;
  for (const c of cuts) { segments.push([prev, c]); prev = c; }
  segments.push([prev, null]);

  splitJob(video, segments).catch((err) => console.error('[split]', err.message));
  res.json({ ok: true, parts: segments.length });
});

async function splitJob(video, segments) {
  const src = path.join(config.UPLOAD_DIR, video.filename);
  const ext = path.extname(video.filename);
  let part = 1;
  for (const [start, end] of segments) {
    const newId = db.id();
    const filename = `${newId}${ext}`;
    const out = path.join(config.UPLOAD_DIR, filename);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', src];
    if (end != null) args.push('-t', String(end - start));
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', out);

    const ok = await new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(config.FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'ignore'] });
      } catch { return resolve(false); }
      try { require('os').setPriority(proc.pid, 10); } catch {}
      proc.on('error', () => resolve(false));
      proc.on('exit', (code) => resolve(code === 0 && fs.existsSync(out)));
    });
    if (!ok) {
      console.error(`[split] falha na parte ${part} de ${video.name}`);
      fs.unlink(out, () => {});
      part++;
      continue;
    }

    const duration = await probeDuration(out);
    const state = db.get();
    state.videos.push({
      id: newId,
      name: `${video.name} (parte ${part})`,
      filename,
      size: fs.statSync(out).size,
      duration: duration != null ? Math.round(duration) : null,
      durationSec: duration,
      normalized: { status: config.NORMALIZE_ENABLED ? 'pending' : 'disabled' },
      createdAt: new Date().toISOString()
    });
    await db.save();
    normalizer.enqueue(newId);
    console.log(`[split] pronto: ${video.name} (parte ${part})`);
    part++;
  }
}

// Reprocessa a normalização (retry de erro ou perfil alterado).
router.post('/:id/normalize', async (req, res) => {
  const video = db.get().videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado' });
  video.normalized = { status: 'pending' };
  await db.save();
  normalizer.renormalize(video.id);
  res.json(video);
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

  const inPlaylists = state.playlists.filter((p) => (p.videoIds || []).includes(req.params.id));
  const inBreaks = state.channels.filter((c) => (c.breakVideoIds || []).includes(req.params.id));
  if ((inPlaylists.length > 0 || inBreaks.length > 0) && req.query.force !== 'true') {
    const uses = [
      ...inPlaylists.map((p) => `playlist "${p.name}"`),
      ...inBreaks.map((c) => `vinhetas do canal "${c.name}"`)
    ];
    return res.status(409).json({
      error: `Vídeo em uso: ${uses.join(', ')}. Use force=true para remover mesmo assim.`
    });
  }

  const [video] = state.videos.splice(idx, 1);
  for (const p of state.playlists) {
    p.videoIds = (p.videoIds || []).filter((vid) => vid !== video.id);
  }
  for (const c of state.channels) {
    c.breakVideoIds = (c.breakVideoIds || []).filter((vid) => vid !== video.id);
  }
  fs.unlink(path.join(config.UPLOAD_DIR, video.filename), () => {});
  normalizer.removeNormalized(video);
  await db.save();
  res.json({ ok: true });
});

module.exports = router;
