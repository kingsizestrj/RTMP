/* RTMP Panel — frontend */
'use strict';

const $ = (sel) => document.querySelector(sel);
let serverInfo = { rtmpPort: 1935, httpMediaPort: 8000, publicHost: '' };
let flvPlayer = null;
let pollTimer = null;

/* ---------- helpers ---------- */

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body instanceof FormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined)
  });
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Não autenticado'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function host() {
  return serverInfo.publicHost || location.hostname;
}

function urls(key) {
  return {
    rtmp: `rtmp://${host()}:${serverInfo.rtmpPort}/live/${key}`,
    flv: `http://${host()}:${serverInfo.httpMediaPort}/live/${key}.flv`,
    hls: `http://${host()}:${serverInfo.httpMediaPort}/live/${key}/index.m3u8`,
    publishUrl: `rtmp://${host()}:${serverInfo.rtmpPort}/live`
  };
}

// navigator.clipboard só existe em contexto seguro (HTTPS/localhost); em
// http://IP:porta usamos o fallback com textarea + execCommand.
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  document.body.removeChild(ta);
  toast(ok ? 'Copiado!' : 'Não foi possível copiar — selecione e copie manualmente', !ok);
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast('Copiado!'), () => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}

function fmtDuration(sec) {
  if (sec == null) return '?';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's';
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  return fmtDuration(s);
}

function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function parseClock(str) {
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/* ---------- grade visual (grid de 30 min × 7 dias) ---------- */

const GRID_SLOTS = 48; // 30 min cada
const PALETTE = ['#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#06b6d4',
  '#f97316', '#ec4899', '#14b8a6', '#84cc16', '#6366f1', '#f43f5e'];

function slotToTime(slot) {
  const m = (slot % GRID_SLOTS) * 30;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
function timeToSlot(t) {
  const [h, m] = String(t).split(':').map(Number);
  return (h * 60 + m) / 30;
}

// schedule (blocos) -> grade[7][48] de playlistId|null. Blocos que viram a
// meia-noite pintam até o fim do dia e o começo do dia seguinte.
function blocksToGrid(blocks) {
  const grid = Array.from({ length: 7 }, () => Array(GRID_SLOTS).fill(null));
  for (const b of blocks || []) {
    const s = timeToSlot(b.start);
    const e = timeToSlot(b.end);
    for (const day of b.days || []) {
      if (s < e) {
        for (let i = s; i < e; i++) grid[day][i] = b.playlistId;
      } else {
        for (let i = s; i < GRID_SLOTS; i++) grid[day][i] = b.playlistId;
        const nd = (day + 1) % 7;
        for (let i = 0; i < e; i++) grid[nd][i] = b.playlistId;
      }
    }
  }
  return grid;
}

// grade -> blocos, mesclando trechos iguais e dias com o mesmo padrão.
function gridToBlocks(grid) {
  const map = new Map();
  for (let day = 0; day < 7; day++) {
    let i = 0;
    while (i < GRID_SLOTS) {
      const pl = grid[day][i];
      if (!pl) { i++; continue; }
      let j = i;
      while (j < GRID_SLOTS && grid[day][j] === pl) j++;
      const start = slotToTime(i);
      const end = slotToTime(j); // j === 48 -> "00:00" (até a meia-noite)
      const k = `${start}|${end}|${pl}`;
      if (!map.has(k)) map.set(k, { start, end, playlistId: pl, days: new Set() });
      map.get(k).days.add(day);
      i = j;
    }
  }
  return [...map.values()].map((b) => ({
    days: [...b.days].sort((x, y) => x - y), start: b.start, end: b.end, playlistId: b.playlistId
  }));
}

function statusBadge(st) {
  const labels = { running: 'NO AR', stopped: 'PARADO', restarting: 'REINICIANDO', starting: 'INICIANDO', downloading: 'BAIXANDO', error: 'ERRO' };
  return `<span class="badge ${esc(st)}">${labels[st] || esc(st)}</span>`;
}

const ACTIVE_STATUSES = ['running', 'restarting', 'starting', 'downloading'];

// Velocidade do ffmpeg: 1.0x = tempo real. Abaixo disso a CPU não acompanha
// e o stream trava — mostramos o alerta para diagnóstico.
function speedInfo(item) {
  const s = (item.stats || {}).speed;
  if (item.status !== 'running' || s == null) return '';
  if (s < 0.95) {
    return ` · <span style="color:var(--red)" title="A CPU não está acompanhando o tempo real — o stream vai travar. Use o modo Normalizado, reduza resolução/bitrate ou um preset mais rápido.">⚠️ ${s.toFixed(2)}x</span>`;
  }
  return ` · ${s.toFixed(2)}x`;
}

function modeLabel(mode) {
  return { normalized: '⚡ normalizado (CPU mínima)', transcode: 'transcode ao vivo', copy: 'cópia direta' }[mode] || mode;
}

function urlRow(tag, url) {
  return `<div class="url-row"><span class="tag">${esc(tag)}</span><code>${esc(url)}</code>
    <button class="btn small" data-copy="${esc(url)}">📋</button></div>`;
}

/* ---------- modal ---------- */

function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-overlay').classList.remove('hidden');
}

function closeModal() {
  if (flvPlayer) { try { flvPlayer.destroy(); } catch {} flvPlayer = null; }
  $('#modal-overlay').classList.add('hidden');
  $('#modal').innerHTML = '';
}

$('#modal-overlay').addEventListener('click', (e) => {
  if (e.target === $('#modal-overlay')) closeModal();
});

/* ---------- auth ---------- */

function showLogin() {
  $('#login-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  clearInterval(pollTimer);
}

async function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await refreshAll();
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshCurrentTab, 5000);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/login', { method: 'POST', body: { username: $('#login-user').value, password: $('#login-pass').value } });
    await showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  showLogin();
});

/* ---------- tabs ---------- */

let currentTab = 'dashboard';

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach((t) => t.classList.add('hidden'));
    currentTab = btn.dataset.tab;
    $('#tab-' + currentTab).classList.remove('hidden');
    refreshCurrentTab();
  });
});

function refreshCurrentTab() {
  const map = {
    dashboard: loadDashboard, videos: loadVideos, playlists: loadPlaylists,
    channels: loadChannels, relays: loadRelays, inputs: loadInputs, campaigns: loadCampaigns
  };
  (map[currentTab] || (() => {}))().catch(() => {});
}

async function refreshAll() {
  await loadDashboard().catch(() => {});
  refreshCurrentTab();
}

/* ---------- dashboard ---------- */

