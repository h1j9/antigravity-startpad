const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { Config } = require('./core/config');
const { Patcher } = require('./core/patcher');
const { LauncherSession } = require('./core/session');
const detect = require('./core/detect');
const proxy = require('./core/proxy');
const processes = require('./core/processes');
const windowSafe = require('./core/window-safe');

let win = null;
let tray = null;
let config = null;
let patcher = null;
let session = null;
let allowQuit = false;
let quitInProgress = false;
let autoStarted = false;
let proxyDiscovery = null;

const emit = (channel, payload) => {
  windowSafe.send(win, channel, payload);
};
const log = (level, message) => emit('log', { level, message, ts: Date.now() });
const showMainWindow = () => windowSafe.show(win);

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 650,
    show: false,
    backgroundColor: '#f3f5f7',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    title: '反重力启动台',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => showMainWindow());
  win.on('closed', () => { win = null; });
  win.on('close', event => {
    if (allowQuit) return;
    event.preventDefault();
    const target = session.resolveTarget();
    const running = target.found ? session.runningFor(target) : [];
    if (running.length) {
      if (windowSafe.isUsable(win)) win.hide();
      log('info', '启动台已缩到托盘，会继续监测反重力并在退出后恢复补丁');
    } else {
      app.quit();
    }
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, '..', 'build', 'icon.png'));
  tray.setToolTip('反重力启动台');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示启动台', click: showMainWindow },
    { label: '立即恢复原版', click: () => session.restoreNow() },
    { type: 'separator' },
    { label: '退出', click: () => requestQuit(true) },
  ]));
  tray.on('click', showMainWindow);
}

async function requestQuit(fromTray) {
  if (quitInProgress || allowQuit) return;
  quitInProgress = true;
  try {
    const target = session.resolveTarget();
    const running = target.found ? session.runningFor(target) : [];
    let forceClose = false;
    if (running.length) {
      if (!fromTray && windowSafe.isUsable(win)) {
        win.hide();
        return;
      }
      const options = {
        type: 'warning',
        title: '反重力仍在运行',
        message: '要结束反重力、恢复原版并退出启动台吗？',
        detail: '未保存的客户端内容可能丢失。也可以取消，先在反重力中正常退出。',
        buttons: ['结束反重力并退出', '取消'],
        defaultId: 1,
        cancelId: 1,
      };
      const answer = windowSafe.isUsable(win)
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      if (answer.response !== 0) return;
      forceClose = true;
    }
    const result = await session.shutdown(forceClose);
    if (!result.ok) throw new Error(result.error || '无法安全退出');
    allowQuit = true;
    app.quit();
  } catch (error) {
    log('error', `退出前恢复失败：${error.message}`);
    if (windowSafe.isUsable(win)) {
      showMainWindow();
      dialog.showErrorBox('暂未退出', `${error.message}\n\n启动台保持运行，原版备份也已保留。`);
    }
  } finally {
    quitInProgress = false;
  }
}

async function discoverProxy(manualUrl = '', protectExisting = false) {
  const initialUrl = String(config.data.proxyUrl || '').trim();
  try {
    const { best } = await proxy.scan(manualUrl);
    const currentUrl = String(config.data.proxyUrl || '').trim();
    if ((protectExisting && currentUrl) || currentUrl !== initialUrl) {
      return { ok: true, proxyUrl: currentUrl, best: null, autoDetected: false };
    }
    if (!best) return { ok: false, error: '没有探测到通过真实握手的本地代理，请确认代理已启用，或手动填写地址和端口' };
    const proxyUrl = proxy.toProxyUrl(best);
    config.set({ proxyUrl });
    log('success', `已自动探测并填入本地代理：${proxy.redact(best)}（${best.origin}，${best.kind}）`);
    return { ok: true, proxyUrl, best, autoDetected: true };
  } catch (error) {
    return { ok: false, error: `自动探测代理失败：${error.message}` };
  }
}

async function ensureProxyConfigured() {
  const current = String(config.data.proxyUrl || '').trim();
  if (current) return { ok: true, proxyUrl: current, best: null, autoDetected: false };
  if (!proxyDiscovery) {
    proxyDiscovery = discoverProxy('', true).finally(() => { proxyDiscovery = null; });
  }
  return proxyDiscovery;
}

