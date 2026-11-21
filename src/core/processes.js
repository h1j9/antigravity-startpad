const { spawnSync } = require('child_process');
const path = require('path');

function listRunning(targetPath, languageServerPath) {
  if (!targetPath) return [];
  const expectedNames = new Set([path.basename(targetPath).toLowerCase()]);
  if (languageServerPath) expectedNames.add(path.basename(languageServerPath).toLowerCase());
  const result = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
  });
  return (result.stdout || '').split(/\r?\n/).map(line => {
    const match = line.match(/^"([^"]+)","(\d+)"/);
    if (!match) return null;
    const pid = Number(match[2]);
    return expectedNames.has(match[1].toLowerCase()) && pid !== process.pid
      ? { name: match[1], pid }
      : null;
  }).filter(Boolean);
}

function killInstances(pids) {
  const targets = [...new Set((pids || []).map(Number))]
    .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  for (const pid of targets) {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      encoding: 'utf8',
      timeout: 12000,
      windowsHide: true,
    });
  }
}

module.exports = { listRunning, killInstances };
