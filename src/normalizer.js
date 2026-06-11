// Normalização de vídeos no upload: converte cada arquivo UMA única vez para
// um perfil uniforme (H.264/AAC em MPEG-TS). Canais no modo "normalizado"
// transmitem esses arquivos com -c copy, gastando CPU quase zero durante o
// streaming — a conversão pesada acontece aqui, em background e com
// prioridade baixa para não atrapalhar os streams ao vivo.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const db = require('./db');

const queue = [];
let active = 0;

function normalizedPath(video) {
  return path.join(config.NORMALIZED_DIR, `${video.id}.ts`);
}

function buildArgs(inputPath, outputPath) {
  const res = config.NORMALIZE_RESOLUTION;
  const [w, h] = res.split('x').map(Number);
  const fps = config.NORMALIZE_FPS;
  const vb = config.NORMALIZE_VIDEO_BITRATE;
  const ab = config.NORMALIZE_AUDIO_BITRATE;
  const bufsize = parseInt(vb, 10) * 2 + 'k';
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`,
    '-c:v', 'libx264',
    '-preset', config.NORMALIZE_PRESET,
    '-profile:v', 'high', '-level', '4.1',
    '-b:v', vb, '-maxrate', vb, '-bufsize', bufsize,
    '-g', String(fps * 2), '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    '-af', 'aresample=async=1:first_pts=0',
    '-c:a', 'aac', '-b:a', ab, '-ar', '44100', '-ac', '2'
  ];
  if (config.NORMALIZE_THREADS) args.push('-threads', config.NORMALIZE_THREADS);
  args.push('-f', 'mpegts', outputPath);
  return args;
}

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

function findVideo(videoId) {
  return db.get().videos.find((v) => v.id === videoId);
}

async function setStatus(videoId, patch) {
  const video = findVideo(videoId);
  if (!video) return null;
  video.normalized = Object.assign({}, video.normalized, patch);
  await db.save();
  return video;
}

function runJob(videoId) {
  return new Promise(async (resolve) => {
    const video = findVideo(videoId);
    if (!video) return resolve();

    const input = path.join(config.UPLOAD_DIR, video.filename);
    if (!fs.existsSync(input)) {
      await setStatus(videoId, { status: 'error', error: 'Arquivo original não encontrado' });
      return resolve();
    }

    const output = normalizedPath(video);
    const tmp = output + '.tmp';
    await setStatus(videoId, { status: 'processing', error: null });
    console.log(`[normalize] iniciando: ${video.name}`);

    const args = buildArgs(input, tmp);
    let proc;
    try {
      proc = spawn(config.FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      await setStatus(videoId, { status: 'error', error: err.message });
      return resolve();
    }

    // Prioridade baixa: streams ao vivo têm preferência na CPU
    try { os.setPriority(proc.pid, 10); } catch {}

    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-1000);
    });

    proc.on('error', async (err) => {
      await setStatus(videoId, { status: 'error', error: `${err.message} (ffmpeg instalado?)` });
      resolve();
    });

    proc.on('exit', async (code) => {
      if (code !== 0) {
        fs.unlink(tmp, () => {});
        await setStatus(videoId, {
          status: 'error',
          error: (stderrTail.trim().split('\n').pop() || `ffmpeg saiu com código ${code}`).slice(0, 300)
        });
        console.error(`[normalize] falhou: ${video.name} (code=${code})`);
        return resolve();
      }
      try {
        fs.renameSync(tmp, output);
      } catch (err) {
        await setStatus(videoId, { status: 'error', error: err.message });
        return resolve();
      }
      const duration = await probeDuration(output);
      const v = findVideo(videoId);
      if (v && duration != null) v.duration = duration;
      await setStatus(videoId, { status: 'ready', filename: path.basename(output), error: null });
      console.log(`[normalize] pronto: ${video.name}`);
      resolve();
    });
  });
}

function pump() {
  while (active < config.NORMALIZE_CONCURRENCY && queue.length > 0) {
    const videoId = queue.shift();
    active += 1;
    runJob(videoId).finally(() => {
      active -= 1;
      pump();
    });
  }
}

function enqueue(videoId) {
  if (!config.NORMALIZE_ENABLED) return;
  if (queue.includes(videoId)) return;
  queue.push(videoId);
  setStatus(videoId, { status: 'pending' });
  pump();
}

// Reenfileira manualmente (botão "renormalizar" / retry de erro).
function renormalize(videoId) {
  if (queue.includes(videoId)) return;
  queue.push(videoId);
  pump();
}

// Remove o arquivo normalizado de um vídeo excluído.
function removeNormalized(video) {
  if (video.normalized && video.normalized.filename) {
    fs.unlink(path.join(config.NORMALIZED_DIR, video.normalized.filename), () => {});
  }
  fs.unlink(normalizedPath(video) + '.tmp', () => {});
}

// Na inicialização: enfileira vídeos sem normalização ou com job interrompido.
function bootstrap() {
  fs.mkdirSync(config.NORMALIZED_DIR, { recursive: true });
  if (!config.NORMALIZE_ENABLED) return;
  const state = db.get();
  for (const v of state.videos) {
    const st = v.normalized && v.normalized.status;
    if (!st || st === 'pending' || st === 'processing') enqueue(v.id);
  }
}

module.exports = { enqueue, renormalize, removeNormalized, bootstrap, normalizedPath };
