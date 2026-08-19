const camerasEl = document.querySelector('#cameras');
const emptyEl = document.querySelector('#empty');
const noticeEl = document.querySelector('#notice');
const formDialog = document.querySelector('#camera-dialog');
const filesDialog = document.querySelector('#files-dialog');
const form = document.querySelector('#camera-form');
const player = document.querySelector('#player');
let cameras = [];
let statuses = [];
let displayedFiles = [];

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const bytes = (value) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
const duration = (seconds) => seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
const friendlyVideoName = (file) => {
  const start = fileStart(file);
  return Number.isFinite(start)
    ? new Date(start).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })
    : file.name;
};

function notify(message, error = false) {
  noticeEl.textContent = message;
  noticeEl.className = error ? 'notice error' : 'notice';
  setTimeout(() => { noticeEl.textContent = ''; noticeEl.className = ''; }, 4000);
}

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let body = {};
    try { body = await response.json(); } catch {}
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

function render() {
  camerasEl.innerHTML = cameras.map((camera) => {
    const status = statuses.find((item) => item.id === camera.id);
    const running = status?.running;
    return `<article class="camera-card">
      <div class="card-top"><div><h2>${escapeHtml(camera.name)}</h2><span class="status ${running ? 'running' : 'stopped'}"><i></i>${running ? 'Recording' : 'Stopped'}</span></div><div class="menu"><button class="secondary small" data-action="edit" data-id="${camera.id}">Edit</button></div></div>
      <dl><div><dt>Limit</dt><dd>${escapeHtml(camera.maxSizeGb)} GB</dd></div><div><dt>Events</dt><dd>${camera.eventsEnabled ? 'Reolink AI' : 'Off'}</dd></div><div><dt>Format</dt><dd>${escapeHtml(camera.container.toUpperCase())}</dd></div><div><dt>Uptime</dt><dd>${status ? duration(status.uptimeSeconds) : '—'}</dd></div></dl>
      ${status?.lastError ? `<p class="last-error" title="${escapeHtml(status.lastError)}">${escapeHtml(status.lastError)}</p>` : ''}
      <button class="wide-button" data-action="files" data-id="${camera.id}">View recordings</button>
    </article>`;
  }).join('');
  emptyEl.hidden = cameras.length !== 0;
}

async function load() {
  try {
    const [config, nextStatuses] = await Promise.all([request('/api/config'), request('/api/status')]);
    cameras = config.cameras;
    statuses = nextStatuses;
    document.querySelector('#root').textContent = `v${config.appVersion} · ${config.chunkMinutes}-minute stream-copy chunks · ${config.recordingRoot}`;
    render();
  } catch (error) { notify(error.message, true); }
}

function openForm(camera = null) {
  document.querySelector('#form-title').textContent = camera ? 'Edit camera' : 'Add camera';
  document.querySelector('#camera-id').value = camera?.id || '';
  document.querySelector('#name').value = camera?.name || '';
  document.querySelector('#url').value = camera?.url || '';
  document.querySelector('#limit').value = camera?.maxSizeGb || 100;
  document.querySelector('#container').value = camera?.container || 'mp4';
  document.querySelector('#events-enabled').checked = camera ? Boolean(camera.eventsEnabled) : true;
  document.querySelector('#api-protocol').value = camera?.apiProtocol || 'http';
  document.querySelector('#api-port').value = camera?.apiPort || 80;
  let remove = document.querySelector('#remove-camera');
  if (camera && !remove) {
    remove = document.createElement('button'); remove.type = 'button'; remove.id = 'remove-camera'; remove.className = 'danger'; remove.textContent = 'Remove camera';
    document.querySelector('.actions').prepend(remove);
    remove.onclick = removeCamera;
  } else if (!camera && remove) remove.remove();
  formDialog.showModal();
}

async function removeCamera() {
  const id = document.querySelector('#camera-id').value;
  const camera = cameras.find((item) => item.id === id);
  if (!confirm(`Remove ${camera.name}? Existing recordings will be retained on disk.`)) return;
  try { await request(`/api/cameras/${id}`, { method: 'DELETE' }); formDialog.close(); notify('Camera removed.'); await load(); } catch (error) { notify(error.message, true); }
}

