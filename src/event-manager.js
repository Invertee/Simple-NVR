const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const TYPE_NAMES = {
  md: 'Motion', people: 'Person', person: 'Person', vehicle: 'Vehicle',
  dog_cat: 'Animal', animal: 'Animal', pet: 'Animal', visitor: 'Visitor',
  package: 'Package', face: 'Face'
};

function requestJson(url, method, body, timeoutMs = 5000, redirectsLeft = 3, originalHost = url.hostname) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method,
      rejectUnauthorized: false,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, (response) => {
      let data = '';
      if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many camera API redirects'));
        const redirected = new URL(response.headers.location, url);
        // Do not forward a login body or token to any host other than this camera.
        if (redirected.hostname !== originalHost) return reject(new Error('Camera API redirected to a different host'));
        // Some Reolink firmware redirects HTTP to the HTTPS web root and drops the
        // CGI path. Preserve the API target for these protocol-only redirects.
        if ((redirected.pathname === '/' || !redirected.pathname) && url.pathname !== '/') {
          redirected.pathname = url.pathname;
          redirected.search = url.search;
        }
        return requestJson(redirected, method, body, timeoutMs, redirectsLeft - 1, originalHost).then(resolve, reject);
      }
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`HTTP ${response.statusCode} from ${url.protocol}//${url.host}${url.pathname}`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Camera returned invalid JSON')); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Camera API timed out')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

class EventManager {
  constructor(getConfig, logger, dataDirectory) {
    this.getConfig = getConfig;
    this.logger = logger;
    this.directory = path.join(dataDirectory, 'events');
    this.workers = new Map();
    fs.mkdirSync(this.directory, { recursive: true });
  }

  start() {
    for (const camera of this.getConfig().cameras) this.startCamera(camera.id);
  }

  stop() {
    for (const id of [...this.workers.keys()]) this.stopCamera(id);
  }

  restartCamera(id) {
    this.stopCamera(id);
    this.startCamera(id);
  }

  startCamera(id) {
    const camera = this.getConfig().cameras.find((item) => item.id === id);
    if (!camera || !camera.eventsEnabled || camera.enabled === false || this.workers.has(id)) return;
    let streamUrl;
    try { streamUrl = new URL(camera.url); } catch { return; }
    const worker = { timer: null, busy: false, token: null, tokenExpires: 0, states: {}, failures: 0 };
    this.workers.set(id, worker);
    this.logger.info('Reolink event monitoring started', id);
    const run = async () => {
      if (worker.busy || this.workers.get(id) !== worker) return;
      worker.busy = true;
      try {
        if (!worker.token || Date.now() > worker.tokenExpires - 60_000) await this.login(camera, streamUrl, worker);
        await this.poll(camera, streamUrl, worker);
        worker.failures = 0;
      } catch (error) {
        worker.token = null;
        worker.failures += 1;
        if (worker.failures === 1 || worker.failures % 30 === 0) this.logger.warn(`Reolink events unavailable: ${error.message}`, id);
      } finally { worker.busy = false; }
    };
    run();
    worker.timer = setInterval(run, 2000);
  }

  stopCamera(id) {
    const worker = this.workers.get(id);
    if (!worker) return;
    clearInterval(worker.timer);
    this.workers.delete(id);
  }

  endpoint(camera, streamUrl, command, token = '') {
    const protocol = camera.apiProtocol === 'https' ? 'https:' : 'http:';
    const port = Number(camera.apiPort) || (protocol === 'https:' ? 443 : 80);
    const url = new URL(`${protocol}//${streamUrl.hostname}:${port}/cgi-bin/api.cgi`);
    url.searchParams.set('cmd', command);
    if (token) url.searchParams.set('token', token);
    return url;
  }

  async login(camera, streamUrl, worker) {
    const username = decodeURIComponent(streamUrl.username);
    const password = decodeURIComponent(streamUrl.password);
    if (!username) throw new Error('RTSP URL has no username for camera API login');
    const result = await requestJson(this.endpoint(camera, streamUrl, 'Login'), 'POST', [{
      cmd: 'Login', action: 0, param: { User: { userName: username, password } }
    }]);
    const entry = result?.[0];
    if (entry?.code !== 0 || !entry?.value?.Token?.name) throw new Error(entry?.error?.detail || 'Camera API login failed');
    worker.token = entry.value.Token.name;
    worker.tokenExpires = Date.now() + (Number(entry.value.Token.leaseTime) || 3600) * 1000;
  }

  async poll(camera, streamUrl, worker) {
    const channel = Number(camera.apiChannel) || 0;
    const commands = [
      { cmd: 'GetMdState', action: 0, param: { channel } },
      { cmd: 'GetAiState', action: 0, param: { channel } }
    ];
    const result = await requestJson(this.endpoint(camera, streamUrl, 'GetMdState', worker.token), 'POST', commands);
    if (!Array.isArray(result)) throw new Error('Unexpected event response');
    const active = new Set();
    for (const entry of result) {
      if (entry.code !== 0) continue;
      if (entry.cmd === 'GetMdState' && Number(entry.value?.state) === 1) active.add('Motion');
      if (entry.cmd === 'GetAiState') {
        for (const [key, value] of Object.entries(entry.value || {})) {
          if (value && typeof value === 'object' && Number(value.alarm_state) === 1 && TYPE_NAMES[key]) active.add(TYPE_NAMES[key]);
        }
      }
    }
    // Store only rising edges. Consecutive polls of the same alarm create one marker.
    for (const type of active) {
      if (!worker.states[type]) this.record(camera.id, type);
    }
    const allTypes = new Set([...Object.values(TYPE_NAMES), ...Object.keys(worker.states)]);
    for (const type of allTypes) worker.states[type] = active.has(type);
  }

  record(cameraId, type) {
    const event = { timestamp: new Date().toISOString(), type };
    fs.appendFile(this.file(cameraId), `${JSON.stringify(event)}\n`, (error) => {
      if (error) this.logger.error(`Could not save ${type} event: ${error.message}`, cameraId);
    });
    this.logger.info(`Detection: ${type}`, cameraId);
  }

  file(cameraId) { return path.join(this.directory, `${cameraId.replace(/[^a-zA-Z0-9_-]/g, '')}.jsonl`); }

  async list(cameraId, startMs, endMs) {
    let text;
    try { text = await fs.promises.readFile(this.file(cameraId), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const event = JSON.parse(line); const time = Date.parse(event.timestamp);
        return time >= startMs && time < endMs ? [{ ...event, offsetSeconds: Math.max(0, Math.round((time - startMs) / 1000)) }] : [];
      } catch { return []; }
    });
  }
}

module.exports = EventManager;
