function finalizeQuit(app, tray) {
  try {
    if (tray && (typeof tray.isDestroyed !== 'function' || !tray.isDestroyed())) tray.destroy();
  } catch {
    // 即使托盘清理失败，也必须继续退出，不能再次留下无响应图标。
  }
  app.exit(0);
}

module.exports = { finalizeQuit };
