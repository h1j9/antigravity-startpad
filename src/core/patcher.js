const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ANY = '[\\s\\S]';
const TBZ = `[\\x03\\x23\\x43\\x63\\x83\\xa3\\xc3\\xe3]${ANY}${ANY}\\x36`;
const TOKEN_SETUP = `(?:${ANY}{4}){1,2}\\x03\\x10\\x06\\xa9`;

const GATES = [
  {
    desc: 'hasValidAuth=true (x64)',
    original: new RegExp(`\\x80\\x78\\x08\\x00\\x74${ANY}\\x48\\x8b${ANY}\\x24${ANY}\\x48\\x89${ANY}\\x60`, 'g'),
    patched: new RegExp(`\\xc6\\x40\\x08\\x01\\x90\\x90\\x48\\x8b${ANY}\\x24${ANY}\\x48\\x89${ANY}\\x60`, 'g'),
    fix: Buffer.from('c64008019090', 'hex'),
  },
  {
    desc: 'hasValidAuth=true (arm64)',
    original: new RegExp(`\\x03\\x20\\x40\\x39${TBZ}${TOKEN_SETUP}`, 'g'),
    patched: new RegExp(`\\x23\\x00\\x80\\x52\\x03\\x20\\x00\\x39${TOKEN_SETUP}`, 'g'),
    fix: Buffer.from('2300805203200039', 'hex'),
  },
];

