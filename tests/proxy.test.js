const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const {
  parseProxyUrl, buildEnv, proxyArgument, redact, probe, scan, buildCandidates,
  toProxyUrl, COMMON_PROXY_PORTS,
} = require('../src/core/proxy');
const { DEFAULTS } = require('../src/core/config');
const { LauncherSession } = require('../src/core/session');

test('新用户默认不预设代理端口，空地址不会通过校验', () => {
  assert.equal(DEFAULTS.proxyUrl, '');
  assert.equal(DEFAULTS.autoLaunch, false);
  assert.equal(parseProxyUrl(''), null);
  assert.equal(parseProxyUrl('   '), null);
});

test('未配置代理时在定位客户端和打补丁前停止', async () => {
  const session = new LauncherSession({
    config: { data: { proxyUrl: '', targetPath: null } },
    patcher: { apply: () => { throw new Error('不应进入补丁流程'); } },
  });
  const result = await session.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /填写本地代理地址和端口/);
  assert.equal(session.phase, 'error');
});

test('代理地址支持 18080 简写并校验端口', () => {
  assert.equal(parseProxyUrl('18080').host, '127.0.0.1');
  assert.equal(parseProxyUrl('18080').port, 18080);
  assert.equal(parseProxyUrl('http://127.0.0.1:99999'), null);
});

test('mixed 代理同时注入大小写变量，回环地址始终直连', () => {
  const ep = { kind: 'mixed', host: '127.0.0.1', port: 18080 };
  const env = buildEnv(ep);
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:18080');
  assert.equal(env.https_proxy, 'http://127.0.0.1:18080');
  assert.equal(env.ALL_PROXY, 'socks5://127.0.0.1:18080');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.equal(proxyArgument(ep), '--proxy-server=http://127.0.0.1:18080');
});

test('SOCKS5-only 使用一致协议，日志地址不泄露凭证', () => {
  const ep = { kind: 'socks5', scheme: 'socks5', host: '127.0.0.1', port: 1080, user: 'secret', pass: 'password' };
  const env = buildEnv(ep);
  assert.equal(env.HTTPS_PROXY, 'socks5://secret:password@127.0.0.1:1080');
  assert.equal(proxyArgument(ep), '--proxy-server=socks5://127.0.0.1:1080');
  assert.equal(redact(ep), 'socks5://127.0.0.1:1080');
  assert.equal(redact(ep).includes('secret'), false);
});

test('自动候选按手动、系统、常见端口排列并去重，协议格式化正确', () => {
  const candidates = buildCandidates('http://127.0.0.1:18080', () => [
    { host: '127.0.0.1', port: 18081, scheme: 'http', origin: '系统代理' },
    { host: '127.0.0.1', port: 18080, scheme: 'http', origin: '系统代理' },
  ]);
  assert.deepEqual(candidates.slice(0, 2).map(ep => ep.port), [18080, 18081]);
  assert.equal(candidates.filter(ep => ep.port === 18080).length, 1);
  assert.equal(candidates.length, 2 + COMMON_PROXY_PORTS.filter(port => ![18080, 18081].includes(port)).length);
  assert.equal(toProxyUrl({ kind: 'mixed', host: '127.0.0.1', port: 18080 }), 'http://127.0.0.1:18080');
  assert.equal(toProxyUrl({ kind: 'socks5', host: '127.0.0.1', port: 18081 }), 'socks5://127.0.0.1:18081');
});

test('自动扫描保留可用手动地址，空白时优先双目标通过的候选', async () => {
  const systemReader = () => [
    { host: '127.0.0.1', port: 18082, scheme: 'http', origin: '系统代理' },
    { host: '127.0.0.1', port: 18081, scheme: 'http', origin: '系统代理' },
  ];
  const classifyProxy = async ep => ({
    ...ep,
    kind: 'http',
    loginOk: [18080, 18081, 18082].includes(ep.port),
    modelOk: ep.port === 18081,
    modelDetail: 'mock',
    rtt: 1,
  });
  const manual = await scan('http://127.0.0.1:18080', null, { systemReader, classifyProxy });
  assert.equal(manual.best.port, 18080);
  assert.equal(manual.best.origin, '手动填写');
  const automatic = await scan('', null, { systemReader, classifyProxy });
  assert.equal(automatic.best.port, 18081);
  assert.equal(automatic.best.origin, '系统代理');
});

test('本地 mixed 代理握手与双目标检查', async () => {
  const server = net.createServer(socket => {
    let socksPhase = 0;
    socket.on('data', chunk => {
      if (chunk[0] === 0x05) {
        if (socksPhase === 0) {
          socksPhase = 1;
          socket.write(Buffer.from([0x05, 0x00]));
        } else {
          socket.write(Buffer.from([0x05,0x00,0x00,0x01,0,0,0,0,0,0]));
        }
      } else {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const result = await probe(`http://127.0.0.1:${port}`);
    assert.equal(result.ok, true);
    assert.equal(result.result.kind, 'mixed');
    assert.equal(result.result.loginOk, true);
    assert.equal(result.result.modelOk, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
