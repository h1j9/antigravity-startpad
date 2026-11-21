const $ = id => document.getElementById(id);
const api = window.startpad;
let latestProbe = null;
let sessionState = { phase: 'idle', busy: false, running: false };
let logs = [];
let noticeHandler = null;
let refreshTimer = null;

function proxyDisplay(value) {
  const text = String(value || '').trim();
  return text ? text.replace(/^[a-z]+:\/\//i, '') : '未配置代理';
}

const phaseText = {
  idle: ['准备就绪', '检查代理、应用补丁并启动；客户端退出后自动恢复。', '待机', 'neutral'],
  checking: ['正在检查环境', '正在确认客户端、残留进程和本地代理。', '检查中', 'busy'],
  patching: ['正在应用补丁', '先保存并校验原版，再写入补丁。', '补丁中', 'busy'],
  launching: ['正在启动反重力', '代理正在注入本次进程树。', '启动中', 'busy'],
  running: ['反重力运行中', '请正常使用；关闭反重力后会自动恢复原版。', '运行中', 'success'],
  restoring: ['正在恢复原版', '反重力已退出，正在从校验通过的备份恢复。', '恢复中', 'busy'],
  error: ['需要处理一个问题', '请查看运行记录；文件不会在备份不匹配时被强行覆盖。', '注意', 'error'],
};

function addLog(entry) {
  logs.push(entry);
  if (logs.length > 120) logs = logs.slice(-120);
  renderLogs();
}
function renderLogs() {
  const list = $('logList');
  if (!logs.length) { list.innerHTML = '<div class="empty-log">暂无记录。</div>'; return; }
  const labels = { info: '信息', success: '完成', warning: '注意', error: '错误' };
  list.replaceChildren();
  for (const entry of logs) {
    const row = document.createElement('div');
    row.className = `log-entry ${entry.level || 'info'}`;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = new Date(entry.ts || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
    const level = document.createElement('span');
    level.className = 'log-level';
    level.textContent = labels[entry.level] || '信息';
    const message = document.createElement('span');
    message.className = 'log-message';
    message.textContent = entry.message;
    row.append(time, level, message);
    list.append(row);
  }
  list.scrollTop = list.scrollHeight;
}
function showNotice(message, actionLabel, handler, isError = false) {
  $('noticeText').textContent = message;
  $('notice').classList.toggle('error', isError);
  $('notice').classList.remove('hidden');
  const action = $('noticeAction');
  noticeHandler = handler || null;
  if (actionLabel && handler) { action.textContent = actionLabel; action.classList.remove('hidden'); }
  else action.classList.add('hidden');
}
function hideNotice() { $('notice').classList.add('hidden'); noticeHandler = null; }
function updateSession(state) {
  sessionState = { ...sessionState, ...state };
  const [title, subtitle, pill, tone] = phaseText[sessionState.phase] || phaseText.idle;
  $('headline').textContent = title;
  $('subline').textContent = subtitle;
  $('phasePill').className = `phase-pill ${tone}`;
  $('phasePill').innerHTML = `<span class="status-dot"></span>${pill}`;
  const busy = ['checking', 'patching', 'launching', 'restoring'].includes(sessionState.phase);
  const running = sessionState.phase === 'running' || sessionState.running;
  $('launchButton').disabled = busy || running;
  $('launchLabel').textContent = running ? '反重力运行中' : busy ? '正在处理…' : '启动反重力';
  $('restoreButton').disabled = busy || running || !latestProbe || !['patched', 'unknown'].includes(latestProbe.inspection.status);
  const phase = sessionState.phase;
  let active = -1, done = -1;
  if (phase === 'checking') active = 0;
  if (phase === 'patching') { active = 1; done = 0; }
  if (phase === 'launching') { active = 2; done = 1; }
  if (phase === 'running' || phase === 'restoring') { active = 3; done = 2; }
  document.querySelectorAll('.flow-step').forEach((element, index) => {
    element.classList.toggle('active', index === active);
    element.classList.toggle('done', index <= done);
  });
}
function renderProbe(data) {
  latestProbe = data;
  const target = data.target;
  $('targetStatus').textContent = target.found ? '已找到 Antigravity' : '未找到客户端';
  $('targetDetail').textContent = target.found ? target.path : (target.error || '请手动选择 Antigravity.exe');
  $('targetDetail').title = target.path || '';
  $('settingsTargetPath').textContent = target.path || '未设置，使用自动查找';
  const status = data.inspection.status;
  const patchLabels = { patched: '已打补丁', unpatched: '原版状态', unknown: '版本无法识别', missing: '等待客户端' };
  $('patchStatus').textContent = patchLabels[status] || status;
  $('patchDetail').textContent = status === 'patched'
    ? (data.inspection.restorable ? '原版备份可用，退出后恢复' : '启动时会核验现有 .agybak 备份')
    : status === 'unpatched' ? '启动前自动备份并应用补丁' : '不会修改无法识别的文件';
  const p = data.proxy;
  if (p.configured === false) {
    $('proxyStatus').textContent = '未配置代理';
    $('proxyDetail').textContent = '请在设置中填写地址和端口';
    $('proxyDetail').title = '地址和端口以你的代理软件显示为准';
  } else {
    $('proxyStatus').textContent = p.ok ? `代理可用 · ${p.kind}` : '代理不可用';
    $('proxyDetail').textContent = p.ok ? `${p.endpoint} · ${p.rtt}ms${p.modelOk ? '' : ' · 模型握手失败'}` : (p.error || p.endpoint);
    $('proxyDetail').title = p.modelDetail || p.error || p.endpoint;
  }
  updateSession(sessionState);
}
async function refresh() {
  $('refreshButton').disabled = true;
  $('proxyStatus').textContent = '正在检查…';
  try { renderProbe(await api.probe()); }
  catch (error) { addLog({ level: 'error', message: `环境检查失败：${error.message}`, ts: Date.now() }); }
  finally { $('refreshButton').disabled = false; }
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 500); }
async function launch() {
  hideNotice();
  $('launchButton').disabled = true;
  const result = await api.launch();
  if (result.needsQuit) {
    showNotice('有未注入代理的反重力实例正在运行。请先正常退出，或确认结束这些残留实例。', '结束残留实例', async () => {
      await api.quitInstances(result.running.map(item => item.pid));
      hideNotice();
      await refresh();
    });
  } else if (!result.ok) showNotice(result.error || '启动失败，请查看运行记录。', null, null, true);
  await refresh();
}
async function restore() {
  hideNotice();
  const result = await api.restore();
  if (!result.ok) showNotice(result.error || '恢复失败', null, null, true);
  await refresh();
}
async function chooseTarget() {
  const result = await api.chooseTarget();
  if (!result.ok && !result.canceled) showNotice(result.error || '所选客户端不可用', null, null, true);
  await refresh();
}
for (const button of document.querySelectorAll('.nav-item')) {
  button.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item === button));
    document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `view-${button.dataset.view}`));
  });
}
$('launchButton').addEventListener('click', launch);
$('restoreButton').addEventListener('click', restore);
$('refreshButton').addEventListener('click', refresh);
$('chooseTargetButton').addEventListener('click', chooseTarget);
$('settingsChooseTarget').addEventListener('click', chooseTarget);
$('openBackupsButton').addEventListener('click', () => api.openBackups());
$('clearLogsButton').addEventListener('click', () => { logs = []; renderLogs(); });
$('noticeClose').addEventListener('click', hideNotice);
$('noticeAction').addEventListener('click', () => { if (noticeHandler) noticeHandler(); });
$('resetTargetButton').addEventListener('click', async () => { await api.resetTarget(); await refresh(); });
$('saveSettingsButton').addEventListener('click', async () => {
  const result = await api.setConfig({ proxyUrl: $('proxyInput').value, autoLaunch: $('autoLaunchInput').checked, autoRestore: $('autoRestoreInput').checked });
  if (!result.ok) { showNotice(result.error, null, null, true); return; }
  $('settingsSaved').textContent = '已保存';
  $('sidebarProxy').textContent = proxyDisplay($('proxyInput').value);
  setTimeout(() => { $('settingsSaved').textContent = ''; }, 1800);
  await refresh();
});
for (const link of document.querySelectorAll('[data-url]')) link.addEventListener('click', () => api.openExternal(link.dataset.url));
api.onLog(addLog);
api.onSessionChanged(state => updateSession(state));
api.onProbeRefresh(scheduleRefresh);
(async () => {
  const boot = await api.boot();
  $('versionLabel').textContent = `反重力启动台 v${boot.version} · Windows x64`;
  $('proxyInput').value = boot.config.proxyUrl;
  $('autoLaunchInput').checked = boot.config.autoLaunch;
  $('autoRestoreInput').checked = boot.config.autoRestore;
  $('sidebarProxy').textContent = proxyDisplay(boot.config.proxyUrl);
  updateSession(boot.session);
  await refresh();
})();
