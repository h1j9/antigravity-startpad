const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { parseProxyUrl, buildEnv, proxyArgument, redact, probe } = require('../src/core/proxy');

test('代理地址支持 7897 简写并校验端口', () => {
  assert.equal(parseProxyUrl('7897').host, '127.0.0.1');
  assert.equal(parseProxyUrl('7897').port, 7897);
  assert.equal(parseProxyUrl('http://127.0.0.1:99999'), null);
});

test('mixed 代理同时注入大小写变量，回环地址始终直连', () => {
  const ep = { kind: 'mixed', host: '127.0.0.1', port: 7897 };
  const env = buildEnv(ep);
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(env.https_proxy, 'http://127.0.0.1:7897');
  assert.equal(env.ALL_PROXY, 'socks5://127.0.0.1:7897');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.equal(proxyArgument(ep), '--proxy-server=http://127.0.0.1:7897');
});

test('SOCKS5-only 使用一致协议，日志地址不泄露凭证', () => {
  const ep = { kind: 'socks5', scheme: 'socks5', host: '127.0.0.1', port: 1080, user: 'secret', pass: 'password' };
  const env = buildEnv(ep);
  assert.equal(env.HTTPS_PROXY, 'socks5://secret:password@127.0.0.1:1080');
  assert.equal(proxyArgument(ep), '--proxy-server=socks5://127.0.0.1:1080');
  assert.equal(redact(ep), 'socks5://127.0.0.1:1080');
  assert.equal(redact(ep).includes('secret'), false);
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