async function loadDashboard() {
  const st = await api('/status');
  serverInfo = st.server;
  const loadPct = st.server.cpus ? Math.round((st.server.load / st.server.cpus) * 100) : 0;
  const loadWarn = loadPct >= 85;
  $('#dash-cards').innerHTML = `
    <div class="card"><div class="num">${st.live.length}</div><div class="label">Streams no ar</div></div>
    <div class="card"><div class="num">${st.counts.videos}</div><div class="label">Vídeos</div></div>
    <div class="card"><div class="num">${st.counts.playlists}</div><div class="label">Playlists</div></div>
    <div class="card"><div class="num">${st.counts.channels}</div><div class="label">Canais</div></div>
    <div class="card"><div class="num">${st.counts.relays}</div><div class="label">Relays</div></div>
    <div class="card"><div class="num" ${loadWarn ? 'style="color:var(--red)"' : ''}>${loadPct}%</div>
      <div class="label">CPU (${(st.server.load || 0).toFixed(1)} / ${st.server.cpus} núcleos)${loadWarn ? ' ⚠️' : ''}</div></div>
    <div class="card"><div class="num">${st.server.memUsedPct}%</div><div class="label">Memória</div></div>
    <div class="card"><div class="num">${fmtDuration(st.server.uptime)}</div><div class="label">Uptime do servidor</div></div>`;

  $('#live-list').innerHTML = st.live.length === 0
    ? '<p class="muted">Nenhum stream sendo publicado no momento.</p>'
    : st.live.map((s) => {
        const u = urls(s.key);
        return `<div class="item">
          <div class="item-head">
            <span class="item-title">${esc(s.path)}</span>
            <span class="badge running">NO AR</span>
            <span class="muted">${s.viewers} espectador(es)</span>
            <button class="btn small" data-preview="${esc(s.key)}">▶ Assistir</button>
          </div>
          ${urlRow('RTMP', u.rtmp)}${urlRow('FLV', u.flv)}
        </div>`;
      }).join('');
}

/* ---------- vídeos ---------- */

function normBadge(v) {
  const n = v.normalized || {};
  const map = {
    ready: ['running', '✅ normalizado'],
    processing: ['starting', '⚙️ normalizando...'],
    pending: ['stopped', '⏳ na fila'],
    error: ['error', '❌ erro na normalização']
  };
  const m = map[n.status];
  if (!m) return '';
  const methodTips = {
    remux: 'Vídeo enviado já estava no padrão — apenas reempacotado, sem re-encode nem perda de qualidade',
    audio: 'Vídeo aproveitado sem re-encode; apenas o áudio foi convertido para o padrão',
    full: 'Convertido por completo para o perfil de normalização'
  };
  let tip = '';
  if (n.status === 'error' && n.error) tip = ` title="${esc(n.error)}"`;
  else if (n.status === 'ready' && methodTips[n.method]) tip = ` title="${esc(methodTips[n.method])}"`;
  return `<span class="badge ${m[0]}"${tip}>${m[1]}${n.method === 'remux' ? ' ⚡' : ''}</span>`;
}

async function loadVideos() {
  const videos = await api('/videos');
  $('#video-list').innerHTML = videos.length === 0
    ? '<p class="muted">Nenhum vídeo enviado ainda.</p>'
    : videos.map((v) => `
      <div class="item">
        <div class="item-head">
          <span class="item-title">🎬 ${esc(v.name)}</span>
          ${normBadge(v)}
          <span class="muted">${fmtBytes(v.size)} · ${fmtDuration(v.duration)}</span>
          <div class="item-actions">
            ${(v.normalized || {}).status === 'error' ? `<button class="btn small" data-renorm-video="${v.id}">🔄 Tentar de novo</button>` : ''}
            <button class="btn small" data-split-video="${v.id}" title="Dividir em partes/episódios">✂️</button>
            <button class="btn small" data-rename-video="${v.id}" data-name="${esc(v.name)}">✏️</button>
            <button class="btn small danger" data-del-video="${v.id}">🗑️</button>
          </div>
        </div>
      </div>`).join('');
}

function uploadFiles(files) {
  const list = [...files];
  if (list.length === 0) return;
  const fd = new FormData();
  for (const f of list) fd.append('videos', f);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/videos/upload');
  $('#upload-progress').classList.remove('hidden');
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      $('#upload-bar').style.width = pct + '%';
      $('#upload-label').textContent = `Enviando ${list.length} arquivo(s)... ${pct}%`;
    }
  };
  xhr.onload = () => {
    $('#upload-progress').classList.add('hidden');
    $('#upload-bar').style.width = '0';
    if (xhr.status >= 200 && xhr.status < 300) {
      toast('Upload concluído!');
      loadVideos();
    } else {
      let msg = 'Falha no upload';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
      toast(msg, true);
    }
  };
  xhr.onerror = () => {
    $('#upload-progress').classList.add('hidden');
    toast('Falha no upload (conexão)', true);
  };
  xhr.send(fd);
}

$('#upload-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });

$('#slate-btn').addEventListener('click', async () => {
  const text = prompt('Texto do cartão de espera:', 'JÁ VOLTAMOS');
  if (!text) return;
  try {
    await api('/videos/slate', { method: 'POST', body: { text, duration: 10 } });
    toast('Cartão gerado! Adicione-o a uma playlist de espera.');
    loadVideos();
  } catch (err) { toast(err.message, true); }
});

const dz = $('#drop-zone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
dz.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

/* ---------- divisor de episódios ---------- */

function showSplitModal(videoId, name) {
  const cuts = [];
  openModal(`
    <h3>✂️ Dividir — ${esc(name)}</h3>
    <div class="player-box"><video id="split-video" src="/api/videos/${videoId}/file" controls></video></div>
    <p class="muted" style="margin-top:8px">Navegue até o fim de cada episódio e marque o corte. Os cortes são ajustados ao keyframe mais próximo (sem re-encode, instantâneo). Cada parte vira um novo vídeo do acervo.</p>
    <div class="form-row" style="margin-top:10px; display:flex; gap:8px; align-items:center; flex-wrap:wrap">
      <button class="btn" id="split-mark">➕ Marcar corte no ponto atual</button>
      <input type="text" id="split-manual" placeholder="ou digite h:mm:ss" style="width:140px">
      <button class="btn small" id="split-add-manual">➕</button>
    </div>
    <div id="split-cuts" class="muted">Nenhum corte marcado.</div>
    <div class="modal-actions">
      <button class="btn" id="modal-cancel">Cancelar</button>
      <button class="btn primary" id="split-go">Dividir</button>
    </div>`);

  function render() {
    cuts.sort((a, b) => a - b);
    $('#split-cuts').innerHTML = cuts.length === 0
      ? 'Nenhum corte marcado.'
      : cuts.map((c, i) => `<span class="chip">${fmtClock(c)} <button data-rm-cut="${i}">✕</button></span>`).join(' ')
        + `<span class="muted"> → ${cuts.length + 1} parte(s)</span>`;
    $('#split-go').textContent = `Dividir em ${cuts.length + 1} parte(s)`;
  }
  render();

  function addCut(sec) {
    if (sec == null || sec <= 0) return toast('Tempo inválido', true);
    if (!cuts.includes(sec)) cuts.push(Math.round(sec));
    render();
  }

  $('#split-mark').addEventListener('click', () => addCut($('#split-video').currentTime));
  $('#split-add-manual').addEventListener('click', () => addCut(parseClock($('#split-manual').value)));
  $('#split-cuts').addEventListener('click', (e) => {
    if (e.target.dataset.rmCut != null) { cuts.splice(+e.target.dataset.rmCut, 1); render(); }
  });
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#split-go').addEventListener('click', async () => {
    if (cuts.length === 0) return toast('Marque pelo menos um corte', true);
    try {
      const r = await api(`/videos/${videoId}/split`, { method: 'POST', body: { cuts } });
      closeModal();
      toast(`Dividindo em ${r.parts} partes — elas aparecem na lista em instantes.`);
    } catch (err) { toast(err.message, true); }
  });
}

/* ---------- playlists ---------- */

// Editor de lista ordenada (usado pelo modal de playlist): mantém uma ordem
// mutável com subir/descer/remover + caixa de seleção para adicionar vídeos.
function orderedPickerHtml(order, byId) {
  return order.map((vid, i) => `
    <div class="playlist-item">
      <span class="muted">${i + 1}.</span>
      <span class="name">${esc(byId.get(vid).name)}</span>
      <button class="btn small" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn small" data-down="${i}" ${i === order.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="btn small danger" data-rm="${i}">✕</button>
    </div>`).join('') || '<p class="muted">Lista vazia.</p>';
}

