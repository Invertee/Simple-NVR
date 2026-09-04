const camerasEl = document.querySelector('#camera-select');
const emptyEl = document.querySelector('#empty');
const workspaceEl = document.querySelector('#workspace');
const noticeEl = document.querySelector('#notice');
const formDialog = document.querySelector('#camera-dialog');
const form = document.querySelector('#camera-form');
const player = document.querySelector('#player');
const filesListEl = document.querySelector('#files-list');
const timelineTrack = document.querySelector('#timeline-track');
const timelineRecordings = document.querySelector('#timeline-recordings');
const timelineGaps = document.querySelector('#timeline-gaps');
const timelineEvents = document.querySelector('#timeline-events');
const timelinePlayhead = document.querySelector('#timeline-playhead');

let cameras = [];
let statuses = [];
let displayedFiles = [];
let currentCameraId = '';
let currentFile = null;
let selectedDay = '';
let dayStartMs = 0;
let dayEndMs = 0;
let chunkMinutes = 10;
let scrubActive = false;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const bytes = (value) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
const duration = (seconds) => seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
const pad = (number) => String(number).padStart(2, '0');

function friendlyDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium', hour12: true });
}

function friendlyVideoName(file) {
  const start = fileStart(file);
  return Number.isFinite(start)
    ? new Date(start).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })
    : file.name;
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

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

function fileStart(file) {
  if (file.startTime) {
    const timestamp = new Date(file.startTime).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(file.name);
  return match ? new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]).getTime() : NaN;
}

function fileEnd(file) {
  if (file.endTime) {
    const timestamp = new Date(file.endTime).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  const start = fileStart(file);
  return Number.isFinite(start) ? start + chunkMinutes * 60_000 : NaN;
}

function fileUrl(file) {
  return `/api/cameras/${encodeURIComponent(currentCameraId)}/files/${encodeURIComponent(file.name)}`;
}

function cameraStatus(id) {
  return statuses.find((item) => item.id === id);
}

function renderCameraControls() {
  const previous = currentCameraId;
  camerasEl.innerHTML = cameras.map((camera) => `<option value="${escapeHtml(camera.id)}">${escapeHtml(camera.name)}</option>`).join('');
  currentCameraId = cameras.some((camera) => camera.id === previous) ? previous : cameras[0]?.id || '';
  camerasEl.value = currentCameraId;
  camerasEl.disabled = !currentCameraId;
  document.querySelector('#edit-camera').disabled = !currentCameraId;
  emptyEl.hidden = cameras.length !== 0;
  workspaceEl.hidden = cameras.length === 0;
  renderSelectedCameraStatus();
}

function renderSelectedCameraStatus() {
  const camera = cameras.find((item) => item.id === currentCameraId);
  const status = cameraStatus(currentCameraId);
  const statusEl = document.querySelector('#camera-status');
  const warningEl = document.querySelector('#camera-warning');
  if (!camera) {
    statusEl.textContent = '';
    statusEl.title = '';
    warningEl.hidden = true;
    warningEl.textContent = '';
    document.querySelector('#viewer-title').textContent = 'Camera';
    document.querySelector('#viewer-meta').textContent = '';
    return;
  }
  const running = Boolean(status?.running);
  statusEl.className = `camera-status ${running ? 'running' : 'stopped'}`;
  statusEl.innerHTML = `<i></i><span>${running ? 'Recording' : 'Stopped'}${status ? ` - uptime ${duration(status.uptimeSeconds)}` : ''}</span>`;
  statusEl.title = status?.lastError || '';
  warningEl.hidden = !status?.lastError;
  warningEl.textContent = status?.lastError || '';
  document.querySelector('#viewer-title').textContent = camera.name;
  document.querySelector('#viewer-meta').textContent = `${camera.container.toUpperCase()} - ${camera.maxSizeGb} GB limit${camera.eventsEnabled ? ' - Reolink AI events' : ''}`;
}

async function load() {
  try {
    const [config, nextStatuses] = await Promise.all([request('/api/config'), request('/api/status')]);
    cameras = config.cameras;
    statuses = nextStatuses;
    chunkMinutes = Number(config.chunkMinutes) || 10;
    document.querySelector('#root').textContent = `v${config.appVersion} - Started ${friendlyDateTime(config.appStartedAt)} - ${chunkMinutes}-minute stream-copy chunks - ${config.recordingRoot}`;
    const oldCameraId = currentCameraId;
    renderCameraControls();
    if (currentCameraId && currentCameraId !== oldCameraId) await loadFiles();
    if (!currentCameraId) clearPlayback();
  } catch (error) {
    notify(error.message, true);
  }
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
    remove = document.createElement('button');
    remove.type = 'button';
    remove.id = 'remove-camera';
    remove.className = 'danger';
    remove.textContent = 'Remove camera';
    document.querySelector('.actions').prepend(remove);
    remove.onclick = removeCamera;
  } else if (!camera && remove) {
    remove.remove();
  }
  formDialog.showModal();
}

