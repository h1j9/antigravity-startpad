const fs = require('fs');
const path = require('path');

const EXE = 'Antigravity.exe';
const LANGUAGE_SERVER = path.join('resources', 'bin', 'language_server.exe');

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function languageServerFor(exePath) {
  const candidate = path.join(path.dirname(exePath), LANGUAGE_SERVER);
  return exists(candidate) ? candidate : null;
}

function pack(exePath, source) {
  if (!exePath || !exists(exePath)) return { found: false, path: null, languageServer: null };
  const real = fs.realpathSync(exePath);
  const languageServer = languageServerFor(real);
  return {
    found: Boolean(languageServer),
    path: real,
    languageServer,
    source,
    processName: path.basename(real),
    error: languageServer ? null : '所选程序旁边没有找到 resources/bin/language_server.exe',
  };
}

function candidates() {
  const local = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    path.join(local, 'Programs', 'Antigravity', EXE),
    path.join(local, 'Programs', 'antigravity', EXE),
    path.join(programFiles, 'Antigravity', EXE),
    path.join(programFilesX86, 'Antigravity', EXE),
  ];
}

function scanPrograms(root, maxDepth = 4) {
  if (!root || !fs.existsSync(root)) return null;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === EXE.toLowerCase()) {
        const packed = pack(full, 'auto:scan');
        if (packed.found) return packed;
      }
      if (entry.isDirectory() && depth + 1 < maxDepth && !/node_modules|\.git$/i.test(entry.name)) {
        stack.push([full, depth + 1]);
      }
    }
  }
  return null;
}

function detect() {
  const known = candidates();
  for (const candidate of known) {
    const packed = pack(candidate, 'auto:known-location');
    if (packed.found) return packed;
  }
  const scanned = scanPrograms(path.join(process.env.LOCALAPPDATA || '', 'Programs'));
  return scanned || { found: false, path: null, languageServer: null, candidates: known };
}

function resolveSaved(savedPath) {
  const saved = savedPath ? pack(savedPath, 'saved') : null;
  return saved && saved.found ? saved : detect();
}

module.exports = { detect, resolveSaved, pack, exists, languageServerFor };