function wireOrderedPicker(listEl, pickRoot, order, byId) {
  listEl.addEventListener('click', (e) => {
    const up = e.target.dataset.up, down = e.target.dataset.down, rm = e.target.dataset.rm;
    if (up != null) { const i = +up; [order[i - 1], order[i]] = [order[i], order[i - 1]]; }
    else if (down != null) { const i = +down; [order[i], order[i + 1]] = [order[i + 1], order[i]]; }
    else if (rm != null) order.splice(+rm, 1);
    else return;
    listEl.innerHTML = orderedPickerHtml(order, byId);
  });
  pickRoot.querySelectorAll('[data-add-video]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const vid = cb.dataset.addVideo;
      if (cb.checked) { if (!order.includes(vid)) order.push(vid); }
      else { const i = order.indexOf(vid); if (i !== -1) order.splice(i, 1); }
      listEl.innerHTML = orderedPickerHtml(order, byId);
    });
  });
}

async function loadPlaylists() {
  const [playlists, videos, channels] = await Promise.all([api('/playlists'), api('/videos'), api('/channels')]);
  const byId = new Map(videos.map((v) => [v.id, v]));
  $('#playlist-list').innerHTML = playlists.length === 0
    ? '<p class="muted">Nenhuma playlist criada ainda.</p>'
    : playlists.map((p) => {
        const ids = (p.videoIds || []).filter((id) => byId.has(id));
        const total = ids.reduce((s, id) => s + (byId.get(id).duration || 0), 0);
        const users = channels.filter((c) => c.defaultPlaylistId === p.id || (c.schedule || []).some((b) => b.playlistId === p.id));
        return `<div class="item">
          <div class="item-head">
            <span class="item-title">🎞 ${esc(p.name)}</span>
            ${p.rating ? `<span class="rating-badge r${esc(p.rating)}">${esc(p.rating)}</span>` : ''}
            <span class="muted">${ids.length} vídeo(s) · ${fmtDuration(total)}${users.length ? ` · usada por: ${esc(users.map((c) => c.name).join(', '))}` : ''}</span>
            <div class="item-actions">
              <button class="btn small" data-edit-playlist="${p.id}">⚙️ Editar</button>
              <button class="btn small danger" data-del-playlist="${p.id}">🗑️</button>
            </div>
          </div>
        </div>`;
      }).join('');
}

$('#new-playlist-btn').addEventListener('click', async () => {
  const name = prompt('Nome da playlist (ex.: Desenhos manhã):');
  if (!name) return;
  try {
    const p = await api('/playlists', { method: 'POST', body: { name } });
    await loadPlaylists();
    editPlaylist(p.id);
  } catch (err) { toast(err.message, true); }
});

