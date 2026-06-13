// As-run log: registro append-only do que REALMENTE foi ao ar e quando, por
// canal. É exigência contratual/legal (direitos autorais e publicidade) e a
// base do relatório de veiculação de comerciais.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.DATA_DIR, 'asrun.jsonl');
const MAX_BYTES = 10 * 1024 * 1024; // rotaciona ao passar de 10 MB

function record(entry) {
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    try {
      if (fs.statSync(FILE).size > MAX_BYTES) fs.renameSync(FILE, FILE + '.1');
    } catch {}
    fs.appendFileSync(FILE, JSON.stringify(Object.assign({ t: new Date().toISOString() }, entry)) + '\n');
  } catch (e) {
    console.error('[asrun]', e.message);
  }
}

// Últimas N entradas (mais recentes primeiro), opcionalmente de um canal.
function tail(n = 300, channelId = null) {
  let lines;
  try { lines = fs.readFileSync(FILE, 'utf8').trim().split('\n'); } catch { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    if (!lines[i]) continue;
    try {
      const o = JSON.parse(lines[i]);
      if (!channelId || o.channelId === channelId) out.push(o);
    } catch {}
  }
  return out;
}

// Relatório de veiculação: quantas vezes cada comercial (campanha) foi ao ar,
// dentro de uma janela de dias. Retorna [{campaignId, name, count, last}].
function adReport(sinceDays = 7) {
  const since = Date.now() - sinceDays * 86400000;
  const map = new Map();
  let lines;
  try { lines = fs.readFileSync(FILE, 'utf8').trim().split('\n'); } catch { return []; }
  for (const line of lines) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'ad' || !o.campaignId) continue;
    if (new Date(o.t).getTime() < since) continue;
    const e = map.get(o.campaignId) || { campaignId: o.campaignId, name: o.title, count: 0, last: o.t };
    e.count += 1;
    e.name = o.title;
    if (o.t > e.last) e.last = o.t;
    map.set(o.campaignId, e);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

module.exports = { record, tail, adReport, FILE };
