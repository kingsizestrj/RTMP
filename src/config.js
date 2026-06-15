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
  // YouTube exige login (idade/região) ou bloqueia o IP. Pode ser enviado pelo
  // painel (gravado em data/cookies.txt) ou apontado por YTDLP_COOKIES.
  YTDLP_COOKIES: process.env.YTDLP_COOKIES || '',
  COOKIES_PATH: process.env.YTDLP_COOKIES || path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'cookies.txt'),
  // Argumentos extras aplicados a TODA chamada do yt-dlp (import + relays).
  // Válvula de escape para contornar bloqueios sem mexer no código, ex.:
  //   YTDLP_EXTRA_ARGS=--extractor-args youtube:player_client=android,web
  YTDLP_EXTRA_ARGS: (process.env.YTDLP_EXTRA_ARGS || '').split(/\s+/).filter(Boolean),
  // Runtime JS que o yt-dlp usa para resolver o desafio do player do YouTube
  // (obrigatório para baixar vídeos normais desde 2025). Como este é um app
  // Node, o binário 'node' está sempre presente. Vazio desativa (yt-dlp antigo).
  YTDLP_JS_RUNTIME: process.env.YTDLP_JS_RUNTIME !== undefined ? process.env.YTDLP_JS_RUNTIME : 'node',

  // Cache local dos vídeos baixados do YouTube (VOD é baixado uma única vez)
  CACHE_DIR: process.env.CACHE_DIR || path.join(ROOT, 'media', 'cache'),

  // Diretórios
  DATA_DIR: process.env.DATA_DIR || path.join(ROOT, 'data'),
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(ROOT, 'media', 'uploads'),
  NORMALIZED_DIR: process.env.NORMALIZED_DIR || path.join(ROOT, 'media', 'normalized'),

  // Logo/marca d'água (PNG enviado pelo painel) para overlay nos canais
  LOGO_PATH: process.env.LOGO_PATH || path.join(ROOT, 'data', 'logo.png'),

  // Transição de grade: ao trocar de bloco, espera o programa atual terminar
  // antes de cortar (comportamento de emissora). Limite máximo dessa espera —
  // além disso, corta mesmo no meio (ex.: bloco entrou no meio de um filme).
  BLOCK_GRACE_MAX_SEC: parseInt(process.env.BLOCK_GRACE_MAX_SEC || '600', 10),

  // De quanto em quanto tempo o agendador confere se a grade mudou de bloco.
  SCHEDULER_INTERVAL_SEC: parseInt(process.env.SCHEDULER_INTERVAL_SEC || '20', 10),

  // Transição sem corte (modo emissora): a grade é pré-computada para este
  // horizonte (segundos) e encadeada num único fluxo; ao fim, regenera.
  SEAMLESS_HORIZON_SEC: parseInt(process.env.SEAMLESS_HORIZON_SEC || '21600', 10),

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
  // Normalização de loudness (EBU R128): padroniza o volume entre programas e
  // comerciais (o clássico "comercial mais alto"). Re-encoda só o áudio.
  NORMALIZE_LOUDNORM: process.env.NORMALIZE_LOUDNORM !== 'false',
  NORMALIZE_LOUDNORM_TARGET: process.env.NORMALIZE_LOUDNORM_TARGET || 'I=-16:TP=-1.5:LRA=11',

  // Fonte para textos sobrepostos (classificação indicativa, cartão de espera)
  FONT_PATH: process.env.FONT_PATH || '',

  // Limite de upload por arquivo (em MB)
  MAX_UPLOAD_MB: parseInt(process.env.MAX_UPLOAD_MB || '4096', 10),

  // Se true, permite publicar no RTMP com qualquer chave (sem validação)
  ALLOW_ANY_PUBLISH: process.env.ALLOW_ANY_PUBLISH === 'true',

  // Gera HLS (.m3u8) de cada stream — remux barato (-c copy). HLS roda em
  // iPhone/SmartTV/navegador, onde o HTTP-FLV não funciona.
  HLS_ENABLED: process.env.HLS_ENABLED !== 'false',

  // Cache de GOP do servidor RTMP: true = quem entra vê imagem na hora, mas
  // começa alguns segundos atrás da borda ao vivo (o player do painel persegue
  // a borda sozinho). false = entra colado no ao vivo, porém espera o próximo
  // keyframe para exibir imagem.
  GOP_CACHE: process.env.GOP_CACHE !== 'false',

  // Alertas no Telegram (fallback/padrão; também configurável pelo painel).
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  // Base da API (configurável para testes/proxy)
  TELEGRAM_API_BASE: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'
};
