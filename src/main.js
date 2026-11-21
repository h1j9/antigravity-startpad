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
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
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

async function probe() {
  const target = session.resolveTarget();
  const inspection = target.found
    ? patcher.inspect(target.languageServer)
    : { status: 'missing', restorable: false };
  const checked = await proxy.probe(config.data.proxyUrl);
  return {
    target,
    inspection,
    running: target.found ? session.runningFor(target) : [],
    proxy: {
      ok: checked.ok,
      error: checked.error,
      endpoint: checked.result ? proxy.redact(checked.result) : config.data.proxyUrl,
      kind: checked.result ? checked.result.kind : null,
      loginOk: checked.result ? checked.result.loginOk : false,
      modelOk: checked.result ? checked.result.modelOk : false,
      modelDetail: checked.result ? checked.result.modelDetail : null,
      rtt: checked.result ? checked.result.rtt : null,
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
ipcMain.handle('set-config', (event, incoming) => {
  const update = {};
  if (typeof incoming.proxyUrl === 'string') {
    const parsed = proxy.parseProxyUrl(incoming.proxyUrl);
    if (!parsed) return { ok: false, error: '代理地址格式不正确，例如 http://127.0.0.1:7897' };
    update.proxyUrl = incoming.proxyUrl.trim();
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
      const result = await session.start();
      if (result.needsQuit) log('warning', '自动启动已暂停：请先处理正在运行的反重力残留实例');
      emit('probe-refresh', {});
    }, 1600);
  });
}
