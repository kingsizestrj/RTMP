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
