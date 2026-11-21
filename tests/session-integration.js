const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { Patcher, getStatus } = require('../src/core/patcher');
const { LauncherSession, sleep } = require('../src/core/session');
const proxy = require('../src/core/proxy');
const processes = require('../src/core/processes');

(async () => {
  const mockExe = path.resolve(process.argv[2]);
  const root = path.dirname(mockExe);
  const languageServer = path.join(root, 'resources', 'bin', 'language_server.exe');
  const original = Buffer.from([0,10,13,255,0x80,0x78,0x08,0x00,0x74,0x11,0x48,0x8b,0x22,0x24,0x33,0x48,0x89,0x44,0x60,0x90,0x00]);
  fs.mkdirSync(path.dirname(languageServer), { recursive: true });
  fs.writeFileSync(languageServer, original);

  let mockPid = null;
  processes.listRunning = targetPath => {
    if (!targetPath || path.resolve(targetPath).toLowerCase() !== mockExe.toLowerCase() || !mockPid) return [];
    try { process.kill(mockPid, 0); return [{ name: 'Antigravity.exe', pid: mockPid }]; }
    catch { return []; }
  };
  proxy.probe = async () => ({
    ok: true,
    result: { kind: 'mixed', host: '127.0.0.1', port: 18080, scheme: 'http', loginOk: true, modelOk: true, modelDetail: 'mock', rtt: 1 },
  });

  const config = { data: { targetPath: mockExe, proxyUrl: 'http://127.0.0.1:18080', autoRestore: true } };
  const patcher = new Patcher(path.join(root, 'userdata'));
  const session = new LauncherSession({ config, patcher });
  const result = await session.start();
  assert.equal(result.ok, true, result.error);
  mockPid = session.child.pid;
  assert.equal(getStatus(languageServer), 'patched');
  const deadline = Date.now() + 16000;
  while (session.phase !== 'idle' && session.phase !== 'error' && Date.now() < deadline) await sleep(250);
  assert.equal(session.phase, 'idle', session.lastError || '等待自动恢复超时');
  assert.equal(getStatus(languageServer), 'unpatched');
  assert.deepEqual(fs.readFileSync(languageServer), original);
  console.log(JSON.stringify({ launched: true, mockPid, observedPatched: true, autoRestored: true, finalPhase: session.phase }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
