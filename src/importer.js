// Importador do YouTube: baixa vídeos (ou playlists inteiras) para o acervo
// via yt-dlp e, opcionalmente, corta em episódios usando os capítulos do
// próprio vídeo. Reaproveita o pipeline de normalização (cada arquivo baixado
// entra na fila automaticamente) e o mesmo corte sem re-encode do divisor.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const db = require('./db');
const normalizer = require('./normalizer');

const MAX_JOBS = 100;
const CONCURRENCY = 1;

const jobs = [];   // histórico recente (em memória)
const queue = [];
let active = 0;

function baseArgs() {
  const a = ['--no-warnings', '--socket-timeout', '30'];
  if (fs.existsSync(config.COOKIES_PATH)) a.push('--cookies', config.COOKIES_PATH);
  if (config.YTDLP_JS_RUNTIME) a.push('--js-runtimes', config.YTDLP_JS_RUNTIME);
  a.push(...config.YTDLP_EXTRA_ARGS);
  return a;
}

function newJob(url, splitChapters) {
  const j = {
    id: db.id(), url, title: url, status: 'queued', progress: 0,
    message: '', parts: 0, splitChapters: !!splitChapters, createdAt: new Date().toISOString()
  };
  jobs.push(j);
  while (jobs.length > MAX_JOBS) jobs.shift();
  return j;
}

function list() {
  return jobs.slice(-30).reverse();
}

function probeDuration(file) {
  return new Promise((resolve) => {
    execFile(config.FFPROBE_PATH, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 15000 }, (err, out) => {
        if (err) return resolve(null);
        const d = parseFloat(String(out).trim());
        resolve(Number.isFinite(d) ? d : null);
      });
  });
}

// Título + capítulos do vídeo (sem baixar).
function meta(url) {
  return new Promise((resolve, reject) => {
    execFile(config.YTDLP_PATH, [...baseArgs(), '--no-playlist', '--print', '%(title)s', '--print', '%(chapters)j', url],
      { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }, (err, out, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop() || 'falha ao ler o vídeo'));
        const lines = String(out).split('\n');
        const title = (lines[0] || 'YouTube').trim();
        let chapters = [];
        try { const c = JSON.parse(lines[1]); if (Array.isArray(c)) chapters = c; } catch {}
        resolve({ title, chapters });
      });
  });
}

function enumeratePlaylist(url) {
  return new Promise((resolve, reject) => {
    execFile(config.YTDLP_PATH, [...baseArgs(), '--yes-playlist', '--flat-playlist', '--print', '%(url)s', url],
      { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (err, out, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop() || 'falha ao ler a playlist'));
        resolve(String(out).split('\n').map((s) => s.trim()).filter((u) => /^https?:\/\//i.test(u)));
      });
  });
}

function download(job, url, outFile) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(config.YTDLP_PATH, [
        ...baseArgs(), '--no-playlist', '--newline',
        '-f', config.YTDLP_FORMAT, '--merge-output-format', 'mp4',
        '-o', outFile, url
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { return reject(new Error(err.message)); }
    try { os.setPriority(proc.pid, 10); } catch {}
    job.proc = proc;
    let tail = '';
    const onData = (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-600);
      const m = s.match(/(\d{1,3}(?:\.\d+)?)%/);
      if (m) job.progress = parseFloat(m[1]);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => { job.proc = null; reject(new Error(`${err.message} (yt-dlp instalado?)`)); });
    proc.on('exit', (code) => {
      job.proc = null;
      if (code === 0 && fs.existsSync(outFile)) return resolve();
      reject(new Error(tail.trim().split('\n').pop() || `download falhou (code=${code})`));
    });
  });
}

// Corte sem re-encode (mesmo método do divisor de episódios).
function cut(input, start, dur, out) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', input];
    if (dur != null) args.push('-t', String(dur));
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', out);
    let proc;
    try { proc = spawn(config.FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'ignore'] }); }
    catch { return resolve(false); }
    try { os.setPriority(proc.pid, 10); } catch {}
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0 && fs.existsSync(out)));
  });
}

async function registerVideo(filename, name, duration) {
  const id = path.parse(filename).name;
  const file = path.join(config.UPLOAD_DIR, filename);
  const state = db.get();
  const video = {
    id, name: name.slice(0, 200),
    filename,
    size: fs.existsSync(file) ? fs.statSync(file).size : 0,
    duration: duration != null ? Math.round(duration) : null,
    durationSec: duration,
    normalized: { status: config.NORMALIZE_ENABLED ? 'pending' : 'disabled' },
    createdAt: new Date().toISOString()
  };
  state.videos.push(video);
  await db.save();
  normalizer.enqueue(id);
  return video;
}