async function removeCamera() {
  const id = document.querySelector('#camera-id').value;
  const camera = cameras.find((item) => item.id === id);
  if (!camera || !confirm(`Remove ${camera.name}? Existing recordings will be retained on disk.`)) return;
  try {
    await request(`/api/cameras/${id}`, { method: 'DELETE' });
    formDialog.close();
    if (currentCameraId === id) currentCameraId = '';
    notify('Camera removed.');
    await load();
  } catch (error) {
    notify(error.message, true);
  }
}

form.onsubmit = async (event) => {
  event.preventDefault();
  const id = document.querySelector('#camera-id').value;
  const body = {
    name: document.querySelector('#name').value,
    url: document.querySelector('#url').value,
    maxSizeGb: Number(document.querySelector('#limit').value),
    container: document.querySelector('#container').value,
    eventsEnabled: document.querySelector('#events-enabled').checked,
    apiProtocol: document.querySelector('#api-protocol').value,
    apiPort: Number(document.querySelector('#api-port').value),
    apiChannel: 0
  };
  try {
    const saved = await request(id ? `/api/cameras/${id}` : '/api/cameras', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    formDialog.close();
    currentCameraId = saved.id;
    notify(id ? 'Camera updated.' : 'Camera added.');
    await load();
    await loadFiles();
  } catch (error) {
    notify(error.message, true);
  }
};

async function selectCamera(id) {
  if (!id || id === currentCameraId && displayedFiles.length) return;
  currentCameraId = id;
  camerasEl.value = id;
  displayedFiles = [];
  selectedDay = '';
  clearPlayback();
  renderSelectedCameraStatus();
  await loadFiles();
}

async function loadFiles() {
  if (!currentCameraId) return;
  filesListEl.innerHTML = '<div class="files-empty">Loading recordings...</div>';
  try {
    displayedFiles = await request(`/api/cameras/${encodeURIComponent(currentCameraId)}/files`);
    displayedFiles.sort((a, b) => fileStart(a) - fileStart(b));
    if (currentFile) currentFile = displayedFiles.find((file) => file.name === currentFile.name) || currentFile;
    const latest = displayedFiles.at(-1);
    const requestedDay = selectedDay || (latest ? dateKey(fileStart(latest)) : dateKey(new Date()));
    setSelectedDay(requestedDay);
  } catch (error) {
    displayedFiles = [];
    filesListEl.innerHTML = `<div class="files-empty">${escapeHtml(error.message)}</div>`;
    renderTimeline();
  }
}

function setSelectedDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  selectedDay = value;
  document.querySelector('#timeline-date').value = value;
  const [year, month, day] = value.split('-').map(Number);
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day + 1);
  dayStartMs = start.getTime();
  dayEndMs = end.getTime();
  document.querySelector('#timeline-title').textContent = start.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  document.querySelector('#recordings-title').textContent = start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  timelineTrack.setAttribute('aria-valuemax', String(Math.round((dayEndMs - dayStartMs) / 1000)));
  renderRecordings();
  renderTimeline();
}

