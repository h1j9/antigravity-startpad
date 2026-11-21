const test = require('node:test');
const assert = require('node:assert/strict');
const { finalizeQuit } = require('../src/core/quit');

test('成功清理后先销毁托盘，再以成功代码明确退出', () => {
  const events = [];
  const app = { exit: code => events.push(['exit', code]) };
  const tray = {
    isDestroyed: () => false,
    destroy: () => events.push(['destroy']),
  };
  finalizeQuit(app, tray);
  assert.deepEqual(events, [['destroy'], ['exit', 0]]);
});

test('托盘销毁失败也不会阻断进程退出', () => {
  let exitCode = null;
  const app = { exit: code => { exitCode = code; } };
  const tray = { isDestroyed: () => false, destroy: () => { throw new Error('mock'); } };
  assert.doesNotThrow(() => finalizeQuit(app, tray));
  assert.equal(exitCode, 0);
});
