const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const detect = require('./detect');
const proxy = require('./proxy');
const processes = require('./processes');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class LauncherSession extends EventEmitter {
  constructor({ config, patcher }) {
    super();
    this.config = config;
    this.patcher = patcher;
    this.phase = 'idle';
    this.child = null;
    this.target = null;
    this.endpoint = null;
    this.monitor = null;
    this.emptyChecks = 0;
    this.busy = false;
    this.lastError = null;
  }

  log(level, message) {
    this.emit('log', { level, message, ts: Date.now() });
  }

  snapshot() {
    return {
      phase: this.phase,
      busy: this.busy,
      pid: this.child && !this.child.killed ? this.child.pid : null,
      targetPath: this.target ? this.target.path : null,
      endpoint: this.endpoint,
      lastError: this.lastError,
      running: Boolean(this.target && this.runningFor(this.target).length),
    };
  }

  changed() { this.emit('changed', this.snapshot()); }

  setPhase(phase) {
    this.phase = phase;
    this.changed();
  }

  resolveTarget() { return detect.resolveSaved(this.config.data.targetPath); }

  runningFor(target) {
    return target && target.path ? processes.listRunning(target.path, target.languageServer) : [];
  }

  async start() {
    if (this.busy) return { ok: false, error: '另一个启动或恢复流程正在执行，请稍候' };
    if (this.target && this.runningFor(this.target).length) {
      return { ok: true, already: true, message: '反重力已经在运行' };
    }

    this.busy = true;
    this.lastError = null;
    let patchApplied = false;
    try {
      this.setPhase('checking');
      const proxyUrl = String(this.config.data.proxyUrl || '').trim();
      if (!proxyUrl) throw new Error('请先在“设置”中填写本地代理地址和端口');
      const target = this.resolveTarget();
      if (!target.found) throw new Error(target.error || '没有找到 Antigravity，请手动选择 Antigravity.exe');
      this.target = target;
      this.log('info', `已找到客户端：${target.path}`);

      const running = this.runningFor(target);
      if (running.length) {
        this.busy = false;
        this.setPhase('idle');
        return { ok: false, needsQuit: true, running, error: '检测到未由本启动台注入代理的残留实例' };
      }

      this.log('info', `正在验证本地代理 ${proxyUrl}（不开 TUN）`);
      const checked = await proxy.probe(proxyUrl);
      if (!checked.ok) throw new Error(checked.error);
      const endpoint = checked.result;
      this.endpoint = proxy.redact(endpoint);
      this.log(endpoint.modelOk ? 'success' : 'warning',
        endpoint.modelOk
          ? `代理握手通过：${this.endpoint}（${endpoint.kind}，${endpoint.rtt}ms）`
          : `登录服务可通过，但模型服务握手失败：${endpoint.modelDetail}；仍将尝试启动`);

      this.setPhase('patching');
      const patched = this.patcher.apply(target.languageServer);
      patchApplied = true;
      this.log('success', patched.detail);

      this.setPhase('launching');
      const environment = { ...process.env, ...proxy.buildEnv(endpoint) };
      const args = [proxy.proxyArgument(endpoint), '--proxy-bypass-list=localhost;127.0.0.1;[::1]'];
      const child = spawn(target.path, args, {
        env: environment,
        cwd: path.dirname(target.path),
        detached: false,
        stdio: 'ignore',
        windowsHide: false,
      });
      this.child = child;
      let spawnError = null;
      let exitInfo = null;
      child.once('error', error => { spawnError = error; });
      child.once('exit', (code, signal) => {
        exitInfo = { code, signal };
        if (this.phase === 'running') setTimeout(() => this.checkExited(), 500);
      });
      await sleep(1400);
      if (spawnError) throw new Error(`启动失败：${spawnError.message}`);
      if (exitInfo) throw new Error(`反重力启动后立即退出（代码 ${exitInfo.code}），可能有残留实例或单实例锁`);

      this.emptyChecks = 0;
      this.setPhase('running');
      this.log('success', '反重力已启动，代理仅注入这棵进程树；localhost 保持直连');
      this.startMonitor();
      return { ok: true, pid: child.pid, endpoint: this.endpoint };
    } catch (error) {
      this.stopMonitor();
      if (patchApplied && this.target && this.target.languageServer) {
        try {
          this.patcher.restore(this.target.languageServer);
          this.log('info', '启动未完成，补丁已自动回滚');
        } catch (restoreError) {
          this.log('error', `启动失败后的自动回滚未完成：${restoreError.message}`);
        }
      }
      this.lastError = error.message;
      this.log('error', error.message);
      this.setPhase('error');
      return { ok: false, error: error.message };
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  startMonitor() {
    this.stopMonitor();
    this.monitor = setInterval(() => this.checkExited(), 2000);
  }

  stopMonitor() {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
  }

  async checkExited() {
    if (!this.target || this.phase !== 'running' || this.busy) return;
    let running;
    try { running = this.runningFor(this.target); } catch { return; }
    if (running.length) {
      this.emptyChecks = 0;
      return;
    }
    this.emptyChecks += 1;
    if (this.emptyChecks < 3) return;
    await this.finishClientExit();
  }

  async finishClientExit() {
    if (this.busy) return;
    this.busy = true;
    this.stopMonitor();
    this.log('info', '检测到反重力已退出，进程级代理环境随之消失');
    try {
      if (this.config.data.autoRestore && this.target) {
        this.setPhase('restoring');
        const restored = this.patcher.restore(this.target.languageServer);
        this.log('success', restored.detail);
      } else {
        this.log('warning', '按设置保留文件补丁；代理环境仍已随进程退出');
      }
      this.setPhase('idle');
      this.emit('client-exit', { restored: this.config.data.autoRestore });
    } catch (error) {
      this.lastError = error.message;
      this.log('error', `自动恢复失败：${error.message}`);
      this.setPhase('error');
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  async restoreNow() {
    if (this.busy) return { ok: false, error: '当前有任务正在执行' };
    const target = this.resolveTarget();
    if (!target.found) return { ok: false, error: target.error || '找不到客户端' };
    const running = this.runningFor(target);
    if (running.length) return { ok: false, error: '反重力仍在运行，请先正常关闭后再恢复', running };
    this.busy = true;
    this.target = target;
    try {
      this.setPhase('restoring');
      const result = this.patcher.restore(target.languageServer);
      this.log('success', result.detail);
      this.lastError = null;
      this.setPhase('idle');
      return result;
    } catch (error) {
      this.lastError = error.message;
      this.log('error', error.message);
      this.setPhase('error');
      return { ok: false, error: error.message };
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  async shutdown(forceClose = false) {
    const target = this.resolveTarget();
    const running = target.found ? this.runningFor(target) : [];
    if (running.length) {
      if (!forceClose) return { ok: false, running, error: '反重力仍在运行' };
      this.log('warning', '正在结束反重力进程，以便恢复补丁并退出启动台');
      processes.killInstances(running.map(item => item.pid));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && this.runningFor(target).length) await sleep(500);
      if (this.runningFor(target).length) return { ok: false, error: '反重力进程未能结束，已取消退出' };
    }
    this.stopMonitor();
    if (target.found && this.config.data.autoRestore) {
      const inspection = this.patcher.inspect(target.languageServer);
      if (inspection.status === 'patched' || inspection.restorable) {
        const restored = this.patcher.restore(target.languageServer);
        this.log('success', restored.detail);
      }
    }
    return { ok: true };
  }
}

module.exports = { LauncherSession, sleep };
