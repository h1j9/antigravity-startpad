const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  targetPath: null,
  proxyUrl: '',
  autoRestore: true,
  autoLaunch: false,
  settingsVersion: 2,
};

class Config {
  constructor(dir) {
    this.file = path.join(dir, 'config.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch {
      this.data = { ...DEFAULTS };
      return this;
    }
    this.data = { ...DEFAULTS, ...raw };
    if (!Number.isInteger(raw.settingsVersion) || raw.settingsVersion < 2) {
      this.data.autoLaunch = false;
      this.data.settingsVersion = 2;
      try { this.save(); } catch { /* 写入失败时保留下次迁移机会，不清空其他设置 */ }
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
