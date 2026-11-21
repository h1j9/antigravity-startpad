const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Config, DEFAULTS } = require('../src/core/config');

test('旧版本只迁移一次为不自动启动，之后尊重用户选择', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startpad-config-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ autoLaunch: true, proxyUrl: 'http://127.0.0.1:18080' }));
    const migrated = new Config(root);
    assert.equal(DEFAULTS.autoLaunch, false);
    assert.equal(migrated.data.autoLaunch, false);
    assert.equal(migrated.data.settingsVersion, 2);
    assert.equal(migrated.data.proxyUrl, 'http://127.0.0.1:18080');
    migrated.set({ autoLaunch: true });
    const reopened = new Config(root);
    assert.equal(reopened.data.autoLaunch, true);
    assert.equal(reopened.data.settingsVersion, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
