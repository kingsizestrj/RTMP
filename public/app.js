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
    publishUrl: `rtmp://${host()}:${serverInfo.rtmpPort}/live`
  };
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(
    () => toast('Copiado!'),
    () => toast('Não foi possível copiar', true)
  );
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
    dashboard: loadDashboard, videos: loadVideos,
    channels: loadChannels, relays: loadRelays, inputs: loadInputs
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

const dz = $('#drop-zone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
dz.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

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
            ${statusBadge(c.status)}
            ${c.status === 'running' ? `<span class="muted">há ${fmtUptime(c.uptime)}</span>` : ''}
            <div class="item-actions">
              ${running
                ? `<button class="btn small" data-stop-channel="${c.id}">⏹ Parar</button>`
                : `<button class="btn small primary" data-start-channel="${c.id}">▶ Iniciar</button>`}
              <button class="btn small" data-preview="${esc(c.key)}">👁 Preview</button>
              <button class="btn small" data-edit-channel="${c.id}">⚙️ Editar</button>
              <button class="btn small" data-logs-channel="${c.id}">📜 Logs</button>
              <button class="btn small danger" data-del-channel="${c.id}">🗑️</button>
            </div>
          </div>
          <div class="item-sub">
            ${(c.videoIds || []).length} vídeo(s)${c.mode === 'normalized' && c.readyCount < (c.videoIds || []).length ? ` <span style="color:var(--yellow)">(${c.readyCount} normalizados)</span>` : ''}
            · ${modeLabel(c.mode)}${c.mode === 'transcode' ? ` ${esc(c.resolution)} @ ${esc(c.videoBitrate)}` : ''}
            ${c.shuffle ? ' · 🔀 aleatório' : ''}${c.autostart ? ' · ⏯ autostart' : ''}
            ${c.restarts ? ` · ${c.restarts} restart(s)` : ''}${speedInfo(c)}
          </div>
          ${urlRow('RTMP', u.rtmp)}${urlRow('FLV', u.flv)}
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
  const [channels, videos] = await Promise.all([api('/channels'), api('/videos')]);
  const c = channels.find((x) => x.id === id);
  if (!c) return;
  const byId = new Map(videos.map((v) => [v.id, v]));
  let order = (c.videoIds || []).filter((vid) => byId.has(vid));

  function playlistHtml() {
    return order.map((vid, i) => `
      <div class="playlist-item">
        <span class="muted">${i + 1}.</span>
        <span class="name">${esc(byId.get(vid).name)}</span>
        <button class="btn small" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn small" data-down="${i}" ${i === order.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn small danger" data-rm="${i}">✕</button>
      </div>`).join('') || '<p class="muted">Playlist vazia.</p>';
  }

  openModal(`
    <h3>⚙️ Editar canal</h3>
    <div class="form-row"><label>Nome</label><input type="text" id="ch-name" value="${esc(c.name)}"></div>
    <div class="form-row">
      <label>Playlist (ordem de reprodução)</label>
      <div id="ch-playlist">${playlistHtml()}</div>
      <label style="margin-top:10px">Adicionar vídeos</label>
      <div class="playlist-pick">
        ${videos.map((v) => `<label><input type="checkbox" data-add-video="${v.id}"> ${esc(v.name)} <span class="muted">(${fmtDuration(v.duration)})</span></label>`).join('') || '<p class="muted">Envie vídeos na aba Vídeos primeiro.</p>'}
      </div>
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

  const playlistEl = $('#ch-playlist');
  playlistEl.addEventListener('click', (e) => {
    const up = e.target.dataset.up, down = e.target.dataset.down, rm = e.target.dataset.rm;
    if (up != null) { const i = +up; [order[i - 1], order[i]] = [order[i], order[i - 1]]; }
    else if (down != null) { const i = +down; [order[i], order[i + 1]] = [order[i + 1], order[i]]; }
    else if (rm != null) order.splice(+rm, 1);
    else return;
    playlistEl.innerHTML = playlistHtml();
  });

  $('#modal').querySelectorAll('[data-add-video]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const vid = cb.dataset.addVideo;
      if (cb.checked) { if (!order.includes(vid)) order.push(vid); }
      else order = order.filter((x) => x !== vid);
      playlistEl.innerHTML = playlistHtml();
    });
  });

  // Opções de transcode só fazem sentido no modo "transcode"
  const syncTranscodeOpts = () => {
    $('#ch-transcode-opts').style.display = $('#ch-mode').value === 'transcode' ? '' : 'none';
  };
  $('#ch-mode').addEventListener('change', syncTranscodeOpts);
  syncTranscodeOpts();

  $('#modal-cancel').addEventListener('click', closeModal);
  $('#ch-save').addEventListener('click', async () => {
    try {
      await api(`/channels/${id}`, {
        method: 'PATCH',
        body: {
          name: $('#ch-name').value,
          videoIds: order,
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
          <div class="item-sub">${r.mode === 'copy' ? 'cópia direta' : `transcode ${esc(r.resolution)}`}${r.ytdlp ? ' · ▶️ yt-dlp' : ''}${r.loop ? ' · 🔁 loop' : ''}${r.autostart ? ' · ⏯ autostart' : ''}${r.restarts ? ` · ${r.restarts} restart(s)` : ''}${speedInfo(r)}</div>
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
    mode: $('#rl-mode').value,
    resolution: $('#rl-res').value,
    loop: $('#rl-loop').checked,
    autostart: $('#rl-autostart').checked
  };
}

// Marca o yt-dlp sozinho quando o usuário cola um link de site suportado
function wireYtdlpAutodetect() {
  $('#rl-url').addEventListener('input', () => {
    $('#rl-ytdlp').checked = YTDLP_RE.test($('#rl-url').value);
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
    <p class="muted" style="margin-top:8px">O preview usa o link FLV. O stream precisa estar no ar.</p>
    ${urlRow('RTMP', u.rtmp)}${urlRow('FLV', u.flv)}
    <div class="modal-actions"><button class="btn" id="modal-cancel">Fechar</button></div>`);
  $('#modal-cancel').addEventListener('click', closeModal);

  if (window.flvjs && flvjs.isSupported()) {
    flvPlayer = flvjs.createPlayer({ type: 'flv', isLive: true, url: u.flv });
    flvPlayer.attachMediaElement($('#preview-video'));
    flvPlayer.load();
    flvPlayer.play().catch(() => {});
  } else {
    toast('Navegador sem suporte a FLV — use o link RTMP no VLC', true);
  }
}

/* ---------- delegação de cliques ---------- */

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-copy],[data-preview],[data-start-channel],[data-stop-channel],[data-edit-channel],[data-logs-channel],[data-del-channel],[data-start-relay],[data-stop-relay],[data-edit-relay],[data-logs-relay],[data-del-relay],[data-del-video],[data-rename-video],[data-renorm-video],[data-regen-input],[data-del-input]');
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
