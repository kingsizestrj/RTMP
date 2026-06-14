// Notificações via Telegram, de forma robusta:
// - configuração pelo painel (db.settings.telegram) com fallback no ambiente;
// - fila serializada com rate-limit (~1 msg/s) para respeitar o Telegram;
// - retry com backoff em falha de rede / 5xx / 429 (respeitando retry_after);
// - cooldown por chave para não inundar (ex.: mesmo alerta repetido);
// - sem dependências externas (usa http/https nativos).
const http = require('http');
const https = require('https');
const { URL } = require('url');
const db = require('./db');
const config = require('./config');

const queue = [];
let sending = false;
const lastSent = new Map(); // key -> timestamp

function settings() {
  const s = (db.get().settings || {}).telegram || {};
  const token = s.botToken || config.TELEGRAM_BOT_TOKEN || '';
  const chatId = s.chatId || config.TELEGRAM_CHAT_ID || '';
  const enabled = (s.enabled !== undefined ? s.enabled : !!(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID));
  const alerts = Object.assign({ offline: true, recover: true, cpu: true, disk: true, slow: true }, s.alerts || {});
  return { enabled, token, chatId, alerts };
}

// Faz uma requisição POST JSON ao Telegram, com retry. Resolve true/false.
function postMessage(token, chatId, text, attempt = 0) {
  return new Promise((resolve) => {
    let base;
    try { base = new URL(config.TELEGRAM_API_BASE); } catch { return resolve(false); }
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    const lib = base.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: base.hostname,
      port: base.port || (base.protocol === 'http:' ? 80 : 443),
      path: `${base.pathname.replace(/\/$/, '')}/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode === 200) return resolve(true);
        if ((res.statusCode === 429 || res.statusCode >= 500) && attempt < 3) {
          let wait = 2000 * (attempt + 1);
          try { const j = JSON.parse(d); if (j.parameters && j.parameters.retry_after) wait = (j.parameters.retry_after + 1) * 1000; } catch {}
          return setTimeout(() => postMessage(token, chatId, text, attempt + 1).then(resolve), wait);
        }
        console.error('[telegram] HTTP', res.statusCode, d.slice(0, 200));
        resolve(false);
      });
    });
    const retryOrFail = (msg) => {
      if (attempt < 3) setTimeout(() => postMessage(token, chatId, text, attempt + 1).then(resolve), 2000 * (attempt + 1));
      else { console.error('[telegram]', msg); resolve(false); }
    };
    req.on('timeout', () => { req.destroy(); retryOrFail('timeout'); });
    req.on('error', (e) => retryOrFail(e.message));
    req.write(body);
    req.end();
  });
}

function pump() {
  if (sending || queue.length === 0) return;
  const cfg = settings();
  if (!cfg.enabled || !cfg.token || !cfg.chatId) { queue.length = 0; return; }
  sending = true;
  const text = queue.shift();
  postMessage(cfg.token, cfg.chatId, text).catch(() => {}).finally(() => {
    sending = false;
    setTimeout(pump, 1100); // ~1 msg/s
  });
}

// Enfileira um alerta. opts.key + opts.cooldownMs evitam repetição.
function send(text, opts = {}) {
  const { key, cooldownMs = 0 } = opts;
  const cfg = settings();
  if (!cfg.enabled) return;
  if (key && cooldownMs) {
    const last = lastSent.get(key) || 0;
    if (Date.now() - last < cooldownMs) return;
    lastSent.set(key, Date.now());
  }
  queue.push(text);
  pump();
}

// Envia uma mensagem de teste imediatamente (ignora o enabled e o cooldown).
async function test(token, chatId) {
  const cfg = settings();
  token = token || cfg.token;
  chatId = chatId || cfg.chatId;
  if (!token || !chatId) throw new Error('Informe o token do bot e o chat_id');
  const ok = await postMessage(token, chatId, '✅ <b>RTMP Panel</b> — alertas do Telegram funcionando!');
  if (!ok) throw new Error('Falha ao enviar — confira o token e o chat_id');
  return true;
}

module.exports = { send, test, settings };
