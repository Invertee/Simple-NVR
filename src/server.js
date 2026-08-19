const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Store = require('./store');
const Logger = require('./logger');
const RecorderManager = require('./recorder-manager');
const EventManager = require('./event-manager');
const { version: APP_VERSION } = require('../package.json');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.CCTV_DATA_DIR ? path.resolve(process.env.CCTV_DATA_DIR) : path.join(ROOT, 'data');
const defaults = {
  recordingRoot: process.env.CCTV_RECORDING_ROOT || path.join(ROOT, 'recordings'),
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  port: Number(process.env.PORT) || 3000,
  chunkMinutes: 10,
  cameras: []
};
const store = new Store(path.join(DATA_DIR, 'config.json'), defaults);
let config = store.load();
const logger = new Logger(path.join(DATA_DIR, 'app.log'));
const manager = new RecorderManager(() => config, logger);
const eventManager = new EventManager(() => config, logger, DATA_DIR);
const app = express();

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(ROOT, 'public')));

function publicCamera(camera) {
  return { ...camera, url: camera.url.replace(/(rtsp:\/\/[^:\s/]+:)[^@\s/]+@/i, '$1***@') };
}

function validCamera(body) {
  const name = String(body.name || '').trim();
  const url = String(body.url || '').trim();
  const maxSizeGb = Number(body.maxSizeGb);
  if (!name || name.length > 80) return 'Camera name is required (maximum 80 characters).';
  if (!/^rtsps?:\/\//i.test(url)) return 'A valid RTSP URL is required.';
  if (!Number.isFinite(maxSizeGb) || maxSizeGb <= 0) return 'Size limit must be greater than zero.';
  if (!['mp4', 'mkv'].includes(body.container || 'mp4')) return 'Container must be mp4 or mkv.';
  if (body.eventsEnabled && !['http', 'https'].includes(body.apiProtocol || 'http')) return 'Camera API protocol must be HTTP or HTTPS.';
  return null;
}

app.get('/api/config', (req, res) => {
  res.json({ appVersion: APP_VERSION, recordingRoot: config.recordingRoot, chunkMinutes: config.chunkMinutes, cameras: config.cameras.map(publicCamera) });
});

app.get('/api/status', (req, res) => res.json(manager.status()));

app.post('/api/cameras', (req, res) => {
  const error = validCamera(req.body);
  if (error) return res.status(400).json({ error });
  const camera = {
    id: crypto.randomUUID(),
    name: String(req.body.name).trim(),
    url: String(req.body.url).trim(),
    maxSizeGb: Number(req.body.maxSizeGb),
    container: req.body.container || 'mp4',
    eventsEnabled: Boolean(req.body.eventsEnabled),
    apiProtocol: req.body.apiProtocol || 'http',
    apiPort: Number(req.body.apiPort) || (req.body.apiProtocol === 'https' ? 443 : 80),
    apiChannel: Number(req.body.apiChannel) || 0,
    enabled: true
  };
  config.cameras.push(camera);
  store.save(config);
  logger.info(`Camera added: ${camera.name}`, camera.id);
  manager.startCamera(camera.id);
  eventManager.startCamera(camera.id);
  res.status(201).json(publicCamera(camera));
});

app.put('/api/cameras/:id', (req, res) => {
  const index = config.cameras.findIndex((item) => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Camera not found.' });
  const old = config.cameras[index];
  const candidate = {
    ...old,
    name: req.body.name ?? old.name,
    url: !req.body.url || req.body.url.includes(':***@') ? old.url : req.body.url,
    maxSizeGb: req.body.maxSizeGb ?? old.maxSizeGb,
    container: req.body.container ?? old.container,
    enabled: req.body.enabled ?? old.enabled
    ,eventsEnabled: req.body.eventsEnabled ?? old.eventsEnabled
    ,apiProtocol: req.body.apiProtocol ?? old.apiProtocol ?? 'http'
    ,apiPort: Number(req.body.apiPort ?? old.apiPort) || 80
    ,apiChannel: Number(req.body.apiChannel ?? old.apiChannel) || 0
  };
  const error = validCamera(candidate);
  if (error) return res.status(400).json({ error });
  config.cameras[index] = candidate;
  store.save(config);
  logger.info(`Camera updated: ${candidate.name}`, candidate.id);
  manager.restartCamera(candidate.id);
  eventManager.restartCamera(candidate.id);
  res.json(publicCamera(candidate));
});

app.delete('/api/cameras/:id', (req, res) => {
  const camera = config.cameras.find((item) => item.id === req.params.id);
  if (!camera) return res.status(404).json({ error: 'Camera not found.' });
  manager.stopCamera(camera.id);
  eventManager.stopCamera(camera.id);
  config.cameras = config.cameras.filter((item) => item.id !== camera.id);
  store.save(config);
  logger.info(`Camera removed (recordings retained): ${camera.name}`, camera.id);
  res.status(204).end();
});

app.get('/api/cameras/:id/files', async (req, res, next) => {
  try {
    if (!config.cameras.some((camera) => camera.id === req.params.id)) return res.status(404).json({ error: 'Camera not found.' });
    const files = await manager.listFiles(req.params.id);
    const chunkMs = (config.chunkMinutes || 10) * 60_000;
    const decorated = await Promise.all(files.map(async ({ mtimeMs, ...file }) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(file.name);
      const start = match ? new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]).getTime() : mtimeMs - chunkMs;
      return { ...file, events: await eventManager.list(req.params.id, start, start + chunkMs) };
    }));
    res.json(decorated);
  } catch (error) { next(error); }
});

app.get('/api/cameras/:id/files/:name', (req, res, next) => {
  const file = manager.filePath(req.params.id, req.params.name);
  if (!file) return res.status(404).end();
  fs.stat(file, (error, stat) => {
    if (error) return error.code === 'ENOENT' ? res.status(404).end() : next(error);
    const range = req.headers.range;
    const type = path.extname(file).toLowerCase() === '.mkv' ? 'video/x-matroska' : 'video/mp4';
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', type);
    if (!range) {
      res.setHeader('Content-Length', stat.size);
      return fs.createReadStream(file).pipe(res);
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return res.status(416).end();
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) return res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
});

app.get('/api/logs', (req, res) => {
  const names = new Map(config.cameras.map((camera) => [camera.id, camera.name]));
  res.json(logger.list(req.query.limit).map((entry) => ({
    ...entry,
    cameraName: entry.cameraId ? names.get(entry.cameraId) || null : null
  })));
});

app.use((error, req, res, next) => {
  logger.error(`${req.method} ${req.path}: ${error.message}`);
  res.status(500).json({ error: 'Internal server error.' });
});

fs.mkdirSync(config.recordingRoot, { recursive: true });
const server = app.listen(config.port, () => {
  logger.info(`CCTV recorder v${APP_VERSION} listening on http://localhost:${config.port}; recordings: ${config.recordingRoot}`);
  manager.start();
  eventManager.start();
});

async function shutdown(signal) {
  logger.info(`${signal} received; stopping recorders`);
  await manager.stop();
  eventManager.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
