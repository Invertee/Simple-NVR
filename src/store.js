const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...this.defaults, ...parsed, cameras: Array.isArray(parsed.cameras) ? parsed.cameras : [] };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.save(this.defaults);
      return structuredClone(this.defaults);
    }
  }

  save(value) {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, this.file);
  }
}

module.exports = Store;
