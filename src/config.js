const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// Carrega .env (se existir) sem depender de pacote externo
try {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

module.exports = {
  ROOT,

  // Painel web
  PANEL_PORT: parseInt(process.env.PANEL_PORT || '3000', 10),

  // Servidor RTMP / HTTP-FLV
  RTMP_PORT: parseInt(process.env.RTMP_PORT || '1935', 10),
  HTTP_MEDIA_PORT: parseInt(process.env.HTTP_MEDIA_PORT || '8000', 10),

  // Host público usado para montar as URLs exibidas no painel.
  // Se vazio, o painel usa o host da requisição.
  PUBLIC_HOST: process.env.PUBLIC_HOST || '',

  // Credenciais do painel — TROQUE EM PRODUÇÃO
  ADMIN_USER: process.env.ADMIN_USER || 'admin',
  ADMIN_PASS: process.env.ADMIN_PASS || 'admin',

  // Segredo para assinar o cookie de sessão (gerado se ausente)
  SESSION_SECRET: process.env.SESSION_SECRET || '',

  // Binários
  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',

  // Diretórios
  DATA_DIR: process.env.DATA_DIR || path.join(ROOT, 'data'),
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(ROOT, 'media', 'uploads'),

  // Limite de upload por arquivo (em MB)
  MAX_UPLOAD_MB: parseInt(process.env.MAX_UPLOAD_MB || '4096', 10),

  // Se true, permite publicar no RTMP com qualquer chave (sem validação)
  ALLOW_ANY_PUBLISH: process.env.ALLOW_ANY_PUBLISH === 'true'
};