async function editPlaylist(id) {
  const [playlists, videos] = await Promise.all([api('/playlists'), api('/videos')]);
  const p = playlists.find((x) => x.id === id);
  if (!p) return;
  const byId = new Map(videos.map((v) => [v.id, v]));
  const order = (p.videoIds || []).filter((vid) => byId.has(vid));

  const RATINGS = [['', 'Sem classificação'], ['L', 'Livre'], ['10', '10 anos'], ['12', '12 anos'], ['14', '14 anos'], ['16', '16 anos'], ['18', '18 anos']];
  openModal(`
    <h3>🎞 Editar playlist</h3>
    <div class="form-row"><label>Nome</label><input type="text" id="pl-name" value="${esc(p.name)}"></div>
    <div class="form-row">
      <label>🔞 Classificação indicativa — selo exibido no canto quando este programa está no ar</label>
      <select id="pl-rating">
        ${RATINGS.map(([v, l]) => `<option value="${v}" ${(p.rating || '') === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <p class="muted">Exibir o selo re-encoda o vídeo nos canais que usam esta playlist (custa CPU, sai da cópia direta).</p>
    </div>
    <div class="form-row">
      <label>Vídeos (ordem de reprodução)</label>
      <div id="pl-order">${orderedPickerHtml(order, byId)}</div>
      <label style="margin-top:10px">Adicionar vídeos</label>
      <div class="playlist-pick">
        ${videos.map((v) => `<label><input type="checkbox" data-add-video="${v.id}" ${order.includes(v.id) ? 'checked' : ''}> ${esc(v.name)} <span class="muted">(${fmtDuration(v.duration)})</span></label>`).join('') || '<p class="muted">Envie vídeos na aba Vídeos primeiro.</p>'}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="modal-cancel">Cancelar</button>
      <button class="btn primary" id="pl-save">Salvar</button>
    </div>`);

  wireOrderedPicker($('#pl-order'), $('#modal'), order, byId);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#pl-save').addEventListener('click', async () => {
    try {
      await api(`/playlists/${id}`, { method: 'PATCH', body: { name: $('#pl-name').value, videoIds: order, rating: $('#pl-rating').value } });
      closeModal();
      toast('Playlist salva!');
      loadPlaylists();
    } catch (err) { toast(err.message, true); }
  });
}

/* ---------- canais ---------- */

async function loadChannels() {
  const channels = await api('/channels');
  $('#channel-list').innerHTML = channels.length === 0
    ? '<p class="muted">Nenhum canal criado. Crie um canal e monte sua playlist.</p>'
    : channels.map((c) => {
        const u = urls(c.key);
        const running = ACTIVE_STATUSES.includes(c.status);
        return `<div class="item">
          <div class="item-head">
            <span class="item-title">📺 ${esc(c.name)}</span>
            ${c.sourceKind === 'live' ? '<span class="badge error">🔴 AO VIVO</span>' : statusBadge(c.status)}
            ${c.status === 'running' ? `<span class="muted">há ${fmtUptime(c.uptime)}</span>` : ''}
            <div class="item-actions">
              ${running
                ? `<button class="btn small" data-stop-channel="${c.id}">⏹ Parar</button>`
                : `<button class="btn small primary" data-start-channel="${c.id}">▶ Iniciar</button>`}
              <button class="btn small" data-preview="${esc(c.key)}">👁 Preview</button>
              <a class="btn small" href="watch.html?k=${esc(c.key)}&n=${encodeURIComponent(c.name)}" target="_blank">📺 Página</a>
              <button class="btn small" data-edit-channel="${c.id}">⚙️ Editar</button>
              <button class="btn small" data-logs-channel="${c.id}">📜 Logs</button>
              <button class="btn small danger" data-del-channel="${c.id}">🗑️</button>
            </div>
          </div>
          ${c.nowPlaying ? `<div class="item-sub">▶ <b>Agora:</b> ${esc(c.nowPlaying.name)}${c.upNext ? ` &nbsp;·&nbsp; <b>A seguir:</b> ${esc(c.upNext.name)}` : ''}</div>` : ''}
          <div class="item-sub">
            ${c.defaultPlaylistSize} vídeo(s) na playlist padrão${c.mode === 'normalized' && c.readyCount < c.defaultPlaylistSize ? ` <span style="color:var(--yellow)">(${c.readyCount} normalizados)</span>` : ''}
            ${(c.schedule || []).length ? ` · 📅 ${c.schedule.length} bloco(s) na grade` : ''}
            ${c.seamless && (c.schedule || []).length ? ' · ✨ sem corte' : ''}
            ${(c.breakVideoIds || []).length && ((c.breakMode === 'minutes' && c.breakEveryMin > 0) || (c.breakMode !== 'minutes' && c.breakEvery > 0))
              ? ` · 📣 vinhetas ${c.breakMode === 'minutes' ? `a cada ${c.breakEveryMin}min` : `a cada ${c.breakEvery} vídeo(s)`}` : ''}
            ${c.liveInputId ? ' · 🎥 fallback de live' : ''}
            ${c.logo ? ' · 🎨 logo' : ''}
            · ${modeLabel(c.mode)}${c.mode === 'transcode' ? ` ${esc(c.resolution)} @ ${esc(c.videoBitrate)}` : ''}
            ${c.shuffle ? ' · 🔀 aleatório' : ''}${c.autostart ? ' · ⏯ autostart' : ''}
            ${c.restarts ? ` · ${c.restarts} restart(s)` : ''}${speedInfo(c)}
          </div>
          ${urlRow('RTMP', u.rtmp)}${urlRow('HLS', u.hls)}${urlRow('FLV', u.flv)}
        </div>`;
      }).join('');
}

$('#new-channel-btn').addEventListener('click', async () => {
  const name = prompt('Nome do canal:');
  if (!name) return;
  try {
    const c = await api('/channels', { method: 'POST', body: { name } });
    await loadChannels();
    editChannel(c.id);
  } catch (err) { toast(err.message, true); }
});

async function editChannel(id) {
  const [channels, videos, playlists, inputs, relays, settings] = await Promise.all([
    api('/channels'), api('/videos'), api('/playlists'), api('/inputs'), api('/relays'), api('/settings')
  ]);
  const c = channels.find((x) => x.id === id);
  if (!c) return;

  // Estado da grade visual: grade[7][48] de playlistId|null
  const grid = blocksToGrid(c.schedule || []);
  const plColor = new Map(playlists.map((p, i) => [p.id, PALETTE[i % PALETTE.length]]));
  let paintId = playlists.length ? playlists[0].id : null; // playlist "pincel"; '' = borracha

  const plOptions = (selected) =>
    playlists.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)} (${(p.videoIds || []).length})</option>`).join('');

  openModal(`
    <h3>⚙️ Editar canal</h3>
    <div class="form-row"><label>Nome</label><input type="text" id="ch-name" value="${esc(c.name)}"></div>
    <div class="form-row">
      <label>Playlist padrão (toca quando nenhum bloco da grade está ativo)</label>
      <select id="ch-default-pl">
        <option value="">— escolha uma playlist —</option>
        ${plOptions(c.defaultPlaylistId)}
      </select>
    </div>
    <div class="form-row">
      <label>📅 Grade de programação (horário do servidor) — escolha uma playlist e pinte os horários; clique e arraste. A borracha limpa.</label>
      <div id="ch-palette" class="palette"></div>
      <div id="ch-grid-wrap" class="grid-wrap"></div>
      <label class="checkbox-row" style="margin-top:8px"><input type="checkbox" id="ch-seamless" ${c.seamless ? 'checked' : ''}> ✨ Transição sem corte entre blocos (modo emissora)</label>
      <p class="muted">Encadeia os blocos num fluxo contínuo — a virada de grade não tem o corte de ~2s. A entrada/saída de live ainda corta. Obs.: o selo de classificação reflete o bloco do início do fluxo (regenera a cada ${'6h'} ou ao editar).</p>
    </div>
    <div class="form-row">
      <label>📣 Vinhetas/comerciais</label>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:6px">
        <select id="ch-break-mode">
          <option value="count" ${c.breakMode !== 'minutes' ? 'selected' : ''}>A cada N vídeos</option>
          <option value="minutes" ${c.breakMode === 'minutes' ? 'selected' : ''}>A cada N minutos</option>
        </select>
        <span id="ch-break-count-wrap">a cada <input type="number" id="ch-break-every" value="${c.breakEvery || 0}" min="0" max="100" style="width:64px"> vídeo(s)</span>
        <span id="ch-break-min-wrap">a cada <input type="number" id="ch-break-min" value="${c.breakEveryMin || 0}" min="0" max="600" style="width:64px"> minuto(s)</span>
        <span class="muted">(0 = sem intervalos)</span>
      </div>
      <div class="playlist-pick" style="max-height:120px">
        ${videos.map((v) => `<label><input type="checkbox" data-break-video="${v.id}" ${(c.breakVideoIds || []).includes(v.id) ? 'checked' : ''}> ${esc(v.name)} <span class="muted">(${fmtDuration(v.duration)})</span></label>`).join('') || '<p class="muted">Sem vídeos.</p>'}
      </div>
    </div>
    <div class="form-row">
      <label>🎥 Fonte ao vivo prioritária — entrada OBS ou relay (quando publicar, corta a playlist; quando cair, volta para a espera)</label>
      <select id="ch-live-input">
        <option value="">— nenhuma —</option>
        ${inputs.length ? `<optgroup label="Entradas ao vivo (OBS)">${inputs.map((i) => `<option value="${i.id}" ${c.liveInputId === i.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</optgroup>` : ''}
        ${relays.length ? `<optgroup label="Relays (YouTube etc.)">${relays.map((r) => `<option value="${r.id}" ${c.liveInputId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</optgroup>` : ''}
      </select>
    </div>
    <div class="form-row">
      <label>🎨 Logo / marca d'água ${settings.logo ? '<span class="muted">(logo enviada ✓)</span>' : '<span style="color:var(--yellow)">(nenhuma logo enviada ainda)</span>'}</label>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
        <label class="checkbox-row"><input type="checkbox" id="ch-logo" ${c.logo ? 'checked' : ''}> Exibir logo no canal</label>
        <select id="ch-logo-pos">
          ${[['tr', 'Sup. direita'], ['tl', 'Sup. esquerda'], ['br', 'Inf. direita'], ['bl', 'Inf. esquerda']].map(([v, l]) => `<option value="${v}" ${(c.logoPosition || 'tr') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <label class="btn small">⬆️ Enviar PNG<input type="file" id="ch-logo-file" accept="image/png" hidden></label>
      </div>
      <p class="muted">⚠️ Ativar a logo re-encoda o vídeo (custa CPU, sai do modo cópia direta). A logo é global (vale para todos os canais).</p>
    </div>
    <div class="form-row"><label>Modo de saída</label>
      <select id="ch-mode">
        <option value="normalized" ${c.mode === 'normalized' ? 'selected' : ''}>⚡ Normalizado — recomendado, CPU mínima (usa os vídeos pré-convertidos)</option>
        <option value="transcode" ${c.mode === 'transcode' ? 'selected' : ''}>Transcodificar ao vivo — re-encoda 24/7, alto uso de CPU</option>
        <option value="copy" ${c.mode === 'copy' ? 'selected' : ''}>Cópia direta dos originais — exige codecs idênticos (avançado)</option>
      </select>
    </div>
    <div class="form-grid" id="ch-transcode-opts">
      <div class="form-row"><label>Resolução</label>
        <select id="ch-res">
          ${['1920x1080', '1280x720', '854x480', '640x360'].map((r) => `<option ${c.resolution === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Bitrate de vídeo</label>
        <select id="ch-vb">
          ${['6000k', '4500k', '2500k', '1500k', '800k'].map((b) => `<option ${c.videoBitrate === b ? 'selected' : ''}>${b}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>FPS</label>
        <select id="ch-fps">
          ${[24, 30, 60].map((f) => `<option ${c.fps === f ? 'selected' : ''}>${f}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Preset x264 (mais rápido = menos CPU)</label>
        <select id="ch-preset">
          ${['ultrafast', 'superfast', 'veryfast', 'faster', 'fast'].map((p) => `<option ${(c.preset || 'veryfast') === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row checkbox-row"><input type="checkbox" id="ch-shuffle" ${c.shuffle ? 'checked' : ''}><label for="ch-shuffle">🔀 Ordem aleatória a cada ciclo</label></div>
    <div class="form-row checkbox-row"><input type="checkbox" id="ch-autostart" ${c.autostart ? 'checked' : ''}><label for="ch-autostart">⚡ Iniciar automaticamente com o servidor</label></div>
    <div class="modal-actions">
      <button class="btn" id="modal-cancel">Cancelar</button>
      <button class="btn primary" id="ch-save">Salvar</button>
    </div>`);

  // ----- Grade visual: paleta de playlists + grid pintável -----
  const paletteEl = $('#ch-palette');
  const gridWrap = $('#ch-grid-wrap');

  function renderPalette() {
    if (playlists.length === 0) {
      paletteEl.innerHTML = '<span class="muted">Crie playlists para montar a grade.</span>';
      return;
    }
    paletteEl.innerHTML = playlists.map((p) =>
      `<button type="button" class="pal-chip${paintId === p.id ? ' sel' : ''}" data-paint="${p.id}" style="--c:${plColor.get(p.id)}">${esc(p.name)}</button>`
    ).join('') + `<button type="button" class="pal-chip eraser${paintId === '' ? ' sel' : ''}" data-paint="">🧽 Borracha</button>`;
  }

  function cellTitle(slot, pl) {
    const name = pl ? ((playlists.find((p) => p.id === pl) || {}).name || '') : '';
    return slotToTime(slot) + (name ? ' · ' + name : '');
  }

  function renderGrid() {
    let head = '<div class="grid-row grid-head"><span class="grid-daylabel"></span>';
    for (let h = 0; h < 24; h++) head += `<span class="grid-hour">${String(h).padStart(2, '0')}</span>`;
    head += '</div>';
    let rows = '';
    for (let day = 0; day < 7; day++) {
      rows += `<div class="grid-row"><span class="grid-daylabel">${DAY_LABELS[day]}</span>`;
      for (let s = 0; s < GRID_SLOTS; s++) {
        const pl = grid[day][s];
        rows += `<span class="grid-cell${s % 2 ? ' half' : ''}" data-day="${day}" data-slot="${s}" title="${esc(cellTitle(s, pl))}" style="background:${pl ? plColor.get(pl) : 'transparent'}"></span>`;
      }
      rows += '</div>';
    }
    gridWrap.innerHTML = head + rows;
  }

  function paintCell(el) {
    const day = +el.dataset.day, slot = +el.dataset.slot;
    if (Number.isNaN(day) || Number.isNaN(slot)) return;
    grid[day][slot] = paintId || null;
    el.style.background = paintId ? plColor.get(paintId) : 'transparent';
    el.title = cellTitle(slot, paintId || null);
  }

  renderPalette();
  renderGrid();

  paletteEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-paint]');
    if (!b) return;
    paintId = b.dataset.paint;
    renderPalette();
  });

  let painting = false;
  gridWrap.addEventListener('mousedown', (e) => {
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    e.preventDefault();
    painting = true;
    paintCell(cell);
  });
  gridWrap.addEventListener('mouseover', (e) => {
    if (!painting) return;
    const cell = e.target.closest('.grid-cell');
    if (cell) paintCell(cell);
  });
  document.addEventListener('mouseup', () => { painting = false; });

  // ----- Vinhetas: alterna contagem × minutos -----
  const syncBreakMode = () => {
    const m = $('#ch-break-mode').value;
    $('#ch-break-count-wrap').style.display = m === 'count' ? '' : 'none';
    $('#ch-break-min-wrap').style.display = m === 'minutes' ? '' : 'none';
  };
  $('#ch-break-mode').addEventListener('change', syncBreakMode);
  syncBreakMode();

  // ----- Logo: upload do PNG global -----
  $('#ch-logo-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('logo', file);
    try {
      await api('/settings/logo', { method: 'POST', body: fd });
      toast('Logo enviada! Marque "Exibir logo" e salve.');
      $('#ch-logo').checked = true;
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  });

  // Opções de transcode só fazem sentido no modo "transcode"
  const syncTranscodeOpts = () => {
    $('#ch-transcode-opts').style.display = $('#ch-mode').value === 'transcode' ? '' : 'none';
  };
  $('#ch-mode').addEventListener('change', syncTranscodeOpts);
  syncTranscodeOpts();

  $('#modal-cancel').addEventListener('click', closeModal);
  $('#ch-save').addEventListener('click', async () => {
    const breakVideoIds = [...$('#modal').querySelectorAll('[data-break-video]:checked')]
      .map((el) => el.dataset.breakVideo);
    try {
      await api(`/channels/${id}`, {
        method: 'PATCH',
        body: {
          name: $('#ch-name').value,
          defaultPlaylistId: $('#ch-default-pl').value,
          schedule: gridToBlocks(grid),
          breakVideoIds,
          breakMode: $('#ch-break-mode').value,
          breakEvery: parseInt($('#ch-break-every').value, 10) || 0,
          breakEveryMin: parseInt($('#ch-break-min').value, 10) || 0,
          liveInputId: $('#ch-live-input').value,
          seamless: $('#ch-seamless').checked,
          logo: $('#ch-logo').checked,
          logoPosition: $('#ch-logo-pos').value,
          mode: $('#ch-mode').value,
          resolution: $('#ch-res').value,
          videoBitrate: $('#ch-vb').value,
          fps: parseInt($('#ch-fps').value, 10),
          preset: $('#ch-preset').value,
          shuffle: $('#ch-shuffle').checked,
          autostart: $('#ch-autostart').checked
        }
      });
      closeModal();
      toast('Canal salvo!');
      loadChannels();
    } catch (err) { toast(err.message, true); }
  });
}

/* ---------- relays ---------- */

async function loadRelays() {
  const relays = await api('/relays');
  $('#relay-list').innerHTML = relays.length === 0
    ? '<p class="muted">Nenhum relay criado. Adicione um link HTTP/HLS para retransmitir via RTMP.</p>'
    : relays.map((r) => {
        const u = urls(r.key);
        const running = ACTIVE_STATUSES.includes(r.status);
        return `<div class="item">
          <div class="item-head">
            <span class="item-title">🔁 ${esc(r.name)}</span>
            ${statusBadge(r.status)}
            ${r.status === 'running' ? `<span class="muted">há ${fmtUptime(r.uptime)}</span>` : ''}
            <div class="item-actions">
              ${running
                ? `<button class="btn small" data-stop-relay="${r.id}">⏹ Parar</button>`
                : `<button class="btn small primary" data-start-relay="${r.id}">▶ Iniciar</button>`}
              <button class="btn small" data-preview="${esc(r.key)}">👁 Preview</button>
              <button class="btn small" data-edit-relay="${r.id}">⚙️ Editar</button>
              <button class="btn small" data-logs-relay="${r.id}">📜 Logs</button>
              <button class="btn small danger" data-del-relay="${r.id}">🗑️</button>
            </div>
          </div>
          <div class="item-sub">Origem: ${esc(r.sourceUrl)}</div>
          <div class="item-sub">${r.mode === 'copy' ? 'cópia direta' : `transcode ${esc(r.resolution)}`}${r.ytdlp ? ' · ▶️ yt-dlp' : ''}${r.liveOnly ? ' · 📡 só ao vivo' : ''}${r.titleFilter ? ` · 🎯 "${esc(r.titleFilter)}"` : ''}${r.loop ? ' · 🔁 loop' : ''}${r.autostart ? ' · ⏯ autostart' : ''}${r.restarts ? ` · ${r.restarts} restart(s)` : ''}${speedInfo(r)}</div>
          ${urlRow('RTMP', u.rtmp)}${urlRow('FLV', u.flv)}
        </div>`;
      }).join('');
}

const YTDLP_RE = /(youtube\.com|youtu\.be|twitch\.tv|kick\.com|dailymotion\.com|vimeo\.com)/i;

function relayForm(r = {}) {
  return `
    <div class="form-row"><label>Nome</label><input type="text" id="rl-name" value="${esc(r.name || '')}" placeholder="Ex.: Canal de notícias"></div>
    <div class="form-row"><label>URL de origem (YouTube, http, hls, rtmp, rtsp, srt, udp)</label>
      <input type="text" id="rl-url" value="${esc(r.sourceUrl || '')}" placeholder="https://youtube.com/watch?v=... ou https://exemplo.com/stream.m3u8"></div>
    <div class="form-row checkbox-row"><input type="checkbox" id="rl-ytdlp" ${r.ytdlp ? 'checked' : ''}><label for="rl-ytdlp">▶️ Resolver com yt-dlp (YouTube, Twitch, Vimeo... — marcado automaticamente)</label></div>
    <div class="form-row checkbox-row"><input type="checkbox" id="rl-liveonly" ${r.liveOnly ? 'checked' : ''}><label for="rl-liveonly">📡 Somente ao vivo — aguarda a próxima live e engata sozinho (ideal para youtube.com/@canal/live)</label></div>
    <div class="form-row">
      <label>🎯 Filtro de título — para canais com várias lives simultâneas, escolhe a live cujo título combina (palavra ou regex, ex.: <code>jogo|brasil</code>). Vazio = live em destaque.</label>
      <div style="display:flex; gap:8px">
        <input type="text" id="rl-titlefilter" value="${esc(r.titleFilter || '')}" placeholder="ex.: jogo">
        ${r.id ? `<button class="btn small" id="rl-list-lives" type="button">🔍 Lives no ar</button>` : ''}
      </div>
      <div id="rl-lives-box" class="muted" style="margin-top:6px"></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Modo</label>
        <select id="rl-mode">
          <option value="copy" ${(r.mode || 'copy') === 'copy' ? 'selected' : ''}>Cópia direta (recomendado)</option>
          <option value="transcode" ${r.mode === 'transcode' ? 'selected' : ''}>Transcodificar</option>
        </select>
      </div>
      <div class="form-row"><label>Resolução (se transcodificar)</label>
        <select id="rl-res">
          ${['1920x1080', '1280x720', '854x480'].map((x) => `<option ${(r.resolution || '1280x720') === x ? 'selected' : ''}>${x}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row checkbox-row"><input type="checkbox" id="rl-loop" ${r.loop ? 'checked' : ''}><label for="rl-loop">🔁 Repetir em loop (para vídeos/VOD, não para lives)</label></div>
    <div class="form-row checkbox-row"><input type="checkbox" id="rl-autostart" ${r.autostart ? 'checked' : ''}><label for="rl-autostart">⚡ Iniciar automaticamente com o servidor</label></div>`;
}

function readRelayForm() {
  return {
    name: $('#rl-name').value,
    sourceUrl: $('#rl-url').value,
    ytdlp: $('#rl-ytdlp').checked,
    liveOnly: $('#rl-liveonly').checked,
    titleFilter: $('#rl-titlefilter').value,
    mode: $('#rl-mode').value,
    resolution: $('#rl-res').value,
    loop: $('#rl-loop').checked,
    autostart: $('#rl-autostart').checked
  };
}

// Botão "Lives no ar": lista as transmissões ativas do canal; clicar num
// título copia-o para o filtro.
function wireLivesList(relayId) {
  const btn = $('#rl-list-lives');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const box = $('#rl-lives-box');
    box.textContent = 'Consultando o canal...';
    try {
      const lives = await api(`/relays/${relayId}/lives`);
      box.innerHTML = lives.length === 0
        ? 'Nenhuma live no ar neste canal agora.'
        : 'No ar agora (clique para usar como filtro):<br>' + lives.map((l) =>
            `<a href="#" data-pick-title="${esc(l.title)}">🔴 ${esc(l.title)}</a>`).join('<br>');
      box.querySelectorAll('[data-pick-title]').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          $('#rl-titlefilter').value = a.dataset.pickTitle;
        });
      });
    } catch (err) {
      box.textContent = 'Erro: ' + err.message;
    }
  });
}

// Marca yt-dlp e "somente ao vivo" sozinho conforme a URL colada
function wireYtdlpAutodetect() {
  $('#rl-url').addEventListener('input', () => {
    const url = $('#rl-url').value;
    $('#rl-ytdlp').checked = YTDLP_RE.test(url);
    $('#rl-liveonly').checked = /\/live\/?$/i.test(url.trim());
  });
}

$('#new-relay-btn').addEventListener('click', () => {
  openModal(`<h3>➕ Novo relay</h3>${relayForm()}
    <div class="modal-actions">
      <button class="btn" id="modal-cancel">Cancelar</button>
      <button class="btn primary" id="rl-save">Criar</button>
    </div>`);
  wireYtdlpAutodetect();
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#rl-save').addEventListener('click', async () => {
    try {
      await api('/relays', { method: 'POST', body: readRelayForm() });
      closeModal(); toast('Relay criado!'); loadRelays();
    } catch (err) { toast(err.message, true); }
  });
});

async function editRelay(id) {
  const relays = await api('/relays');
  const r = relays.find((x) => x.id === id);
  if (!r) return;
  openModal(`<h3>⚙️ Editar relay</h3>${relayForm(r)}
    <div class="modal-actions">
      <button class="btn" id="modal-cancel">Cancelar</button>
      <button class="btn primary" id="rl-save">Salvar</button>
    </div>`);
  wireYtdlpAutodetect();
  wireLivesList(r.id);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#rl-save').addEventListener('click', async () => {
    try {
      await api(`/relays/${id}`, { method: 'PATCH', body: readRelayForm() });
      closeModal(); toast('Relay salvo!'); loadRelays();
    } catch (err) { toast(err.message, true); }
  });
}

/* ---------- entradas ao vivo ---------- */

async function loadInputs() {
  const inputs = await api('/inputs');
  $('#input-list').innerHTML = inputs.length === 0
    ? '<p class="muted">Nenhuma entrada criada.</p>'
    : inputs.map((i) => {
        const u = urls(i.key);
        return `<div class="item">
          <div class="item-head">
            <span class="item-title">🎥 ${esc(i.name)}</span>
            <div class="item-actions">
              <button class="btn small" data-preview="${esc(i.key)}">👁 Preview</button>
              <button class="btn small" data-regen-input="${i.id}">🔑 Nova chave</button>
              <button class="btn small danger" data-del-input="${i.id}">🗑️</button>
            </div>
          </div>
          ${urlRow('Servidor (OBS)', u.publishUrl)}
          ${urlRow('Chave de stream', i.key)}
          ${urlRow('Reprodução RTMP', u.rtmp)}
          ${urlRow('Reprodução FLV', u.flv)}
        </div>`;
      }).join('');
}

$('#new-input-btn').addEventListener('click', async () => {
  const name = prompt('Nome da entrada (ex.: OBS estúdio):');
  if (!name) return;
  try {
    await api('/inputs', { method: 'POST', body: { name } });
    toast('Entrada criada!'); loadInputs();
  } catch (err) { toast(err.message, true); }
});

/* ---------- comerciais (campanhas) + as-run ---------- */

function campaignActive(c) {
  const today = new Date().toISOString().slice(0, 10);
  if (!c.enabled) return false;
  if (c.start && today < c.start) return false;
  if (c.end && today > c.end) return false;
  return true;
}

async function loadCampaigns() {
  const [campaigns, videos, channels] = await Promise.all([api('/campaigns'), api('/videos'), api('/channels')]);
  const vById = new Map(videos.map((v) => [v.id, v]));
  const cById = new Map(channels.map((c) => [c.id, c]));
  $('#campaign-list').innerHTML = campaigns.length === 0
    ? '<p class="muted">Nenhuma campanha. Crie uma para veicular um comercial nos intervalos.</p>'
    : campaigns.map((c) => {
        const v = vById.get(c.videoId);
        const alvo = (c.channelIds || []).length ? c.channelIds.map((id) => (cById.get(id) || {}).name || '?').join(', ') : 'todos os canais';
        const periodo = (c.start || c.end) ? `${c.start || '...'} → ${c.end || '...'}` : 'sem data limite';
        const ativa = campaignActive(c);
        return `<div class="item">
          <div class="item-head">
            <span class="item-title">📢 ${esc(c.name)}</span>
            <span class="badge ${ativa ? 'running' : 'stopped'}">${ativa ? 'NO AR' : (c.enabled ? 'FORA DA JANELA' : 'DESATIVADA')}</span>
            <div class="item-actions">
              <button class="btn small" data-edit-campaign="${c.id}">⚙️ Editar</button>
              <button class="btn small danger" data-del-campaign="${c.id}">🗑️</button>
            </div>
          </div>
          <div class="item-sub">🎬 ${esc(v ? v.name : '(vídeo removido)')} · 🗓 ${esc(periodo)} · 🎯 ${esc(alvo)}</div>
        </div>`;
      }).join('');
}

function campaignForm(c, videos, channels) {
  return `
    <div class="form-row"><label>Nome da campanha</label><input type="text" id="cp-name" value="${esc(c.name || '')}" placeholder="Ex.: Refrigerante XPTO"></div>
    <div class="form-row"><label>Vídeo do comercial</label>
      <select id="cp-video">${videos.map((v) => `<option value="${v.id}" ${c.videoId === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('') || '<option value="">(envie um vídeo primeiro)</option>'}</select>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Início (vazio = já)</label><input type="date" id="cp-start" value="${esc(c.start || '')}"></div>
      <div class="form-row"><label>Fim (vazio = sem limite)</label><input type="date" id="cp-end" value="${esc(c.end || '')}"></div>
    </div>
    <div class="form-row">
      <label>Canais (nenhum marcado = todos)</label>
      <div class="playlist-pick" style="max-height:120px">
        ${channels.map((ch) => `<label><input type="checkbox" data-cp-ch="${ch.id}" ${(c.channelIds || []).includes(ch.id) ? 'checked' : ''}> ${esc(ch.name)}</label>`).join('') || '<p class="muted">Sem canais.</p>'}
      </div>
    </div>
    <div class="form-row checkbox-row"><input type="checkbox" id="cp-enabled" ${c.enabled !== false ? 'checked' : ''}><label for="cp-enabled">Ativa</label></div>`;
}

function readCampaignForm() {
  return {
    name: $('#cp-name').value,
    videoId: $('#cp-video').value,
    start: $('#cp-start').value,
    end: $('#cp-end').value,
    channelIds: [...$('#modal').querySelectorAll('[data-cp-ch]:checked')].map((el) => el.dataset.cpCh),
    enabled: $('#cp-enabled').checked
  };
}

async function openCampaign(id) {
  const [campaigns, videos, channels] = await Promise.all([api('/campaigns'), api('/videos'), api('/channels')]);
  const c = id ? campaigns.find((x) => x.id === id) : {};
  if (id && !c) return;
  openModal(`<h3>${id ? '⚙️ Editar' : '➕ Nova'} campanha</h3>${campaignForm(c, videos, channels)}
    <div class="modal-actions">
      <button class="btn" id="modal-cancel">Cancelar</button>
      <button class="btn primary" id="cp-save">Salvar</button>
    </div>`);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#cp-save').addEventListener('click', async () => {
    const body = readCampaignForm();
    if (!body.name.trim()) return toast('Informe o nome', true);
    if (!body.videoId) return toast('Selecione o vídeo do comercial', true);
    try {
      if (id) await api(`/campaigns/${id}`, { method: 'PATCH', body });
      else await api('/campaigns', { method: 'POST', body });
      closeModal(); toast('Campanha salva!'); loadCampaigns();
    } catch (err) { toast(err.message, true); }
  });
}

$('#new-campaign-btn').addEventListener('click', () => openCampaign(null));

$('#asrun-btn').addEventListener('click', async () => {
  let log = [], report = [];
  try { [log, report] = await Promise.all([api('/asrun?n=200'), api('/asrun/report?days=7')]); } catch (err) { return toast(err.message, true); }
  const repHtml = report.length
    ? `<table class="asrun-rep"><tr><th>Comercial</th><th>Inserções (7d)</th><th>Última</th></tr>${report.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.count}</td><td>${esc(r.last.replace('T', ' ').slice(0, 19))}</td></tr>`).join('')}</table>`
    : '<p class="muted">Nenhuma veiculação de comercial nos últimos 7 dias.</p>';
  const TYPE = { program: '🎬', ad: '📢', break: '📺', live: '🔴', offair: '⏹' };
  const logHtml = log.length
    ? log.map((e) => `<div class="asrun-line"><span class="t">${esc(e.t.replace('T', ' ').slice(0, 19))}</span> ${TYPE[e.type] || ''} <b>${esc(e.channel)}</b> — ${esc(e.title)}</div>`).join('')
    : '<p class="muted">As-run vazio ainda.</p>';
  openModal(`<h3>📜 As-run & relatório de veiculação</h3>
    <h4 style="margin:6px 0">Comerciais (últimos 7 dias)</h4>${repHtml}
    <h4 style="margin:14px 0 6px">Registro do que foi ao ar</h4>
    <div class="logs">${logHtml}</div>
    <div class="modal-actions">
      <a class="btn" href="/api/asrun/download" target="_blank">⬇️ Baixar as-run completo</a>
      <button class="btn" id="modal-cancel">Fechar</button>
    </div>`);
  $('#modal-cancel').addEventListener('click', closeModal);
});

/* ---------- logs e preview ---------- */

async function showLogs(type, id) {
  const items = await api('/' + type);
  const item = items.find((x) => x.id === id);
  if (!item) return;
  openModal(`<h3>📜 Logs — ${esc(item.name)}</h3>
    <div class="logs">${esc((item.logs || []).join('\n') || 'Sem logs.')}</div>
    <div class="modal-actions"><button class="btn" id="modal-cancel">Fechar</button></div>`);
  $('#modal-cancel').addEventListener('click', closeModal);
}

function showPreview(key) {
  const u = urls(key);
  openModal(`<h3>👁 Preview</h3>
    <div class="player-box"><video id="preview-video" controls autoplay muted></video></div>
    <p class="muted" style="margin-top:8px">O preview usa o link FLV em modo baixa latência (persegue a borda ao vivo sozinho).
      <span id="latency-label"></span></p>
    ${urlRow('RTMP', u.rtmp)}${urlRow('FLV', u.flv)}
    <div class="modal-actions"><button class="btn" id="modal-cancel">Fechar</button></div>`);
  $('#modal-cancel').addEventListener('click', closeModal);

  if (window.mpegts && mpegts.isSupported()) {
    const video = $('#preview-video');
    let alive = true;

    function startPlayer() {
      const player = mpegts.createPlayer(
        { type: 'flv', isLive: true, url: u.flv },
        {
          // Sem buffer de acúmulo + perseguição de latência nativa: se o player
          // ficar para trás da borda ao vivo, ele pula para perto dela ("truque
          // do 2x" automatizado)
          enableStashBuffer: false,
          stashInitialSize: 128,
          liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: 4,
          liveBufferLatencyMinRemain: 0.5
        }
      );
      player.attachMediaElement(video);
      player.load();
      player.play().catch(() => {});

      // Complemento suave: entre 2s e 4s de atraso, acelera 1.15x para colar
      // na live sem o "pulo" do seek. Também exibe a latência atual.
      const chaser = setInterval(() => {
        if (!video.buffered || video.buffered.length === 0) return;
        const latency = video.buffered.end(video.buffered.length - 1) - video.currentTime;
        const label = $('#latency-label');
        if (label) {
          label.textContent = `· latência do player: ${latency.toFixed(1)}s` +
            (video.playbackRate > 1 ? ' ⏩ acelerando' : '');
        }
        if (latency > 2) video.playbackRate = 1.15;
        else if (latency < 1.2 && video.playbackRate !== 1) video.playbackRate = 1.0;
      }, 1000);

      const oldDestroy = player.destroy.bind(player);
      const cleanup = () => { clearInterval(chaser); try { oldDestroy(); } catch {} };

      // Reconecta sozinho quando o stream cai/troca de fonte (o servidor
      // reinicia o ffmpeg ao alternar live/playlist — a queda dura ~2s)
      const retry = () => {
        if (!alive) return;
        const label = $('#latency-label');
        if (label) label.textContent = '· reconectando...';
        cleanup();
        setTimeout(() => { if (alive) startPlayer(); }, 2500);
      };
      player.on(mpegts.Events.ERROR, retry);
      player.on(mpegts.Events.LOADING_COMPLETE, retry);

      // closeModal() destrói via flvPlayer: aí sim a reconexão para de vez
      player.destroy = () => { alive = false; cleanup(); };
      flvPlayer = player;
    }

    startPlayer();
  } else {
    toast('Navegador sem suporte a FLV — use o link RTMP no VLC', true);
  }
}

/* ---------- delegação de cliques ---------- */

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-copy],[data-preview],[data-start-channel],[data-stop-channel],[data-edit-channel],[data-logs-channel],[data-del-channel],[data-start-relay],[data-stop-relay],[data-edit-relay],[data-logs-relay],[data-del-relay],[data-del-video],[data-rename-video],[data-renorm-video],[data-split-video],[data-edit-playlist],[data-del-playlist],[data-edit-campaign],[data-del-campaign],[data-regen-input],[data-del-input]');
  if (!t) return;
  const d = t.dataset;
  // Evita clique duplo disparar a mesma ação duas vezes (ex.: dois starts)
  if (t.tagName === 'BUTTON') {
    if (t.disabled) return;
    t.disabled = true;
  }
  try {
    if (d.copy) copyText(d.copy);
    else if (d.preview) showPreview(d.preview);
    else if (d.startChannel) { await api(`/channels/${d.startChannel}/start`, { method: 'POST' }); toast('Canal iniciado!'); loadChannels(); }
    else if (d.stopChannel) { await api(`/channels/${d.stopChannel}/stop`, { method: 'POST' }); toast('Canal parado.'); loadChannels(); }
    else if (d.editChannel) editChannel(d.editChannel);
    else if (d.logsChannel) showLogs('channels', d.logsChannel);
    else if (d.delChannel) {
      if (confirm('Excluir este canal? O stream será interrompido.')) {
        await api(`/channels/${d.delChannel}`, { method: 'DELETE' }); toast('Canal excluído.'); loadChannels();
      }
    }
    else if (d.startRelay) { await api(`/relays/${d.startRelay}/start`, { method: 'POST' }); toast('Relay iniciado!'); loadRelays(); }
    else if (d.stopRelay) { await api(`/relays/${d.stopRelay}/stop`, { method: 'POST' }); toast('Relay parado.'); loadRelays(); }
    else if (d.editRelay) editRelay(d.editRelay);
    else if (d.logsRelay) showLogs('relays', d.logsRelay);
    else if (d.delRelay) {
      if (confirm('Excluir este relay?')) {
        await api(`/relays/${d.delRelay}`, { method: 'DELETE' }); toast('Relay excluído.'); loadRelays();
      }
    }
    else if (d.delVideo) {
      if (confirm('Excluir este vídeo do acervo?')) {
        try {
          await api(`/videos/${d.delVideo}`, { method: 'DELETE' });
        } catch (err) {
          if (!confirm(err.message + '\n\nExcluir mesmo assim?')) return;
          await api(`/videos/${d.delVideo}?force=true`, { method: 'DELETE' });
        }
        toast('Vídeo excluído.'); loadVideos();
      }
    }
    else if (d.renameVideo) {
      const name = prompt('Novo nome:', d.name);
      if (name) { await api(`/videos/${d.renameVideo}`, { method: 'PATCH', body: { name } }); loadVideos(); }
    }
    else if (d.renormVideo) {
      await api(`/videos/${d.renormVideo}/normalize`, { method: 'POST' });
      toast('Normalização reenfileirada.'); loadVideos();
    }
    else if (d.splitVideo) {
      const videos = await api('/videos');
      const v = videos.find((x) => x.id === d.splitVideo);
      if (v) showSplitModal(v.id, v.name);
    }
    else if (d.editPlaylist) editPlaylist(d.editPlaylist);
    else if (d.delPlaylist) {
      if (confirm('Excluir esta playlist?')) {
        await api(`/playlists/${d.delPlaylist}`, { method: 'DELETE' });
        toast('Playlist excluída.'); loadPlaylists();
      }
    }
    else if (d.editCampaign) openCampaign(d.editCampaign);
    else if (d.delCampaign) {
      if (confirm('Excluir esta campanha?')) {
        await api(`/campaigns/${d.delCampaign}`, { method: 'DELETE' });
        toast('Campanha excluída.'); loadCampaigns();
      }
    }
    else if (d.regenInput) {
      if (confirm('Gerar nova chave? A chave atual deixará de funcionar.')) {
        await api(`/inputs/${d.regenInput}/regenerate-key`, { method: 'POST' }); toast('Nova chave gerada.'); loadInputs();
      }
    }
    else if (d.delInput) {
      if (confirm('Excluir esta entrada?')) {
        await api(`/inputs/${d.delInput}`, { method: 'DELETE' }); toast('Entrada excluída.'); loadInputs();
      }
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (t.tagName === 'BUTTON') t.disabled = false;
  }
});

/* ---------- init ---------- */

(async () => {
  try {
    await api('/me');
    await showApp();
  } catch {
    showLogin();
  }
})();
