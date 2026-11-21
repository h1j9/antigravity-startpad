const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  targetPath: null,
  proxyUrl: 'http://127.0.0.1:7897',
  autoRestore: true,
  autoLaunch: true,
};

class Config {
  constructor(dir) {
    this.file = path.join(dir, 'config.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw };
    } catch {
      this.data = { ...DEFAULTS };
    }
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2));
    fs.renameSync(temp, this.file);
  }

  set(patch) {
    this.data = { ...this.data, ...patch };
    this.save();
    return this.data;
  }
}

module.exports = { Config, DEFAULTS };
