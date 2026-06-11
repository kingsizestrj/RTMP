// Autenticação simples por cookie assinado (HMAC). Usuário/senha vêm do
// config (env ADMIN_USER / ADMIN_PASS).
const crypto = require('crypto');
const config = require('./config');

const SECRET = config.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'rtmp_panel_session';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${mac}`;
}

function verify(token) {
  if (!token) return null;
  const [data, mac] = token.split('.');
  if (!data || !mac) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function login(req, res) {
  const { username, password } = req.body || {};
  const userOk = crypto.timingSafeEqual(
    Buffer.from(String(username || '').padEnd(64).slice(0, 64)),
    Buffer.from(String(config.ADMIN_USER).padEnd(64).slice(0, 64))
  );
  const passOk = crypto.timingSafeEqual(
    Buffer.from(String(password || '').padEnd(64).slice(0, 64)),
    Buffer.from(String(config.ADMIN_PASS).padEnd(64).slice(0, 64))
  );
  if (!userOk || !passOk) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }
  const token = sign({ user: username, exp: Date.now() + TTL_MS });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}`);
  res.json({ ok: true });
}

function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const payload = verify(cookies[COOKIE]);
  if (!payload) return res.status(401).json({ error: 'Não autenticado' });
  req.user = payload.user;
  next();
}

module.exports = { login, logout, requireAuth };