function filesForSelectedDay() {
  return displayedFiles.filter((file) => {
    const start = fileStart(file);
    const end = fileEnd(file);
    return Number.isFinite(start) && Number.isFinite(end) && end > dayStartMs && start < dayEndMs;
  });
}

function renderRecordings() {
  const files = filesForSelectedDay().slice().sort((a, b) => fileStart(b) - fileStart(a));
  document.querySelector('#recordings-count').textContent = String(files.length);
  filesListEl.innerHTML = files.map((file) => {
    const start = fileStart(file);
    const end = fileEnd(file);
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    const events = file.events || [];
    const markers = events.map((event) => {
      const eventClass = String(event.type || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      const offset = Number(event.offsetSeconds) || 0;
      return `<button class="marker ${eventClass}" type="button" data-event-file="${escapeHtml(file.name)}" data-event-offset="${offset}">${escapeHtml(event.type)} ${Math.floor(offset / 60)}:${pad(Math.floor(offset % 60))}</button>`;
    }).join('');
    return `<div class="file${currentFile?.name === file.name ? ' active' : ''}" data-file-name="${escapeHtml(file.name)}">
      <div class="file-main">
        <div class="file-info"><b title="${escapeHtml(file.name)}">${escapeHtml(friendlyVideoName(file))}</b><span>${duration(seconds)} - ${bytes(file.size)}${events.length ? ` - ${events.length} event${events.length === 1 ? '' : 's'}` : ''}</span></div>
        <div class="file-actions"><button class="secondary small" type="button" data-play-file="${escapeHtml(file.name)}">Play</button><a class="button small" href="${fileUrl(file)}" download>Download</a></div>
      </div>
      ${markers ? `<div class="markers">${markers}</div>` : ''}
    </div>`;
  }).join('') || '<div class="files-empty">No retained recordings on this day.</div>';
}

function mergeCoverage(files) {
  const tolerance = 5000;
  const ranges = files
    .map((file) => ({ start: Math.max(dayStartMs, fileStart(file)), end: Math.min(dayEndMs, fileEnd(file)) }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end + tolerance) merged.push({ ...range });
    else previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

function internalGaps(coverage) {
  const gaps = [];
  for (let index = 1; index < coverage.length; index += 1) {
    if (coverage[index].start > coverage[index - 1].end + 5000) gaps.push({ start: coverage[index - 1].end, end: coverage[index].start });
  }
  return gaps;
}

function rangeStyle(start, end) {
  const span = dayEndMs - dayStartMs;
  const left = Math.max(0, Math.min(1, (start - dayStartMs) / span));
  const right = Math.max(left, Math.min(1, (end - dayStartMs) / span));
  return `left:${(left * 100).toFixed(5)}%;width:${((right - left) * 100).toFixed(5)}%`;
}

function renderTimeline() {
  if (!dayStartMs || !dayEndMs) return;
  const files = filesForSelectedDay().slice().sort((a, b) => fileStart(a) - fileStart(b));
  timelineRecordings.innerHTML = files.map((file) => `<div class="timeline-segment${currentFile?.name === file.name ? ' active' : ''}" style="${rangeStyle(Math.max(dayStartMs, fileStart(file)), Math.min(dayEndMs, fileEnd(file)))}" title="${escapeHtml(friendlyVideoName(file))}"></div>`).join('');

  const coverage = mergeCoverage(files);
  const gaps = internalGaps(coverage);
  timelineGaps.innerHTML = gaps.map((gap) => `<div class="timeline-gap" style="${rangeStyle(gap.start, gap.end)}" title="Gap ${escapeHtml(new Date(gap.start).toLocaleTimeString())} to ${escapeHtml(new Date(gap.end).toLocaleTimeString())}"></div>`).join('');

  const eventRows = [];
  for (const file of files) {
    const start = fileStart(file);
    for (const event of file.events || []) {
      const timestamp = start + (Number(event.offsetSeconds) || 0) * 1000;
      if (timestamp >= dayStartMs && timestamp < dayEndMs) {
        const left = ((timestamp - dayStartMs) / (dayEndMs - dayStartMs)) * 100;
        eventRows.push(`<div class="timeline-event" style="left:${left.toFixed(5)}%" title="${escapeHtml(event.type)} - ${escapeHtml(new Date(timestamp).toLocaleTimeString())}"></div>`);
      }
    }
  }
  timelineEvents.innerHTML = eventRows.join('');

  const totalRecordedMs = coverage.reduce((sum, range) => sum + range.end - range.start, 0);
  const totalGapMs = gaps.reduce((sum, gap) => sum + gap.end - gap.start, 0);
  const summary = document.querySelector('#timeline-summary');
  if (!files.length) {
    summary.className = 'timeline-summary';
    summary.textContent = 'No retained recording coverage on this day.';
  } else if (gaps.length) {
    summary.className = 'timeline-summary warning';
    summary.textContent = `${duration(Math.round(totalRecordedMs / 1000))} retained - ${gaps.length} gap${gaps.length === 1 ? '' : 's'} totalling ${duration(Math.round(totalGapMs / 1000))}.`;
  } else {
    summary.className = 'timeline-summary';
    summary.textContent = `${duration(Math.round(totalRecordedMs / 1000))} retained - no gaps between the first and last recording.`;
  }
}

function clearPlayback() {
  currentFile = null;
  player.pause();
  player.removeAttribute('src');
  player.load();
  timelinePlayhead.hidden = true;
  document.querySelector('#playback-time').textContent = 'No recording selected';
  document.querySelector('#playback-file').textContent = '';
  document.querySelector('#timeline-time').textContent = 'Scrub to choose a time';
  renderRecordings();
  renderTimeline();
}

function setPlayhead(timestamp, preview = false) {
  if (!dayStartMs || !dayEndMs) return;
  const clamped = Math.max(dayStartMs, Math.min(dayEndMs, timestamp));
  const ratio = (clamped - dayStartMs) / (dayEndMs - dayStartMs);
  timelinePlayhead.style.left = `${(ratio * 100).toFixed(5)}%`;
  timelinePlayhead.hidden = false;
  timelineTrack.setAttribute('aria-valuenow', String(Math.round((clamped - dayStartMs) / 1000)));
  document.querySelector('#timeline-time').textContent = `${preview ? 'Seek ' : ''}${new Date(clamped).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

function findFileAt(timestamp) {
  return displayedFiles.find((file) => {
    const start = fileStart(file);
    const end = fileEnd(file);
    return Number.isFinite(start) && Number.isFinite(end) && timestamp >= start && timestamp < end;
  });
}

function playFile(file, offsetSeconds = 0) {
  if (!file) return;
  const url = fileUrl(file);
  const sameFile = currentFile?.name === file.name && player.getAttribute('src') === url;
  currentFile = file;
  const seek = () => {
    player.onloadedmetadata = null;
    const safeOffset = Math.min(Math.max(0, offsetSeconds), Number.isFinite(player.duration) ? Math.max(0, player.duration - 0.05) : offsetSeconds);
    player.currentTime = safeOffset;
    player.play().catch(() => {});
    updatePlaybackPosition();
  };
  if (sameFile && player.readyState >= 1) {
    seek();
  } else {
    player.src = url;
    player.onloadedmetadata = seek;
  }
  document.querySelector('#playback-file').textContent = file.name;
  renderRecordings();
  renderTimeline();
}

function playTimestamp(timestamp) {
  setPlayhead(timestamp);
  const file = findFileAt(timestamp);
  if (!file) {
    player.pause();
    currentFile = null;
    document.querySelector('#playback-time').textContent = `Gap - ${new Date(timestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })}`;
    document.querySelector('#playback-file').textContent = 'No recording at this time';
    renderRecordings();
    renderTimeline();
    return;
  }
  const offset = Math.max(0, (timestamp - fileStart(file)) / 1000);
  playFile(file, offset);
}

function updatePlaybackPosition() {
  if (!currentFile || !Number.isFinite(player.currentTime)) return;
  const timestamp = fileStart(currentFile) + player.currentTime * 1000;
  document.querySelector('#playback-time').textContent = new Date(timestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
  if (timestamp >= dayStartMs && timestamp <= dayEndMs && !scrubActive) setPlayhead(timestamp);
}

function scrubTimestamp(event) {
  const rect = timelineTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return dayStartMs + ratio * (dayEndMs - dayStartMs);
}

function moveDay(offset) {
  if (!selectedDay) return;
  const [year, month, day] = selectedDay.split('-').map(Number);
  setSelectedDay(dateKey(new Date(year, month - 1, day + offset)));
}

filesListEl.onclick = (event) => {
  const playButton = event.target.closest('[data-play-file]');
  if (playButton) {
    const file = displayedFiles.find((item) => item.name === playButton.dataset.playFile);
    if (file) playFile(file, 0);
    return;
  }
  const marker = event.target.closest('[data-event-file]');
  if (marker) {
    const file = displayedFiles.find((item) => item.name === marker.dataset.eventFile);
    if (file) playFile(file, Number(marker.dataset.eventOffset) || 0);
  }
};

camerasEl.onchange = () => selectCamera(camerasEl.value);
document.querySelector('#open-add').onclick = () => openForm();
document.querySelector('#edit-camera').onclick = () => openForm(cameras.find((camera) => camera.id === currentCameraId));
document.querySelector('#close-dialog').onclick = document.querySelector('#cancel-dialog').onclick = () => formDialog.close();
document.querySelector('#api-protocol').onchange = (event) => { document.querySelector('#api-port').value = event.target.value === 'https' ? 443 : 80; };
document.querySelector('#timeline-date').onchange = (event) => setSelectedDay(event.target.value);
document.querySelector('#previous-day').onclick = () => moveDay(-1);
document.querySelector('#next-day').onclick = () => moveDay(1);
document.querySelector('#latest-day').onclick = () => {
  const latest = displayedFiles.at(-1);
  setSelectedDay(latest ? dateKey(fileStart(latest)) : dateKey(new Date()));
};

timelineTrack.addEventListener('pointerdown', (event) => {
  scrubActive = true;
  timelineTrack.setPointerCapture(event.pointerId);
  setPlayhead(scrubTimestamp(event), true);
});
timelineTrack.addEventListener('pointermove', (event) => {
  if (scrubActive) setPlayhead(scrubTimestamp(event), true);
});
timelineTrack.addEventListener('pointerup', (event) => {
  if (!scrubActive) return;
  scrubActive = false;
  playTimestamp(scrubTimestamp(event));
});
timelineTrack.addEventListener('pointercancel', () => { scrubActive = false; });
timelineTrack.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const current = Number(timelineTrack.getAttribute('aria-valuenow')) || 0;
  const next = Math.max(0, Math.min((dayEndMs - dayStartMs) / 1000, current + (event.key === 'ArrowRight' ? 60 : -60)));
  playTimestamp(dayStartMs + next * 1000);
});

player.addEventListener('timeupdate', updatePlaybackPosition);
player.addEventListener('ended', () => {
  if (!currentFile) return;
  const end = fileEnd(currentFile);
  const index = displayedFiles.findIndex((file) => file.name === currentFile.name);
  const next = index >= 0 ? displayedFiles.slice(index + 1).find((file) => Number.isFinite(fileStart(file))) : null;
  if (next && fileStart(next) <= end + 5000) playFile(next, 0);
  else {
    setPlayhead(end);
    document.querySelector('#timeline-time').textContent = 'Playback reached a recording gap';
  }
});

load();
setInterval(async () => {
  try {
    statuses = await request('/api/status');
    renderSelectedCameraStatus();
  } catch {}
}, 5000);
setInterval(() => { if (currentCameraId) loadFiles().catch(() => {}); }, 30000);
