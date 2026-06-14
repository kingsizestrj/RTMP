// Monitor de saúde: amostra periodicamente os streams (canais/relays), a CPU e
// o disco, e dispara alertas no Telegram nas transições (caiu/voltou, CPU alta,
// disco baixo, encoder sem acompanhar o tempo real). Cada condição tem carência
// e cooldown para evitar falsos positivos e spam.
const os = require('os');
const fs = require('fs');
const config = require('./config');
const db = require('./db');
const sm = require('./streamManager');
const notify = require('./notify');

const INTERVAL_MS = (parseInt(process.env.MONITOR_INTERVAL_SEC, 10) || 20) * 1000;
const OFFLINE_GRACE_MS = (parseInt(process.env.ALERT_OFFLINE_GRACE_SEC, 10) || 60) * 1000; // caído antes de alertar (cobre rollover/troca)
const SLOW_GRACE_MS = 90000;      // tempo lento antes de alertar
const CPU_GRACE_MS = 120000;      // CPU alta sustentada antes de alertar
const CPU_HIGH = 0.90;            // 90% de uso médio
const CPU_CLEAR = 0.70;           // volta ao normal abaixo disso
const DISK_MIN_BYTES = 2 * 1e9;   // alerta abaixo de 2 GB livres
const DISK_MIN_PCT = 0.05;        // ou abaixo de 5%
const COOLDOWN = 30 * 60 * 1000;  // 30 min para alertas de recurso

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

const streamState = new Map(); // id -> { downSince, alerted, slowSince, slowAlerted }
let cpuHighSince = 0;
let cpuAlerted = false;
let diskAlerted = false;

function alertsOn(type) {
  return notify.settings().alerts[type] !== false;
}

function checkStream(kind, item) {
  const st = sm.statusOf(item.id);
  let s = streamState.get(item.id);
  if (!s) { s = { downSince: 0, alerted: false, slowSince: 0, slowAlerted: false }; streamState.set(item.id, s); }

  // 'stopped' = parado de propósito: zera tudo, sem alerta.
  if (st.status === 'stopped') {
    s.downSince = 0; s.alerted = false; s.slowSince = 0; s.slowAlerted = false;
    return;
  }

  if (st.status === 'running') {
    if (s.alerted && alertsOn('recover')) {
      notify.send(`✅ <b>${esc(item.name)}</b> voltou ao ar`, { key: `up:${item.id}` });
    }
    s.alerted = false;
    s.downSince = 0;

    // Encoder sem acompanhar o tempo real (CPU não dá conta)
    const sp = st.stats && st.stats.speed;
    if (sp != null && sp < 0.9) {
      if (!s.slowSince) s.slowSince = Date.now();
      else if (Date.now() - s.slowSince > SLOW_GRACE_MS && !s.slowAlerted && alertsOn('slow')) {
        s.slowAlerted = true;
        notify.send(`⚠️ <b>${esc(item.name)}</b> não está acompanhando o tempo real (${sp.toFixed(2)}x) — CPU sobrecarregada`,
          { key: `slow:${item.id}`, cooldownMs: COOLDOWN });
      }
    } else {
      s.slowSince = 0; s.slowAlerted = false;
    }
    return;
  }

  // restarting / error / starting / downloading => potencialmente caído
  if (!s.downSince) s.downSince = Date.now();
  if (Date.now() - s.downSince > OFFLINE_GRACE_MS && !s.alerted && alertsOn('offline')) {
    s.alerted = true;
    const extra = st.restarts ? `, ${st.restarts} tentativa(s)` : '';
    notify.send(`🔴 <b>${esc(item.name)}</b> caiu (${st.status}${extra})`, { key: `down:${item.id}` });
  }
}

function checkCpu() {
  const cpus = os.cpus().length || 1;
  const load = os.loadavg()[0];
  const pct = load / cpus;
  if (pct > CPU_HIGH) {
    if (!cpuHighSince) cpuHighSince = Date.now();
    else if (Date.now() - cpuHighSince > CPU_GRACE_MS && !cpuAlerted && alertsOn('cpu')) {
      cpuAlerted = true;
      notify.send(`⚠️ CPU alta: ${Math.round(pct * 100)}% (load ${load.toFixed(1)} / ${cpus} núcleos)`,
        { key: 'cpu', cooldownMs: COOLDOWN });
    }
  } else {
    cpuHighSince = 0;
    if (cpuAlerted && pct < CPU_CLEAR) cpuAlerted = false;
  }
}

function checkDisk() {
  let st;
  try { st = fs.statfsSync(config.DATA_DIR); } catch { return; }
  const free = st.bavail * st.bsize;
  const pct = st.blocks ? st.bavail / st.blocks : 1;
  if (free < DISK_MIN_BYTES || pct < DISK_MIN_PCT) {
    if (!diskAlerted && alertsOn('disk')) {
      diskAlerted = true;
      notify.send(`🟠 Pouco espaço em disco: ${(free / 1e9).toFixed(1)} GB livres (${Math.round(pct * 100)}%)`,
        { key: 'disk', cooldownMs: 2 * COOLDOWN });
    }
  } else if (free > DISK_MIN_BYTES * 1.5) {
    diskAlerted = false;
  }
}

function tick() {
  try {
    const state = db.get();
    for (const c of state.channels) checkStream('channel', c);
    for (const r of state.relays) checkStream('relay', r);
    checkCpu();
    checkDisk();
  } catch (e) {
    console.error('[monitor]', e.message);
  }
}

function start() {
  setInterval(tick, INTERVAL_MS);
  // Avisa que o servidor (re)iniciou — confirma que os alertas funcionam.
  notify.send('🟢 <b>RTMP Panel</b> iniciado');
}

module.exports = { start, tick };
