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
  YTDLP_PATH: process.env.YTDLP_PATH || 'yt-dlp',

  // Seleção de formato do yt-dlp: prioriza H.264+AAC até 1080p para que o
  // modo "cópia direta" funcione sem transcodificar (FLV exige H.264/AAC).
  YTDLP_FORMAT: process.env.YTDLP_FORMAT ||
    'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[vcodec^=avc1][height<=1080]/b',
  // Lives são enviadas por pipe (sem merge), então o formato deve ser único
  YTDLP_LIVE_FORMAT: process.env.YTDLP_LIVE_FORMAT || 'b',
  // Arquivo de cookies (formato Netscape) para o yt-dlp — necessário quando o
  // YouTube bloqueia o IP do servidor (comum em VPS/datacenter)
  YTDLP_COOKIES: process.env.YTDLP_COOKIES || '',

  // Cache local dos vídeos baixados do YouTube (VOD é baixado uma única vez)
  CACHE_DIR: process.env.CACHE_DIR || path.join(ROOT, 'media', 'cache'),

  // Diretórios
  DATA_DIR: process.env.DATA_DIR || path.join(ROOT, 'data'),
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(ROOT, 'media', 'uploads'),
  NORMALIZED_DIR: process.env.NORMALIZED_DIR || path.join(ROOT, 'media', 'normalized'),

  // Watchdog: reinicia o ffmpeg se ficar este tempo sem progresso (0 desativa)
  STALL_TIMEOUT_SEC: parseInt(process.env.STALL_TIMEOUT_SEC || '45', 10),

  // Threads do ffmpeg nos streams ao vivo ('' = automático)
  FFMPEG_THREADS: process.env.FFMPEG_THREADS || '',

  // Normalização no upload: converte cada vídeo uma única vez para um perfil
  // uniforme (H.264/AAC). Canais no modo "normalizado" transmitem com -c copy,
  // gastando CPU quase zero durante o streaming.
  NORMALIZE_ENABLED: process.env.NORMALIZE_ENABLED !== 'false',
  NORMALIZE_RESOLUTION: process.env.NORMALIZE_RESOLUTION || '1280x720',
  NORMALIZE_FPS: parseInt(process.env.NORMALIZE_FPS || '30', 10),
  NORMALIZE_VIDEO_BITRATE: process.env.NORMALIZE_VIDEO_BITRATE || '2500k',
  NORMALIZE_AUDIO_BITRATE: process.env.NORMALIZE_AUDIO_BITRATE || '128k',
  NORMALIZE_PRESET: process.env.NORMALIZE_PRESET || 'veryfast',
  NORMALIZE_THREADS: process.env.NORMALIZE_THREADS || '',
  NORMALIZE_CONCURRENCY: parseInt(process.env.NORMALIZE_CONCURRENCY || '1', 10),
  // Detecção inteligente: vídeos enviados já no padrão do perfil são apenas
  // reempacotados (segundos, sem re-encode nem perda). false = sempre re-encodar.
  NORMALIZE_SMART: process.env.NORMALIZE_SMART !== 'false',

  // Limite de upload por arquivo (em MB)
  MAX_UPLOAD_MB: parseInt(process.env.MAX_UPLOAD_MB || '4096', 10),

  // Se true, permite publicar no RTMP com qualquer chave (sem validação)
  ALLOW_ANY_PUBLISH: process.env.ALLOW_ANY_PUBLISH === 'true',

  // Cache de GOP do servidor RTMP: true = quem entra vê imagem na hora, mas
  // começa alguns segundos atrás da borda ao vivo (o player do painel persegue
  // a borda sozinho). false = entra colado no ao vivo, porém espera o próximo
  // keyframe para exibir imagem.
  GOP_CACHE: process.env.GOP_CACHE !== 'false'
};
