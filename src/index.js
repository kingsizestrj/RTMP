const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const rtmpServer = require('./rtmpServer');
const sm = require('./streamManager');
const normalizer = require('./normalizer');

fs.mkdirSync(config.DATA_DIR, { recursive: true });
fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
db.get();

// ---- Servidor RTMP ----
rtmpServer.start();

// ---- Painel web ----
const app = express();
app.use(express.json());
app.use(express.static(path.join(config.ROOT, 'public')));

app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.get('/api/me', auth.requireAuth, (req, res) => res.json({ user: req.user }));

app.use('/api/videos', auth.requireAuth, require('./routes/videos'));
app.use('/api/playlists', auth.requireAuth, require('./routes/playlists'));
app.use('/api/channels', auth.requireAuth, require('./routes/channels'));
app.use('/api/relays', auth.requireAuth, require('./routes/relays'));
app.use('/api/inputs', auth.requireAuth, require('./routes/inputs'));
app.use('/api/campaigns', auth.requireAuth, require('./routes/campaigns'));
app.use('/api/settings', auth.requireAuth, require('./routes/settings'));

// As-run log (o que foi ao ar) + relatório de veiculação de comerciais
const asrun = require('./asrun');
app.get('/api/asrun', auth.requireAuth, (req, res) => {
  const n = Math.min(2000, parseInt(req.query.n, 10) || 300);
  res.json(asrun.tail(n, req.query.channelId || null));
});
app.get('/api/asrun/report', auth.requireAuth, (req, res) => {
  const days = Math.min(365, parseInt(req.query.days, 10) || 7);
  res.json(asrun.adReport(days));
});
app.get('/api/asrun/download', auth.requireAuth, (req, res) => {
  res.type('text/plain');
  require('fs').createReadStream(asrun.FILE).on('error', () => res.end('')).pipe(res);
});

// Config pública mínima para as páginas de player/guia (portas e host).
app.get('/api/public/config', (req, res) => {
  res.json({
    httpMediaPort: config.HTTP_MEDIA_PORT,
    rtmpPort: config.RTMP_PORT,
    publicHost: config.PUBLIC_HOST,
    hls: config.HLS_ENABLED
  });
});

// Guia de programação (EPG) — público, sem login: nome do canal, no ar agora,
// a seguir e a grade do dia. Não expõe chaves de stream.
app.get('/api/public/epg', (req, res) => {
  const state = db.get();
  const plName = new Map(state.playlists.map((p) => [p.id, p.name]));
  const channels = state.channels.map((c) => {
    const st = sm.statusOf(c.id);
    const block = sm.currentBlock(c);
    return {
      name: c.name,
      on: st.status === 'running',
      live: st.sourceKind === 'live',
      nowPlaying: st.nowPlaying ? st.nowPlaying.name : null,
      upNext: st.upNext ? st.upNext.name : null,
      currentProgram: block ? (plName.get(block.playlistId) || '?') : (c.defaultPlaylistId ? (plName.get(c.defaultPlaylistId) || '?') : null),
      schedule: (c.schedule || [])
        .map((b) => ({ days: b.days, start: b.start, end: b.end, playlist: plName.get(b.playlistId) || '?' }))
        .sort((a, b) => a.start.localeCompare(b.start))
    };
  });
  res.json({ now: new Date().toISOString(), channels });
});

// Dashboard: visão geral + streams publicando agora
app.get('/api/status', auth.requireAuth, (req, res) => {
  const state = db.get();
  res.json({
    live: rtmpServer.liveStreams(),
    counts: {
      videos: state.videos.length,
      playlists: state.playlists.length,
      channels: state.channels.length,
      relays: state.relays.length,
      inputs: state.inputs.length
    },
    server: {
      rtmpPort: config.RTMP_PORT,
      httpMediaPort: config.HTTP_MEDIA_PORT,
      publicHost: config.PUBLIC_HOST,
      uptime: Math.round(process.uptime()),
      load: os.loadavg()[0],
      cpus: os.cpus().length,
      memUsedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100)
    }
  });
});

// Tratamento de erros (multer, JSON inválido etc.)
app.use((err, req, res, next) => {
  console.error('[panel]', err.message);
  res.status(err.status || 400).json({ error: err.message });
});

app.listen(config.PANEL_PORT, () => {
  console.log(`[panel] Painel web em http://0.0.0.0:${config.PANEL_PORT}`);
  if (config.ADMIN_PASS === 'admin') {
    console.warn('[panel] AVISO: credenciais padrão (admin/admin). Defina ADMIN_USER e ADMIN_PASS!');
  }
});

// Sobe canais/relays com autostart e retoma normalizações pendentes
sm.autostartAll();
normalizer.bootstrap();

function gracefulExit() {
  console.log('Encerrando streams...');
  sm.shutdown();
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);
