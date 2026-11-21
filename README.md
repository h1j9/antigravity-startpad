# 反重力启动台（Windows x64）

把地区适配补丁与 Clash 进程级代理合并为一个启动流程，并使用独立、简洁的桌面界面。

## 日常使用

1. 保持 Clash 运行，在 Clash 中查看你的混合、HTTP 或 SOCKS 端口，并在启动台“设置”中填写对应的代理地址；无需开启 TUN。
2. 完全退出 Antigravity（包括托盘中的旧实例）。
3. 打开“反重力启动台”。默认会自动检查代理、备份并打补丁、注入代理和启动 Antigravity；也可关闭自动启动后手动点击按钮。
4. 正常关闭 Antigravity。启动台检测到进程全部退出后，会从原版备份恢复 `language_server.exe` 并复核 SHA-256。

当前已经由第一个项目打好补丁也可以使用：启动台会核验现有 `language_server.exe.agybak` 是否属于同一版本，核验通过后接管备份，不会重复写入二进制。

## 界面与退出行为

- **启动**：显示客户端、文件补丁、Clash 状态和完整运行记录。
- **设置**：代理地址、打开后自动启动、退出后恢复原版。
- **恢复原版**：仅在 Antigravity 已退出时可用。
- 反重力运行时关闭启动台窗口，会缩到托盘继续监测。
- 从托盘退出启动台时，如反重力仍在运行，会明确询问是否结束客户端；取消则不退出。
- 异常断电或强杀启动台可能来不及恢复。下次打开后可点“恢复原版”。

## 安全边界

- 不开启 TUN，不修改系统代理，不写系统代理注册表。
- 注入 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及小写变量，并传入 Chromium `--proxy-server`；`localhost`、`127.0.0.1`、`::1` 始终绕过代理。
- 只修改桌面版 `resources/bin/language_server.exe`，不包含 IDE、CLI 或 VS Code 扩展补丁。
- 原版备份独立保存在启动台用户数据目录，可从界面“备份目录”打开。
- 客户端更新、备份损坏或版本不对应时会停止覆盖，并保留现场与备份。
- 补丁只处理本地客户端判定，不能保证 Google 服务端账号资格、订阅、配额或地区审核结果。

## 从源码运行与构建

```powershell
npm install
npm test
$env:AG_STARTPAD_NO_AUTO='1'
npm start
```

设置 `AG_STARTPAD_NO_AUTO=1` 只是便于开发时查看界面，避免打开后自动启动客户端。正常使用打包版无需设置。

```powershell
npm run dist:win
```

产物在 `dist/`：NSIS 安装版与 portable 免安装版。成品未购买代码签名证书，Windows SmartScreen 可能提示未知发布者。

## 测试

- 17 项单元测试：x64 / arm64 特征、备份与恢复、重复启动、接管旧备份、崩溃恢复、防误覆盖、代理变量与本地握手，以及窗口销毁后的消息发送竞态。
- 端到端测试使用临时模拟客户端，不操作真实 Antigravity。

## 来源

- https://github.com/FTZ-OPUS/antigravity-macos-patcher （GPL-3.0）
- https://github.com/Ikaros-521/antigravity-launcher （MIT）

整合版整体按 GPL-3.0 发布，详见 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`。
