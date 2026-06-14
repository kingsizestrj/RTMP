// Configurações globais: por enquanto, a logo/marca d'água usada no overlay
// dos canais.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const config = require('../config');
const db = require('../db');
const notify = require('../notify');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Estado dos alertas, SEM expor o token (só se está configurado).
function telegramView() {
  const t = (db.get().settings || {}).telegram || {};
  return {
    enabled: !!t.enabled,
    chatId: t.chatId || '',
    hasToken: !!(t.botToken || config.TELEGRAM_BOT_TOKEN),
    fromEnv: !!(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID),
    alerts: Object.assign({ offline: true, recover: true, cpu: true, disk: true, slow: true }, t.alerts || {})
  };
}

router.get('/', (req, res) => {
  res.json({ logo: fs.existsSync(config.LOGO_PATH), telegram: telegramView() });
});

// Salva a configuração de alertas do Telegram. O token só é gravado quando
// enviado (campo vazio mantém o atual).
router.patch('/telegram', async (req, res) => {
  const b = req.body || {};
  const state = db.get();
  if (!state.settings) state.settings = {};
  const t = state.settings.telegram || {};
  if (typeof b.enabled === 'boolean') t.enabled = b.enabled;
  if (typeof b.chatId === 'string') t.chatId = b.chatId.trim();
  if (typeof b.botToken === 'string' && b.botToken.trim()) t.botToken = b.botToken.trim();
  if (b.alerts && typeof b.alerts === 'object') {
    t.alerts = {};
    for (const k of ['offline', 'recover', 'cpu', 'disk', 'slow']) t.alerts[k] = b.alerts[k] !== false;
  }
  state.settings.telegram = t;
  await db.save();
  res.json(telegramView());
});

// Envia uma mensagem de teste com os valores informados (ou os salvos).
router.post('/telegram/test', async (req, res) => {
  const b = req.body || {};
  try {
    await notify.test(b.botToken && b.botToken.trim(), b.chatId && String(b.chatId).trim());
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Recebe um PNG e grava como a logo global. Aceita apenas PNG (suporte a
// transparência), validando pela assinatura do arquivo.
router.post('/logo', upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Envie um arquivo PNG' });
  const sig = req.file.buffer.slice(0, 8);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!sig.equals(PNG)) return res.status(400).json({ error: 'O arquivo precisa ser um PNG' });
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(config.LOGO_PATH, req.file.buffer);
  } catch (err) {
    return res.status(500).json({ error: 'Falha ao salvar a logo: ' + err.message });
  }
  res.json({ ok: true, logo: true });
});

router.delete('/logo', (req, res) => {
  fs.unlink(config.LOGO_PATH, () => {});
  res.json({ ok: true, logo: false });
});

module.exports = router;
