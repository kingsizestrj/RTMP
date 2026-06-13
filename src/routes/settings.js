// Configurações globais: por enquanto, a logo/marca d'água usada no overlay
// dos canais.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const config = require('../config');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

router.get('/', (req, res) => {
  res.json({ logo: fs.existsSync(config.LOGO_PATH) });
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
