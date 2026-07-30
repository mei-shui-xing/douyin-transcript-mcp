# 交给 AI 的部署与排查说明

这份文件是给能够操作用户 Windows 电脑的 AI 编程助手阅读的。目标是让 AI 在本机完成部署、验证和故障定位，而不是让使用者把密码、令牌或整份日志发给项目作者。

## 最终效果

部署完成后，使用者可以把一个公开抖音视频链接交给 ChatGPT。这个 MCP 会在使用者自己的 Windows 电脑上下载公开媒体、调用本机 Qwen3-ASR-1.7B 转录，再把字幕分段提供给 AI 阅读和搜索。

固定边界：

- 只提供五个只读字幕工具；
- 只处理视频中的语音，不读取纯画面或画面文字；
- MCP 只监听 `127.0.0.1:31338`；
- 私人 ChatGPT 连接使用每位用户自己的 OpenAI Secure MCP Tunnel；
- 不需要 VPS、反向 SSH、Cloudflare 或公网入站端口；
- 使用时 Windows 电脑、MCP 和 tunnel-client 必须保持运行。

## AI 开始前必须遵守

1. 先完整阅读 `README.md`、本文件、`TROUBLESHOOTING.md`、`SECURITY.md` 和 `SUPPORT.md`。
2. 优先使用 Windows PowerShell 原生命令，并始终在本仓库根目录操作。
3. 如果电脑上还有其他版本或正在运行的抖音 MCP，不要移动、覆盖、停止或重新配置它；本项目必须放在自己的独立目录。
4. 不要要求使用者把 runtime API key、完整 tunnel identity、密码、验证码或私密字幕发到聊天中。
5. `CONFIGURE_TUNNEL.cmd` 需要敏感输入时暂停，让设备所有者在本机终端亲自输入。
6. 不要读取后再回显 `runtime/private-config/`、Tunnel profile、完整日志或个人字幕。确需本地检查日志时，只报告脱敏后的错误类别和必要上下文。
7. 不要删除 `runtime/transcripts/`、Qwen 模型、Python 环境或现有 Tunnel 配置来“重新开始”。先诊断，再做最小修复。
8. 不要通过绑定 `0.0.0.0`、开放防火墙端口、增加 VPS 中继或关闭网络安全检查来绕过故障。

当前版本固定使用 `127.0.0.1:31338/mcp`。不要修改 `.env.example` 中的端口来排障；启动、状态与 Tunnel 配置脚本均以 31338 为准。

## 全新部署顺序

### 1. 只读检查环境

```powershell
node --version
npm --version
ffmpeg -version
ffprobe -version
nvidia-smi
```

要求：Node.js 20+、FFmpeg/FFprobe 可用、NVIDIA GPU 驱动正常，并至少有约 12 GB 可用磁盘空间。缺少基础软件时，先向使用者说明缺什么以及安装影响。

### 2. 构建只读 MCP