async function runJob(job) {
  try {
    job.status = 'downloading';
    job.message = 'obtendo informações...';
    const m = await meta(job.url);
    job.title = m.title;

    const tmpId = db.id();
    const tmp = path.join(config.UPLOAD_DIR, `${tmpId}.mp4`);
    job.tmp = tmp;
    job.message = 'baixando...';
    await download(job, job.url, tmp);

    job.status = 'processing';
    job.message = 'processando...';
    const dur = await probeDuration(tmp);

    if (job.splitChapters && m.chapters.length > 0) {
      let n = 0;
      for (const ch of m.chapters) {
        const start = ch.start_time || 0;
        const end = (typeof ch.end_time === 'number') ? ch.end_time : null;
        const length = end != null ? Math.max(0, end - start) : (dur != null ? Math.max(0, dur - start) : null);
        const partName = `${db.id()}.mp4`;
        const ok = await cut(tmp, start, length, path.join(config.UPLOAD_DIR, partName));
        if (ok) {
          n += 1;
          const epName = (ch.title && String(ch.title).trim()) ? String(ch.title).trim() : `${m.title} - Ep ${n}`;
          await registerVideo(partName, epName, length);
        }
      }
      fs.unlink(tmp, () => {});
      job.tmp = null;
      if (n === 0) throw new Error('não consegui cortar os capítulos');
      job.parts = n;
      job.status = 'done';
      job.message = `${n} episódio(s) adicionados ao acervo`;
    } else {
      await registerVideo(`${tmpId}.mp4`, m.title, dur);
      job.tmp = null; // o arquivo virou item do acervo — não apagar ao remover o job
      if (job.splitChapters) job.message = 'sem capítulos — adicionado como vídeo único';
      else job.message = 'adicionado ao acervo';
      job.parts = 1;
      job.status = 'done';
    }
  } catch (err) {
    job.status = 'error';
    // Dica para os bloqueios mais comuns do YouTube em IP de servidor.
    if (/not available|sign in|confirm you|\bbot\b|HTTP Error 4\d\d|consent|unavailable/i.test(err.message)) {
      job.message = `${err.message} — provável bloqueio do YouTube ao IP do servidor: configure YTDLP_COOKIES e mantenha o yt-dlp atualizado.`;
    } else {
      job.message = err.message;
    }
    if (job.tmp) { fs.unlink(job.tmp, () => {}); job.tmp = null; }
    console.error('[importer]', job.url, err.message);
  }
}

function pump() {
  while (active < CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    active += 1;
    runJob(job).catch(() => {}).finally(() => { active -= 1; pump(); });
  }
}

// Enfileira uma importação. Se playlist=true, lista os vídeos e cria um job por
// vídeo (cada um respeitando splitChapters). Devolve o job inicial.
function enqueue({ url, splitChapters, playlist }) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('URL inválida (use http/https)');

  if (playlist) {
    const parent = newJob(url, splitChapters);
    parent.status = 'downloading';
    parent.message = 'lendo a playlist...';
    enumeratePlaylist(url).then((urls) => {
      if (!urls.length) { parent.status = 'error'; parent.message = 'playlist vazia ou inacessível'; return; }
      parent.status = 'done';
      parent.title = `Playlist (${urls.length} vídeos)`;
      parent.message = `${urls.length} vídeos enfileirados`;
      parent.parts = urls.length;
      for (const u of urls) queue.push(newJob(u, splitChapters));
      pump();
    }).catch((e) => { parent.status = 'error'; parent.message = e.message; });
    return parent;
  }

  const job = newJob(url, splitChapters);
  queue.push(job);
  pump();
  return job;
}

// Remove/cancela uma importação. Se estiver baixando, mata o yt-dlp e apaga o
// arquivo parcial; se estiver na fila, tira da fila.
function remove(id) {
  const qi = queue.findIndex((j) => j.id === id);
  if (qi >= 0) queue.splice(qi, 1);
  const j = jobs.find((x) => x.id === id);
  if (j) {
    j.cancelled = true;
    if (j.proc) { try { j.proc.kill('SIGKILL'); } catch {} j.proc = null; }
    if (j.tmp) { fs.unlink(j.tmp, () => {}); j.tmp = null; }
  }
  const ji = jobs.findIndex((x) => x.id === id);
  if (ji >= 0) jobs.splice(ji, 1);
  return !!j;
}

// Limpa da lista as importações concluídas ou com erro.
function clearFinished() {
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (jobs[i].status === 'done' || jobs[i].status === 'error') jobs.splice(i, 1);
  }
}

module.exports = { enqueue, list, remove, clearFinished };
