const test = require('node:test');
const assert = require('node:assert/strict');
const { isUsable, send, show } = require('../src/core/window-safe');

function fakeWindow({ windowDestroyed = false, contentsDestroyed = false, throws = false } = {}) {
  const calls = [];
  const win = {
    isDestroyed: () => windowDestroyed,
    webContents: {
      isDestroyed: () => contentsDestroyed,
      send: (...args) => {
        if (throws) throw new Error('Object has been destroyed');
        calls.push(['send', ...args]);
      },
    },
    show: () => {
      if (throws) throw new Error('Object has been destroyed');
      calls.push(['show']);
    },
    focus: () => calls.push(['focus']),
  };
  return { win, calls };
}

test('有效窗口可以接收消息并安全显示', () => {
  const { win, calls } = fakeWindow();
  assert.equal(isUsable(win), true);
  assert.equal(send(win, 'state', { ok: true }), true);
  assert.equal(show(win), true);
  assert.deepEqual(calls, [['send', 'state', { ok: true }], ['show'], ['focus']]);
});

test('空窗口或已销毁窗口不会继续操作', () => {
  const { win, calls } = fakeWindow({ windowDestroyed: true });
  assert.equal(send(null, 'state', {}), false);
  assert.equal(send(win, 'state', {}), false);
  assert.equal(show(win), false);
  assert.deepEqual(calls, []);
});

test('webContents 已销毁时不会发送或聚焦', () => {
  const { win, calls } = fakeWindow({ contentsDestroyed: true });
  assert.equal(isUsable(win), false);
  assert.equal(send(win, 'state', {}), false);
  assert.equal(show(win), false);
  assert.deepEqual(calls, []);
});

test('检查后发生的销毁竞态会被捕获，不再形成未处理异常', () => {
  const { win } = fakeWindow({ throws: true });
  assert.doesNotThrow(() => send(win, 'state', {}));
  assert.doesNotThrow(() => show(win));
  assert.equal(send(win, 'state', {}), false);
  assert.equal(show(win), false);
});