```powershell
PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

该步骤执行 `npm ci` 和 `npm test`。必须看到测试通过后再继续。

### 3. 安装本机 Qwen3-ASR

```powershell
PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-qwen.ps1
```

这是耗时和占用空间最多的步骤。安装器会建立隔离环境、验证 CUDA、下载模型，并把本机路径指针写入被 Git 忽略的 `runtime/`。不要把模型或运行目录提交到 Git。

### 4. 安装官方 tunnel-client

```powershell
PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-tunnel-client.ps1
```

安装器只下载 OpenAI 官方 GitHub Release 的最新 Windows x64 资产，并验证 SHA-256。不要改成来源不明的一键脚本或镜像二进制。

### 5. 由设备所有者配置自己的 Tunnel

让使用者在 OpenAI Platform 创建自己的 Tunnel 和专用 runtime API key。然后运行：

```powershell
PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\configure-tunnel.ps1
```

到这里必须暂停，由使用者在本机终端输入自己的 `tunnel_id` 和隐藏的 API key。不要代为记录、复制到聊天、写进脚本或提交到 Git。配置由 Windows DPAPI CurrentUser 加密，换电脑或换 Windows 用户时应重新配置。

### 6. 启动并验证

```powershell
PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\status.ps1
```

成功标准：

```json
{
  "configured": true,
  "localMcpReady": true,
  "tunnelHealthy": true,
  "tunnelReady": true,
  "noVpsRequired": true
}
```

然后指导使用者在 ChatGPT Developer Mode 的插件页面选择 **Tunnel**，选中刚创建的 Tunnel，并确认只发现以下五个工具：

- `douyin_transcribe_link_accurate`
- `douyin_get_accurate_transcription_job`
- `douyin_read_transcript`
- `douyin_search_transcript`
- `douyin_list_transcripts`

### 7. 端到端验收

让使用者提供一个公开抖音视频链接，然后：

1. 调用 `douyin_transcribe_link_accurate`，只提交一次；
2. 保存返回的任务 ID；
3. 用 `douyin_get_accurate_transcription_job` 轮询，不要因运行数分钟就重复提交；
4. 完成后调用 `douyin_read_transcript`；
5. 再用一个视频中确实出现的关键词调用 `douyin_search_transcript`。

只有真实 ChatGPT 工具调用也成功，才能报告“部署完成”。`npm test` 通过只代表静态和离线验证通过。

## 诊断优先级

先运行不会输出 key、Tunnel ID 或私密路径的布尔诊断：

```powershell
PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnose.ps1
```

更完整的六层故障树、错误码、命令副作用、端口归属检查和安全粘贴模板见 [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)。特别注意：`START.cmd` 会重启本仓库记录的现有进程，`SETUP.cmd` 会按锁文件重建依赖，`CONFIGURE_TUNNEL.cmd` 会覆盖本仓库 Tunnel 配置；它们都不是首轮只读诊断命令。

字段解释与下一步：

| 字段 | 为 `false` 时优先处理 |
| --- | --- |
| `node20OrNewer` | 安装或切换到 Node.js 20+，重新打开终端 |
| `ffmpegAvailable` / `ffprobeAvailable` | 安装 FFmpeg 并确认已进入 `PATH` |
| `buildPresent` | 运行 `SETUP.cmd`，不要先重装 Qwen |
| `qwenPythonConfigured` / `qwenModelConfigured` | 运行 `INSTALL_QWEN.cmd`，检查 CUDA、磁盘和下载错误 |
| `tunnelClientInstalled` | 运行 `INSTALL_TUNNEL_CLIENT.cmd` |
| `tunnelConfigured` | 由使用者本人运行 `CONFIGURE_TUNNEL.cmd` 输入私密信息 |
| `localMcpReady` | 运行 `START.cmd`；仍失败时只在本机检查 MCP 错误日志 |
| `tunnelHealthy` | 检查 tunnel-client 是否启动及本机健康端点，不要立即重建 Tunnel |
| `tunnelReady` | 检查 OpenAI 出站 HTTPS、runtime key 权限和 Tunnel 状态 |

常见现象：

- **Windows 重启后插件不可用**：先运行 `START.cmd`，不要重建插件、Tunnel 或 URL。
- **三个 ready 状态都为 `true`，但 ChatGPT 看不到工具**：问题在 ChatGPT 连接层；确认 Developer Mode、选择的 Tunnel 和五工具列表，不要改本机监听地址。
- **工具存在，但某个抖音链接解析失败**：先确认是公开的标准抖音 HTTPS 链接。构建完成后可执行以下安全摘要测试，它不会打印完整媒体地址：

  ```powershell
  node .\scripts\accept-link-resolution.mjs "<公开抖音链接>"
  ```

- **任务一直是 `queued` 或 `running`**：不要重复提交；Qwen 首次加载和长视频转录可能需要数分钟，继续查询原任务 ID。
- **任务返回 `failed`**：记录工具返回的错误代码和必要错误摘要。优先区分链接解析、媒体下载、CUDA/模型、超时和空字幕，不要用删除全部运行目录的方式试错。
- **字幕不准确**：先确认问题属于语音识别；纯画面、贴纸和屏幕文字不在该项目能力内。

## AI 修改代码后的验证

```powershell
npm test
npm audit --audit-level=moderate
PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnose.ps1
```

如果运行环境已经配置好，再执行 `START.cmd`、`STATUS.cmd` 和一次真实 ChatGPT 工具验收。报告时把结果分为：

- 已通过的静态检查；
- 已通过的本机运行检查；
- 已通过的真实 ChatGPT 端到端检查；
- 仍未验证的部分。

不要把“代码能构建”写成“插件已经可用”。

## 可以直接交给 AI 的提示词

> 请进入这个仓库，完整阅读 `README.md`、`AI_SETUP.md`、`TROUBLESHOOTING.md`、`SECURITY.md`、`SUPPORT.md` 和 `AGENTS.md`。这是一个 Windows 本机优先、只读的抖音语音转文字 MCP。请先只读检查环境和当前状态，再按文档完成部署或定位当前故障。
>
> 不要修改或停止电脑上其他已经运行的抖音 MCP；不要引入 VPS、反向 SSH、Cloudflare 或公网入站端口；不要删除现有模型、字幕缓存或 Tunnel 配置。任何 tunnel ID、runtime API key、密码和验证码都由我本人在本机终端输入，不要让我把它们发到聊天里。
>
> 修改后请运行仓库提供的测试、布尔诊断和状态检查。只有真实 ChatGPT 五工具调用通过后，才报告端到端完成；否则明确列出尚未验证的部分。

## 支持边界

这是实验性、自助式项目。使用者应把仓库链接、上述提示词、布尔诊断结果和已经脱敏的错误摘要交给自己的 AI 完成安装与排查。项目作者不提供逐台电脑远程安装、代管凭据或针对个人网络、驱动、账号权限和代理环境的人工兜底。

只有能够稳定复现、与个人环境无关的通用代码问题，才适合提交已经脱敏的 Issue 或 Pull Request。详细规则见 `SUPPORT.md`。