form.onsubmit = async (event) => {
  event.preventDefault();
  const id = document.querySelector('#camera-id').value;
  const body = { name: document.querySelector('#name').value, url: document.querySelector('#url').value, maxSizeGb: Number(document.querySelector('#limit').value), container: document.querySelector('#container').value, eventsEnabled: document.querySelector('#events-enabled').checked, apiProtocol: document.querySelector('#api-protocol').value, apiPort: Number(document.querySelector('#api-port').value), apiChannel: 0 };
  try {
    await request(id ? `/api/cameras/${id}` : '/api/cameras', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    formDialog.close(); notify(id ? 'Camera updated.' : 'Camera added.'); await load();
  } catch (error) { notify(error.message, true); }
};

async function openFiles(id) {
  const camera = cameras.find((item) => item.id === id);
  document.querySelector('#files-title').textContent = `${camera.name} recordings`;
  document.querySelector('#files-list').innerHTML = '<p>Loading…</p>';
  player.removeAttribute('src'); player.load(); filesDialog.dataset.cameraId = id; filesDialog.showModal();
  displayedFiles = [];
  document.querySelector('#find-time').value = localDateTimeValue(new Date());
  document.querySelector('#find-time-message').textContent = '';
  try {
    const files = await request(`/api/cameras/${id}/files`);
    displayedFiles = files;
    document.querySelector('#files-list').innerHTML = files.map((file) => {
      const url = `/api/cameras/${encodeURIComponent(id)}/files/${encodeURIComponent(file.name)}`;
      const markers = (file.events || []).map(event => `<button class="marker ${event.type.toLowerCase()}" data-play="${url}" data-offset="${event.offsetSeconds}" title="Play at ${event.offsetSeconds}s">${escapeHtml(event.type)} · ${event.offsetSeconds}s</button>`).join('');
      return `<div class="file"><div><b title="${escapeHtml(file.name)}">${escapeHtml(friendlyVideoName(file))}</b><span>10-minute recording · ${bytes(file.size)}</span>${markers ? `<div class="markers">${markers}</div>` : ''}</div><div><button class="secondary small" data-play="${url}">Play</button><a class="button small" href="${url}" download>Download</a></div></div>`;
    }).join('') || '<p>No completed chunks yet. The first appears after approximately 10 minutes.</p>';
  } catch (error) { document.querySelector('#files-list').innerHTML = `<p class="last-error">${escapeHtml(error.message)}</p>`; }
}

function localDateTimeValue(date) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fileStart(file) {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(file.name);
  return match ? new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]).getTime() : NaN;
}

function playAt(url, offset = 0) {
  player.src = url;
  player.onloadedmetadata = () => {
    player.currentTime = Math.min(Math.max(0, offset), Number.isFinite(player.duration) ? player.duration : offset);
    player.play().catch(() => {});
  };
  if (!offset) player.play().catch(() => {});
}

document.querySelector('#find-time-button').onclick = () => {
  const target = new Date(document.querySelector('#find-time').value).getTime();
  const message = document.querySelector('#find-time-message');
  if (!Number.isFinite(target)) { message.textContent = 'Choose a valid date and time.'; return; }
  const candidates = displayedFiles.map(file => ({ file, start: fileStart(file) })).filter(item => Number.isFinite(item.start)).sort((a, b) => a.start - b.start);
  const item = candidates.find((candidate, index) => target >= candidate.start && target < Math.min(candidates[index + 1]?.start || Infinity, candidate.start + 10 * 60_000));
  if (!item) { message.textContent = 'No retained recording contains that time.'; return; }
  const offset = Math.floor((target - item.start) / 1000);
  const id = filesDialog.dataset.cameraId;
  message.textContent = `${friendlyVideoName(item.file)} · ${offset}s into recording`;
  playAt(`/api/cameras/${encodeURIComponent(id)}/files/${encodeURIComponent(item.file.name)}`, offset);
};

camerasEl.onclick = (event) => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  if (button.dataset.action === 'edit') openForm(cameras.find((camera) => camera.id === button.dataset.id));
  if (button.dataset.action === 'files') openFiles(button.dataset.id);
};
document.querySelector('#files-list').onclick = (event) => { const button = event.target.closest('button[data-play]'); if (button) playAt(button.dataset.play, Number(button.dataset.offset) || 0); };
document.querySelector('#api-protocol').onchange = (event) => { document.querySelector('#api-port').value = event.target.value === 'https' ? 443 : 80; };
document.querySelector('#open-add').onclick = () => openForm();
document.querySelector('#close-dialog').onclick = document.querySelector('#cancel-dialog').onclick = () => formDialog.close();
document.querySelector('#close-files').onclick = () => filesDialog.close();
filesDialog.addEventListener('close', () => { player.pause(); player.removeAttribute('src'); player.load(); });

load();
setInterval(async () => { try { statuses = await request('/api/status'); render(); } catch {} }, 5000);
