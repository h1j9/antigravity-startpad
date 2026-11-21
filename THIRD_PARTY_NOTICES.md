# 第三方项目与许可

本整合版包含对下列开源项目逻辑的适配与修改，整体按 GNU GPL v3 发布。

## FTZ-OPUS / antigravity-macos-patcher

- 来源：https://github.com/FTZ-OPUS/antigravity-macos-patcher
- 许可：GNU General Public License v3.0
- 使用部分：Antigravity 桌面版 language_server 的 x64 / arm64 补丁特征、备份与恢复思路。
- 本项目修改：移植到 Node.js，增加独立备份目录、SHA-256 版本对应校验、事务式会话记录、异常恢复与防旧备份覆盖。
- 其上游：AvenCores/open-antigravity-patcher（GPL-3.0）。

## Ikaros-521 / antigravity-launcher

- 来源：https://github.com/Ikaros-521/antigravity-launcher
- 许可：MIT License
- 使用部分：进程级代理环境变量、Chromium 代理参数、HTTP CONNECT / SOCKS5 真实握手检测、客户端定位与进程监测思路。
- 本项目修改：支持通用本地代理配置，精简界面和探测流程，并接入补丁会话、自动恢复与重新设计的应用图标。

MIT License

Copyright (c) 2026 Ikaros-521 and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