function indices(regex, text) {
  regex.lastIndex = 0;
  const found = [];
  let match;
  while ((match = regex.exec(text))) {
    found.push(match.index);
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return found;
}

function resolveGate(data) {
  const text = data.toString('latin1');
  for (const gate of GATES) {
    const patched = indices(gate.patched, text);
    if (patched.length) return { status: 'patched', offset: patched[0], gate };
    const original = indices(gate.original, text);
    if (original.length > 1) throw new Error('补丁特征不是唯一的，为避免改错文件已停止');
    if (original.length === 1) return { status: 'unpatched', offset: original[0], gate };
  }
  return { status: 'unknown', offset: -1, gate: null };
}

function applyGate(data) {
  const resolved = resolveGate(data);
  if (resolved.status === 'patched') return { data: Buffer.from(data), ...resolved };
  if (resolved.status !== 'unpatched') {
    throw new Error('没有匹配到受支持的补丁特征；可能是客户端版本已变化，未修改文件');
  }
  const output = Buffer.from(data);
  if (resolved.offset < 0 || resolved.offset + resolved.gate.fix.length > output.length) {
    throw new Error('补丁写入位置越界，已停止');
  }
  resolved.gate.fix.copy(output, resolved.offset);
  return { data: output, ...resolved };
}

function getStatus(file) {
  try { return resolveGate(fs.readFileSync(file)).status; } catch { return 'unknown'; }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function fileHash(file) {
  return sha256(fs.readFileSync(file));
}

function samePath(a, b) {
  return Boolean(a && b) && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function atomicWrite(file, data, mode) {
  const directory = path.dirname(file);
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`);
  let fd = null;
  try {
    const currentMode = mode || (fs.existsSync(file) ? fs.statSync(file).mode : 0o666);
    fd = fs.openSync(temp, 'w', currentMode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    if (fs.existsSync(temp)) { try { fs.unlinkSync(temp); } catch { /* best effort */ } }
  }
}

class Patcher {
  constructor(userDataDir) {
    this.directory = path.join(userDataDir, 'patch-backups');
    this.sessionFile = path.join(this.directory, 'session.json');
    fs.mkdirSync(this.directory, { recursive: true });
  }

  readSession() {
    try {
      const session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
      return session && session.version === 1 ? session : null;
    } catch { return null; }
  }

  saveSession(session) {
    fs.mkdirSync(this.directory, { recursive: true });
    atomicWrite(this.sessionFile, Buffer.from(JSON.stringify({ ...session, updatedAt: new Date().toISOString() }, null, 2)));
  }

  clearSession() {
    try { fs.unlinkSync(this.sessionFile); } catch { /* already absent */ }
  }

  validSessionFor(targetPath) {
    const session = this.readSession();
    if (!session || !samePath(session.targetPath, targetPath)) return null;
    if (!session.backupFile || !fs.existsSync(session.backupFile)) return null;
    return session;
  }

  inspect(targetPath) {
    const status = targetPath && fs.existsSync(targetPath) ? getStatus(targetPath) : 'missing';
    const session = this.validSessionFor(targetPath);
    return {
      status,
      restorable: Boolean(session),
      phase: session ? session.phase : null,
      backupFile: session ? session.backupFile : null,
      legacyBackup: Boolean(targetPath && fs.existsSync(`${targetPath}.agybak`)),
    };
  }

  makeBackup(targetPath, originalData) {
    const originalHash = sha256(originalData);
    const key = sha256(Buffer.from(path.resolve(targetPath).toLowerCase())).slice(0, 16);
    const backupFile = path.join(this.directory, `${key}-${originalHash.slice(0, 16)}.bin`);
    if (!fs.existsSync(backupFile) || fileHash(backupFile) !== originalHash) {
      atomicWrite(backupFile, originalData, 0o600);
    }
    if (fileHash(backupFile) !== originalHash) throw new Error('原版备份校验失败，已停止');
    return { backupFile, originalHash };
  }

  adoptPatched(targetPath, currentData) {
    const existing = this.validSessionFor(targetPath);
    if (existing) {
      const backup = fs.readFileSync(existing.backupFile);
      if (sha256(backup) !== existing.originalHash) throw new Error('已有备份未通过哈希校验');
      if (resolveGate(backup).status !== 'unpatched') throw new Error('已有备份不是可识别的原版文件');
      const expected = applyGate(backup).data;
      if (sha256(currentData) !== sha256(expected)) {
        throw new Error('当前补丁文件与备份不对应，可能客户端已更新；未强行覆盖');
      }
      this.saveSession({ ...existing, phase: 'patched', patchedHash: sha256(currentData) });
      return { backupFile: existing.backupFile, originalHash: existing.originalHash };
    }

    const legacy = `${targetPath}.agybak`;
    if (!fs.existsSync(legacy)) {
      throw new Error('检测到客户端已打补丁，但找不到可验证的原版备份；为避免无法恢复，已取消启动');
    }
    const backup = fs.readFileSync(legacy);
    if (resolveGate(backup).status !== 'unpatched') {
      throw new Error('现有 .agybak 不是可识别的原版文件，已取消启动');
    }
    const expected = applyGate(backup).data;
    if (sha256(expected) !== sha256(currentData)) {
      throw new Error('当前文件与 .agybak 备份不属于同一版本，已取消启动');
    }
    return this.makeBackup(targetPath, backup);
  }

  apply(targetPath) {
    if (!targetPath || !fs.existsSync(targetPath)) throw new Error('找不到 language_server.exe');
    if (fs.lstatSync(targetPath).isSymbolicLink()) throw new Error('目标是符号链接，已拒绝修改');

    const current = fs.readFileSync(targetPath);
    const state = resolveGate(current);
    if (state.status === 'unknown') {
      throw new Error('没有匹配到受支持的补丁特征；可能是客户端版本已变化，未修改文件');
    }

    let backupInfo;
    let expected;
    let already = false;

    if (state.status === 'patched') {
      backupInfo = this.adoptPatched(targetPath, current);
      expected = current;
      already = true;
    } else {
      const currentHash = sha256(current);
      const previous = this.validSessionFor(targetPath);
      if (previous && previous.originalHash === currentHash && fileHash(previous.backupFile) === currentHash) {
        backupInfo = { backupFile: previous.backupFile, originalHash: currentHash };
      } else {
        backupInfo = this.makeBackup(targetPath, current);
      }
      expected = applyGate(current).data;
    }

    const session = {
      version: 1,
      targetPath: path.resolve(targetPath),
      backupFile: backupInfo.backupFile,
      originalHash: backupInfo.originalHash,
      patchedHash: null,
      phase: 'prepared',
    };
    this.saveSession(session);

    if (!already) {
      try {
        atomicWrite(targetPath, expected);
        if (fileHash(targetPath) !== sha256(expected) || getStatus(targetPath) !== 'patched') {
          throw new Error('写入后的补丁复核失败');
        }
      } catch (error) {
        let restoreNote = '';
        try { this.restore(targetPath); } catch (restoreError) { restoreNote = `；自动回滚也未完成：${restoreError.message}`; }
        throw new Error(`${error.message}${restoreNote}`);
      }
    }

    this.saveSession({ ...session, phase: 'patched', patchedHash: sha256(expected) });
    return {
      ok: true,
      already,
      detail: already ? '补丁已存在，备份与文件版本复核通过' : `${state.gate.desc}，写入并复核成功`,
      inspection: this.inspect(targetPath),
    };
  }

  restore(targetPath) {
    const session = this.validSessionFor(targetPath);
    if (!session) {
      if (targetPath && fs.existsSync(targetPath) && getStatus(targetPath) === 'unpatched') {
        return { ok: true, already: true, detail: '当前已经是原版' };
      }
      if (targetPath && fs.existsSync(targetPath) && getStatus(targetPath) === 'patched') {
        const current = fs.readFileSync(targetPath);
        this.adoptPatched(targetPath, current);
        return this.restore(targetPath);
      }
      throw new Error('没有可用于恢复的原版备份记录');
    }

    if (!fs.existsSync(targetPath)) throw new Error('找不到待恢复的 language_server.exe');
    const current = fs.readFileSync(targetPath);
    if (resolveGate(current).status === 'unpatched') {
      this.clearSession();
      return { ok: true, already: true, detail: '当前已经是原版' };
    }

    const backup = fs.readFileSync(session.backupFile);
    if (sha256(backup) !== session.originalHash) throw new Error('原版备份哈希不匹配，已拒绝恢复');
    if (resolveGate(backup).status !== 'unpatched') throw new Error('备份不是可识别的原版文件，已拒绝恢复');
    const expectedPatched = applyGate(backup).data;
    const expectedHash = sha256(expectedPatched);
    if (session.patchedHash && session.patchedHash !== expectedHash) {
      throw new Error('补丁记录内部校验失败，已拒绝恢复');
    }
    if (sha256(current) !== expectedHash) {
      throw new Error('当前文件已在补丁后被其他程序改变，可能客户端刚更新；已拒绝用旧备份覆盖');
    }

    atomicWrite(targetPath, backup);
    if (fileHash(targetPath) !== session.originalHash || getStatus(targetPath) !== 'unpatched') {
      throw new Error('恢复后的文件复核失败，原版备份仍保留，可再次尝试');
    }
    this.clearSession();
    return { ok: true, already: false, detail: '已从校验通过的原版备份恢复，并复核文件哈希' };
  }
}

module.exports = { Patcher, resolveGate, applyGate, getStatus, sha256, atomicWrite, GATES };
