function isUsable(win) {
  try {
    if (!win || win.isDestroyed()) return false;
    const contents = win.webContents;
    return Boolean(contents && !contents.isDestroyed());
  } catch {
    return false;
  }
}

function send(win, channel, payload) {
  if (!isUsable(win)) return false;
  try {
    win.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

function show(win) {
  if (!isUsable(win)) return false;
  try {
    win.show();
    if (isUsable(win)) win.focus();
    return true;
  } catch {
    return false;
  }
}

module.exports = { isUsable, send, show };
