const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv']);
const WATCHDOG_INTERVAL_MS = 30_000;
const WATCHDOG_STALL_MS = 180_000;

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '');
}

function redact(text) {
  return String(text).replace(/(rtsp:\/\/[^:\s/]+:)[^@\s/]+@/gi, '$1***@');
}

class RecorderManager {
  constructor(getConfig, logger) {
    this.getConfig = getConfig;
    this.logger = logger;
    this.workers = new Map();
    this.stopping = false;
    this.maintenanceTimer = null;
    this.watchdogTimer = null;
  }

  start() {
    this.stopping = false;
    for (const camera of this.getConfig().cameras) this.startCamera(camera.id);
    this.maintenanceTimer = setInterval(() => this.maintain().catch((e) => this.logger.error(e.message)), 60_000);
    this.watchdogTimer = setInterval(() => this.watchdog().catch((e) => this.logger.error(`Watchdog failed: ${e.message}`)), WATCHDOG_INTERVAL_MS);
    this.maintain().catch((e) => this.logger.error(e.message));
    this.watchdog().catch((e) => this.logger.error(`Watchdog failed: ${e.message}`));
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.maintenanceTimer);
    clearInterval(this.watchdogTimer);
    for (const worker of this.workers.values()) {
      clearTimeout(worker.restartTimer);
      if (worker.process && !worker.process.killed) worker.process.kill('SIGTERM');
    }
    this.workers.clear();
  }

  restartCamera(id) {
    this.stopCamera(id);
    if (this.getCamera(id)) this.startCamera(id);
  }

  stopCamera(id) {
    const worker = this.workers.get(id);
    if (!worker) return;
    worker.intentionalStop = true;
    clearTimeout(worker.restartTimer);
    if (worker.process && !worker.process.killed) worker.process.kill('SIGTERM');
    this.workers.delete(id);
    this.logger.info('Recorder stopped', id);
  }

  startCamera(id) {
    const camera = this.getCamera(id);
    if (!camera || camera.enabled === false || this.stopping) return;
    const existing = this.workers.get(id);
    if (existing?.process && !existing.process.killed) return;

    const config = this.getConfig();
    const directory = path.join(config.recordingRoot, safeId(id));
    fs.mkdirSync(directory, { recursive: true });
    const extension = camera.container === 'mkv' ? 'mkv' : 'mp4';
    const output = path.join(directory, `%Y-%m-%d_%H-%M-%S.${extension}`);
    const args = [
      '-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts', '-rtsp_transport', 'tcp',
      '-i', camera.url,
      '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
      '-f', 'segment', '-segment_time', String((config.chunkMinutes || 10) * 60),
      '-reset_timestamps', '1', '-strftime', '1'
    ];
    if (extension === 'mp4') args.push('-segment_format_options', 'movflags=+faststart');
    args.push(output);

    this.logger.info(`Starting FFmpeg recorder for ${camera.name}`, id);
    const child = spawn(config.ffmpegPath || 'ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const worker = {
      process: child,
      startedAt: Date.now(),
      intentionalStop: false,
      restartTimer: null,
      lastError: '',
      lastProgressAt: Date.now(),
      lastObservedFile: null,
      lastObservedSize: 0
    };
    this.workers.set(id, worker);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => {
      const message = redact(data)
        .split(/\r?\n/)
        .filter((line) => !line.includes('Timestamps are unset in a packet for stream'))
        .join('\n')
        .trim();
      if (message) {
        worker.lastError = message.slice(-500);
        this.logger.warn(message.slice(-1000), id);
      }
    });
    child.on('error', (error) => {
      worker.lastError = error.message;
      this.logger.error(`Could not run FFmpeg: ${error.message}`, id);
    });
    child.on('exit', (code, signal) => {
      const current = this.workers.get(id);
      if (current !== worker || worker.intentionalStop || this.stopping) return;
      worker.process = null;
      const ranFor = Math.round((Date.now() - worker.startedAt) / 1000);
      this.logger.error(`FFmpeg exited (code=${code}, signal=${signal}, runtime=${ranFor}s); restarting in 5 seconds`, id);
      worker.restartTimer = setTimeout(() => {
        if (this.workers.get(id) === worker) this.workers.delete(id);
        this.startCamera(id);
      }, 5000);
    });
  }

  getCamera(id) {
    return this.getConfig().cameras.find((camera) => camera.id === id);
  }

  status() {
    const now = Date.now();
    return this.getConfig().cameras.map((camera) => {
      const worker = this.workers.get(camera.id);
      return {
        id: camera.id,
        running: Boolean(worker?.process && !worker.process.killed),
        pid: worker?.process?.pid || null,
        uptimeSeconds: worker?.startedAt ? Math.floor((now - worker.startedAt) / 1000) : 0,
        lastProgressSeconds: worker?.lastProgressAt ? Math.floor((now - worker.lastProgressAt) / 1000) : null,
        lastError: worker?.lastError || ''
      };
    });
  }

  async listFiles(cameraId) {
    const camera = this.getCamera(cameraId);
    if (!camera) return [];
    const dir = path.join(this.getConfig().recordingRoot, safeId(cameraId));
    let names;
    try { names = await fs.promises.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const files = await Promise.all(names.filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())).map(async (name) => {
      const stat = await fs.promises.stat(path.join(dir, name));
      return { name, size: stat.size, modified: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs };
    }));
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  filePath(cameraId, fileName) {
    if (path.basename(fileName) !== fileName || !VIDEO_EXTENSIONS.has(path.extname(fileName).toLowerCase())) return null;
    if (!this.getCamera(cameraId)) return null;
    return path.join(this.getConfig().recordingRoot, safeId(cameraId), fileName);
  }

  async latestFileProgress(cameraId) {
    const dir = path.join(this.getConfig().recordingRoot, safeId(cameraId));
    let names;
    try { names = await fs.promises.readdir(dir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const name = names.filter((item) => VIDEO_EXTENSIONS.has(path.extname(item).toLowerCase())).sort().at(-1);
    if (!name) return null;
    try {
      const stat = await fs.promises.stat(path.join(dir, name));
      return { name, size: stat.size };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async watchdog() {
    for (const camera of this.getConfig().cameras) {
      if (camera.enabled === false) continue;
      const worker = this.workers.get(camera.id);
      if (!worker?.process || worker.process.killed) continue;

      try {
        const latest = await this.latestFileProgress(camera.id);
        if (worker.lastObservedFile === null) {
          worker.lastObservedFile = latest?.name || '';
          worker.lastObservedSize = latest?.size || 0;
          continue;
        }

        const progressed = latest && (latest.name !== worker.lastObservedFile || latest.size !== worker.lastObservedSize);
        if (progressed) {
          worker.lastObservedFile = latest.name;
          worker.lastObservedSize = latest.size;
          worker.lastProgressAt = Date.now();
          continue;
        }

        const stalledMs = Date.now() - worker.lastProgressAt;
        if (stalledMs >= WATCHDOG_STALL_MS) {
          const stalledSeconds = Math.floor(stalledMs / 1000);
          this.logger.error(`Watchdog detected no recording progress for ${stalledSeconds}s; restarting FFmpeg`, camera.id);
          this.restartCamera(camera.id);
        }
      } catch (error) {
        this.logger.warn(`Watchdog could not check recording progress: ${error.message}`, camera.id);
      }
    }
  }

  async maintain() {
    for (const camera of this.getConfig().cameras) {
      if (camera.enabled !== false && !this.workers.has(camera.id)) this.startCamera(camera.id);
      await this.enforceQuota(camera);
    }
  }

  async enforceQuota(camera) {
    const maxBytes = Number(camera.maxSizeGb) * 1024 ** 3;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
    const files = (await this.listFiles(camera.id)).reverse();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    // Keep the newest file because FFmpeg may still be writing it.
    const newest = files.at(-1)?.name;
    for (const file of files) {
      if (total <= maxBytes || file.name === newest) break;
      try {
        await fs.promises.unlink(this.filePath(camera.id, file.name));
        total -= file.size;
        this.logger.info(`Quota cleanup deleted ${file.name} (${(file.size / 1024 ** 2).toFixed(1)} MB)`, camera.id);
      } catch (error) {
        this.logger.error(`Quota cleanup failed for ${file.name}: ${error.message}`, camera.id);
      }
    }
  }
}

module.exports = RecorderManager;
