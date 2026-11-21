const net = require('net');

const LOGIN_TARGET = { host: 'accounts.google.com', port: 443 };
const MODEL_TARGET = { host: 'daily-cloudcode-pa.googleapis.com', port: 443 };

function parseProxyUrl(input) {
  if (!input) return null;
  let raw = String(input).trim();
  if (/^\d{2,5}$/.test(raw)) raw = `127.0.0.1:${raw}`;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname) return null;
    const port = Number(url.port) || (url.protocol === 'socks5:' ? 1080 : 80);
    if (port < 1 || port > 65535) return null;
    return {
      host: url.hostname,
      port,
      scheme: url.protocol.replace(':', ''),
      user: decodeURIComponent(url.username || '') || undefined,
      pass: decodeURIComponent(url.password || '') || undefined,
    };
  } catch { return null; }
}

function httpConnect(ep, target, timeout = 3500) {
  const started = Date.now();
  return new Promise(resolve => {
    const socket = net.connect({ host: ep.host, port: ep.port, timeout });
    let buffer = '';
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, rtt: Date.now() - started });
    };
    socket.on('error', error => done({ ok: false, reason: error.code || 'socket error' }));
    socket.on('timeout', () => done({ ok: false, reason: '连接超时' }));
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1');
      if (!buffer.includes('\r\n\r\n') && !buffer.includes('\n\n')) return;
      const status = buffer.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
      done(status
        ? { ok: status[1] === '200', reason: `HTTP CONNECT ${status[1]}` }
        : { ok: false, reason: '返回内容不是 HTTP 代理响应' });
    });
    const auth = ep.user ? `\r\nProxy-Authorization: Basic ${Buffer.from(`${ep.user}:${ep.pass || ''}`).toString('base64')}` : '';
    socket.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}${auth}\r\n\r\n`);
  });
}

function socks5Connect(ep, target, timeout = 3500) {
  const started = Date.now();
  return new Promise(resolve => {
    const socket = net.connect({ host: ep.host, port: ep.port, timeout });
    let phase = 0;
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, rtt: Date.now() - started });
    };
    socket.on('error', error => done({ ok: false, reason: error.code || 'socket error' }));
    socket.on('timeout', () => done({ ok: false, reason: '连接超时' }));
    const host = Buffer.from(target.host, 'utf8');
    const request = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host,
      Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
    ]);
    let received = Buffer.alloc(0);
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (phase === 0) {
        if (received.length < 2) return;
        if (received[0] !== 0x05 || received[1] !== 0x00) return done({ ok: false, reason: 'SOCKS5 握手被拒绝' });
        phase = 1;
        received = Buffer.alloc(0);
        socket.write(request);
        return;
      }
      if (received.length < 4) return;
      done(received[1] === 0x00 ? { ok: true, reason: 'SOCKS5 CONNECT 成功' } : { ok: false, reason: `SOCKS5 返回代码 ${received[1]}` });
    });
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
  });
}

async function classify(ep, timeout = 3000) {
  const [httpLogin, socksLogin] = await Promise.all([httpConnect(ep, LOGIN_TARGET, timeout), socks5Connect(ep, LOGIN_TARGET, timeout)]);
  const kind = httpLogin.ok && socksLogin.ok ? 'mixed' : httpLogin.ok ? 'http' : socksLogin.ok ? 'socks5' : 'dead';
  const model = kind === 'dead' ? { ok: false, reason: '代理不可达' }
    : kind === 'socks5' ? await socks5Connect(ep, MODEL_TARGET, timeout)
      : await httpConnect(ep, MODEL_TARGET, timeout);
  return {
    ...ep, kind, loginOk: kind !== 'dead', modelOk: model.ok,
    loginDetail: kind === 'dead' ? (httpLogin.reason || socksLogin.reason) : `${kind} 握手成功`,
    modelDetail: model.reason,
    rtt: (kind === 'socks5' ? socksLogin : httpLogin).rtt,
  };
}

async function probe(url) {
  const ep = parseProxyUrl(url);
  if (!ep) return { ok: false, error: '代理地址格式不正确', result: null };
  const result = await classify(ep);
  return { ok: result.loginOk, result, error: result.loginOk ? null : `无法通过 ${redact(ep)} 连接 Google 登录服务：${result.loginDetail}` };
}

function endpoint(ep, scheme, includeAuth = true) {
  const auth = includeAuth && ep.user ? `${encodeURIComponent(ep.user)}:${encodeURIComponent(ep.pass || '')}@` : '';
  return `${scheme}://${auth}${ep.host}:${ep.port}`;
}
function redact(ep) { return endpoint(ep, ep.scheme || 'http', false); }
function buildEnv(ep) {
  const httpScheme = ep.kind === 'socks5' ? 'socks5' : 'http';
  const http = endpoint(ep, httpScheme);
  const all = ep.kind === 'http' ? http : endpoint(ep, 'socks5');
  return {
    HTTP_PROXY: http, HTTPS_PROXY: http, http_proxy: http, https_proxy: http,
    ALL_PROXY: all, all_proxy: all,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
  };
}
function proxyArgument(ep) { return `--proxy-server=${ep.kind === 'socks5' ? 'socks5' : 'http'}://${ep.host}:${ep.port}`; }

module.exports = { probe, classify, parseProxyUrl, buildEnv, proxyArgument, redact, httpConnect, socks5Connect, LOGIN_TARGET, MODEL_TARGET };
