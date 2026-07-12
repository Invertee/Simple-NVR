const fs = require('fs');
const path = require('path');

class Logger {
  constructor(file, maxLines = 2000) {
    this.file = file;
    this.maxLines = maxLines;
    this.entries = [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.entries = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-maxLines);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(error);
    }
  }

  write(level, message, cameraId = null) {
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, cameraId, message });
    this.entries.push(entry);
    if (this.entries.length > this.maxLines) this.entries.splice(0, this.entries.length - this.maxLines);
    fs.appendFile(this.file, `${entry}\n`, () => {});
    console[level === 'error' ? 'error' : 'log'](`[${level}]${cameraId ? ` [${cameraId}]` : ''} ${message}`);
  }

  info(message, cameraId) { this.write('info', message, cameraId); }
  warn(message, cameraId) { this.write('warn', message, cameraId); }
  error(message, cameraId) { this.write('error', message, cameraId); }

  list(limit = 300) {
    return this.entries.slice(-Math.min(Number(limit) || 300, 1000)).reverse().map((line) => {
      try { return JSON.parse(line); } catch { return { timestamp: '', level: 'info', cameraId: null, message: line }; }
    });
  }
}

module.exports = Logger;
