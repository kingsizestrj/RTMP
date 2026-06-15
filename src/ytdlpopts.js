// Argumentos extras do yt-dlp combinando o ambiente (YTDLP_EXTRA_ARGS) com o
// que for definido pelo painel (db.settings.ytdlpExtraArgs). Permite, sem
// reiniciar o servidor, ajustar a extração do YouTube (ex.: trocar o cliente
// do player para contornar o bloqueio "Sign in to confirm you're not a bot").
const config = require('./config');
const db = require('./db');

function extraArgs() {
  const env = config.YTDLP_EXTRA_ARGS || [];
  const fromDb = String((db.get().settings || {}).ytdlpExtraArgs || '').split(/\s+/).filter(Boolean);
  return [...env, ...fromDb];
}

module.exports = { extraArgs };