async function probe() {
  const target = session.resolveTarget();
  const inspection = target.found
    ? patcher.inspect(target.languageServer)
    : { status: 'missing', restorable: false };
  let proxyUrl = String(config.data.proxyUrl || '').trim();
  let checked = null;
  let autoDetected = false;
  let discoveryError = null;
  if (!proxyUrl) {
    const discovered = await ensureProxyConfigured();
    autoDetected = discovered.autoDetected;
    if (discovered.ok && discovered.best) {
      proxyUrl = discovered.proxyUrl;
      checked = { ok: true, result: discovered.best, error: null };
    } else {
      proxyUrl = String(config.data.proxyUrl || '').trim();
      discoveryError = discovered.error || null;
    }
  }
  if (proxyUrl && !checked) checked = await proxy.probe(proxyUrl);
  return {
    target,
    inspection,
    proxyUrl,
    running: target.found ? session.runningFor(target) : [],
    proxy: checked ? {
      ok: checked.ok,
      configured: true,
      autoDetected,
      error: checked.error,
      endpoint: checked.result ? proxy.redact(checked.result) : proxyUrl,
      kind: checked.result ? checked.result.kind : null,
      origin: checked.result ? checked.result.origin || null : null,
      loginOk: checked.result ? checked.result.loginOk : false,
      modelOk: checked.result ? checked.result.modelOk : false,
      modelDetail: checked.result ? checked.result.modelDetail : null,
      rtt: checked.result ? checked.result.rtt : null,
    } : {
      ok: false,
      configured: false,
      autoDetected: false,
      error: discoveryError,
      endpoint: '未配置',
      kind: null,
      origin: null,
      loginOk: false,
      modelOk: false,
      modelDetail: null,
      rtt: null,
    },
  };
}

ipcMain.handle('boot', () => ({
  version: app.getVersion(),
  config: config.data,
  session: session.snapshot(),
  backupDirectory: patcher.directory,
}));
ipcMain.handle('probe', probe);
ipcMain.handle('launch', async () => {
  const ready = await ensureProxyConfigured();
  if (!ready.ok) return { ok: false, error: ready.error };
  const result = await session.start();
  emit('probe-refresh', {});
  return result;
});
ipcMain.handle('restore', async () => {
  const result = await session.restoreNow();
  emit('probe-refresh', {});
  return result;
});
ipcMain.handle('choose-target', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择 Antigravity.exe',
    defaultPath: path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity'),
    properties: ['openFile'],
    filters: [{ name: 'Antigravity', extensions: ['exe'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  const target = detect.pack(result.filePaths[0], 'manual');
  if (!target.found) return { ok: false, error: target.error };
  config.set({ targetPath: target.path });
  log('success', `已保存客户端位置：${target.path}`);
  return { ok: true, target };
});
ipcMain.handle('reset-target', () => {
  config.set({ targetPath: null });
  return detect.detect();
});
ipcMain.handle('auto-detect-proxy', async (event, manualUrl) => {
  const result = await discoverProxy(typeof manualUrl === 'string' ? manualUrl : '');
  return {
    ok: result.ok,
    error: result.error || null,
    proxyUrl: result.proxyUrl || '',
    kind: result.best ? result.best.kind : null,
    origin: result.best ? result.best.origin : null,
    modelOk: result.best ? result.best.modelOk : false,
  };
});
ipcMain.handle('set-config', (event, incoming) => {
  const update = {};
  if (typeof incoming.proxyUrl === 'string') {
    const value = incoming.proxyUrl.trim();
    if (value) {
      const parsed = proxy.parseProxyUrl(value);
      if (!parsed) return { ok: false, error: '代理地址格式不正确，请使用 http://主机:端口 或 socks5://主机:端口' };
    }
    update.proxyUrl = value;
  }
  if (typeof incoming.autoRestore === 'boolean') update.autoRestore = incoming.autoRestore;
  if (typeof incoming.autoLaunch === 'boolean') update.autoLaunch = incoming.autoLaunch;
  config.set(update);
  log('success', '设置已保存');
  return { ok: true, config: config.data };
});
ipcMain.handle('quit-instances', (event, pids) => {
  const target = session.resolveTarget();
  if (!target.found) return { ok: false, error: '找不到客户端' };
  const actual = session.runningFor(target);
  const allowed = new Set(actual.map(item => item.pid));
  const selected = (pids || []).filter(pid => allowed.has(Number(pid)));
  processes.killInstances(selected);
  log('warning', '已按你的确认结束残留反重力实例');
  return { ok: true };
});
ipcMain.handle('open-external', (event, url) => {
  if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('open-backups', () => shell.openPath(patcher.directory));

app.on('before-quit', event => {
  if (allowQuit) return;
  if (!session) return;
  event.preventDefault();
  requestQuit(false);
});
app.on('window-all-closed', () => { /* tray keeps the monitor alive */ });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    config = new Config(app.getPath('userData'));
    patcher = new Patcher(app.getPath('userData'));
    session = new LauncherSession({ config, patcher });
    session.on('log', entry => emit('log', entry));
    session.on('changed', state => emit('session-changed', state));
    session.on('client-exit', () => emit('probe-refresh', {}));
    createWindow();
    createTray();
    setTimeout(async () => {
      if (autoStarted || allowQuit || quitInProgress || !config.data.autoLaunch || process.env.AG_STARTPAD_NO_AUTO === '1') return;
      autoStarted = true;
      const ready = await ensureProxyConfigured();
      if (!ready.ok) {
        log('warning', ready.error);
        emit('probe-refresh', {});
        return;
      }
      const result = await session.start();
      if (result.needsQuit) log('warning', '自动启动已暂停：请先处理正在运行的反重力残留实例');
      emit('probe-refresh', {});
    }, 1600);
  });
}
