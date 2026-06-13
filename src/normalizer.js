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

// Filtro de áudio: ressample + (opcional) normalização de loudness EBU R128,
// para padronizar o volume entre programas e comerciais.
function audioFilter() {
  const base = 'aresample=async=1:first_pts=0';
  return config.NORMALIZE_LOUDNORM ? `loudnorm=${config.NORMALIZE_LOUDNORM_TARGET},${base}` : base;
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
    '-af', audioFilter(),
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
        resolve(Number.isFinite(d) ? d : null);
      }
    );
  });
}

function probeStreams(filePath) {
  return new Promise((resolve) => {
    execFile(
      config.FFPROBE_PATH,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      }
    );
  });
}

function parseFps(s) {
  if (!s) return null;
  const [n, d] = String(s).split('/').map(Number);
  if (!d) return Number.isFinite(n) ? n : null;
  return n / d;
}

// Compara o arquivo enviado com o perfil de normalização e decide o quanto
// precisa converter:
//   'remux' — vídeo e áudio já conformes: só reempacota para TS (segundos)
//   'audio' — vídeo conforme, áudio difere: copia o vídeo, converte só o áudio
//   'full'  — re-encode completo (caminho tradicional)
function conformance(info) {
  if (!config.NORMALIZE_SMART) return 'full';
  if (!info || !Array.isArray(info.streams)) return 'full';
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  if (!v || !a) return 'full';

  const [w, h] = config.NORMALIZE_RESOLUTION.split('x').map(Number);
  const fps = parseFps(v.r_frame_rate) ?? parseFps(v.avg_frame_rate);
  const videoOk =
    v.codec_name === 'h264' &&
    v.pix_fmt === 'yuv420p' &&
    v.width === w && v.height === h &&
    fps != null && Math.abs(fps - config.NORMALIZE_FPS) <= 1 &&
    (!v.field_order || v.field_order === 'progressive') &&
    (!v.sample_aspect_ratio || v.sample_aspect_ratio === '1:1' || v.sample_aspect_ratio === '0:1');
  if (!videoOk) return 'full';

  const audioOk =
    a.codec_name === 'aac' &&
    parseInt(a.sample_rate, 10) === 44100 &&
    a.channels === 2;
  // Loudness exige re-encodar o áudio — não dá para só reempacotar.
  if (audioOk && !config.NORMALIZE_LOUDNORM) return 'remux';
  return 'audio';
}

function argsForMethod(method, inputPath, outputPath) {
  if (method === 'remux') {
    return [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-c', 'copy',
      '-f', 'mpegts', outputPath
    ];
  }
  if (method === 'audio') {
    return [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-c:v', 'copy',
      '-af', audioFilter(),
      '-c:a', 'aac', '-b:a', config.NORMALIZE_AUDIO_BITRATE, '-ar', '44100', '-ac', '2',
      '-f', 'mpegts', outputPath
    ];
  }
  return buildArgs(inputPath, outputPath);
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

    // Vídeo já no padrão do perfil não precisa de re-encode
    const method = conformance(await probeStreams(input));
    const labels = {
      remux: 'já está no padrão — apenas reempacotando (sem re-encode)',
      audio: 'vídeo já no padrão — convertendo apenas o áudio',
      full: 'convertendo (re-encode completo)'
    };
    console.log(`[normalize] ${video.name}: ${labels[method]}`);

    const args = argsForMethod(method, input, tmp);
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
      if (v && duration != null) {
        v.duration = Math.round(duration);
        // duração exata, usada no cálculo do "agora exibindo"
        v.durationSec = duration;
      }
      await setStatus(videoId, { status: 'ready', filename: path.basename(output), method, error: null });
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
