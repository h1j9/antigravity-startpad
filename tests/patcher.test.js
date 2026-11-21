const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Patcher, resolveGate, applyGate, getStatus, sha256 } = require('../src/core/patcher');
const { LauncherSession } = require('../src/core/session');

const ORIGINAL_X64 = Buffer.from([0x80,0x78,0x08,0x00,0x74,0x11,0x48,0x8b,0x22,0x24,0x33,0x48,0x89,0x44,0x60]);
const PREFIX = Buffer.from([0x00,0x0a,0x0d,0xff,0x41,0x42]);
const SUFFIX = Buffer.from([0x90,0x00,0x0a,0xcc,0x55]);
const ORIGINAL = Buffer.concat([PREFIX, ORIGINAL_X64, SUFFIX]);

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startpad-test-'));
  return { root, target: path.join(root, 'language_server.exe'), data: path.join(root, 'userdata') };
}
function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }); }

test('x64 特征能补丁并识别，且不改变文件长度', () => {
  const resolved = resolveGate(ORIGINAL);
  assert.equal(resolved.status, 'unpatched');
  assert.equal(resolved.offset, PREFIX.length);
  const patched = applyGate(ORIGINAL).data;
  assert.equal(patched.length, ORIGINAL.length);
  assert.equal(resolveGate(patched).status, 'patched');
  assert.deepEqual(patched.subarray(0, PREFIX.length), PREFIX);
  assert.deepEqual(patched.subarray(patched.length - SUFFIX.length), SUFFIX);
});

test('arm64 特征通配任意字节，包括换行', () => {
  const original = Buffer.from([0x03,0x20,0x40,0x39,0x03,0x0a,0x0d,0x36,0xaa,0x0a,0xbb,0x0d,0x03,0x10,0x06,0xa9]);
  const patched = applyGate(original).data;
  assert.equal(resolveGate(original).status, 'unpatched');
  assert.equal(resolveGate(patched).status, 'patched');
  assert.deepEqual([...patched.subarray(0,8)], [0x23,0x00,0x80,0x52,0x03,0x20,0x00,0x39]);
});

test('重复特征会拒绝猜测', () => {
  assert.throws(() => resolveGate(Buffer.concat([ORIGINAL_X64, ORIGINAL_X64])), /不是唯一/);
});

test('完整流程：备份、补丁、重复启动、恢复、再次补丁', () => {
  const { root, target, data } = workspace();
  try {
    fs.writeFileSync(target, ORIGINAL);
    const patcher = new Patcher(data);
    const first = patcher.apply(target);
    assert.equal(first.already, false);
    assert.equal(getStatus(target), 'patched');
    assert.equal(patcher.inspect(target).restorable, true);
    const patchedHash = sha256(fs.readFileSync(target));
    const second = patcher.apply(target);
    assert.equal(second.already, true);
    assert.equal(sha256(fs.readFileSync(target)), patchedHash);
    patcher.restore(target);
    assert.deepEqual(fs.readFileSync(target), ORIGINAL);
    assert.equal(fs.existsSync(patcher.sessionFile), false);
    patcher.apply(target);
    patcher.restore(target);
    assert.deepEqual(fs.readFileSync(target), ORIGINAL);
  } finally { cleanup(root); }
});

test('恢复完成后可以重复执行退出清理，不会重复恢复或卡住', async () => {
  const { root, target, data } = workspace();
  try {
    const mockExe = path.join(root, 'Antigravity.exe');
    const languageServer = path.join(root, 'resources', 'bin', 'language_server.exe');
    fs.mkdirSync(path.dirname(languageServer), { recursive: true });
    fs.writeFileSync(mockExe, '');
    fs.writeFileSync(languageServer, ORIGINAL);
    const patcher = new Patcher(data);
    const config = { data: { targetPath: mockExe, autoRestore: true } };
    const session = new LauncherSession({ config, patcher });
    session.runningFor = () => [];
    patcher.apply(languageServer);
    const first = await session.shutdown(false);
    assert.equal(first.ok, true);
    assert.deepEqual(fs.readFileSync(languageServer), ORIGINAL);
    const second = await session.shutdown(false);
    assert.equal(second.ok, true);
    assert.deepEqual(fs.readFileSync(languageServer), ORIGINAL);
  } finally { cleanup(root); }
});

test('可以接管第一个项目留下的 .agybak', () => {
  const { root, target, data } = workspace();
  try {
    fs.writeFileSync(`${target}.agybak`, ORIGINAL);
    fs.writeFileSync(target, applyGate(ORIGINAL).data);
    const patcher = new Patcher(data);
    const result = patcher.apply(target);
    assert.equal(result.already, true);
    assert.equal(patcher.inspect(target).restorable, true);
    patcher.restore(target);
    assert.deepEqual(fs.readFileSync(target), ORIGINAL);
  } finally { cleanup(root); }
});

test('崩溃在补丁写入后、记录完成前，仍能恢复', () => {
  const { root, target, data } = workspace();
  try {
    fs.writeFileSync(target, ORIGINAL);
    const patcher = new Patcher(data);
    patcher.apply(target);
    const session = JSON.parse(fs.readFileSync(patcher.sessionFile, 'utf8'));
    session.phase = 'prepared';
    session.patchedHash = null;
    fs.writeFileSync(patcher.sessionFile, JSON.stringify(session));
    const reopened = new Patcher(data);
    reopened.restore(target);
    assert.deepEqual(fs.readFileSync(target), ORIGINAL);
  } finally { cleanup(root); }
});

test('补丁后文件被更新或第三方改变时拒绝覆盖', () => {
  const { root, target, data } = workspace();
  try {
    fs.writeFileSync(target, ORIGINAL);
    const patcher = new Patcher(data);
    patcher.apply(target);
    const changed = Buffer.concat([fs.readFileSync(target), Buffer.from([0x42])]);
    fs.writeFileSync(target, changed);
    assert.throws(() => patcher.restore(target), /其他程序改变/);
    assert.deepEqual(fs.readFileSync(target), changed);
    assert.equal(fs.existsSync(patcher.sessionFile), true);
  } finally { cleanup(root); }
});

test('原版备份损坏时拒绝恢复', () => {
  const { root, target, data } = workspace();
  try {
    fs.writeFileSync(target, ORIGINAL);
    const patcher = new Patcher(data);
    patcher.apply(target);
    const session = patcher.readSession();
    const damaged = Buffer.from(ORIGINAL);
    damaged[0] ^= 0xff;
    fs.writeFileSync(session.backupFile, damaged);
    assert.throws(() => patcher.restore(target), /哈希不匹配/);
    assert.equal(getStatus(target), 'patched');
  } finally { cleanup(root); }
});

test('未知版本不会被修改', () => {
  const { root, target, data } = workspace();
  try {
    const unknown = Buffer.from([1,2,3,4,5,6,7,8]);
    fs.writeFileSync(target, unknown);
    const patcher = new Patcher(data);
    assert.throws(() => patcher.apply(target), /没有匹配/);
    assert.deepEqual(fs.readFileSync(target), unknown);
  } finally { cleanup(root); }
});
