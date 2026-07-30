# Douyin Transcript MCP

一个独立、只读、本机优先的抖音语音转文字 MCP。把公开抖音视频链接交给 ChatGPT 或其他 MCP 客户端，视频会在你自己的 Windows 电脑上下载并由 Qwen3-ASR-1.7B 转录；字幕、模型和运行凭据都留在本机。

[English](README.en.md)

## 为什么不需要 VPS

推荐架构只有三层：

```text
ChatGPT / Codex
      │ OpenAI Secure MCP Tunnel（仅出站 HTTPS 443）
      ▼
你的 Windows 电脑：Douyin Transcript MCP
      │
      └─ Qwen3-ASR + 本地字幕缓存
```

- 不开放公网入站端口。
- 不使用 VPS、反向 SSH、Cloudflare Quick Tunnel 或固定公网 URL。
- 电脑重启后再次运行 `START.cmd`，原来的 tunnel identity 不变，ChatGPT 中无需换 URL。
- 电脑必须开机并联网，插件才能调用本机模型。

这里的“分发”是指公开 GitHub 源码，让每位用户在自己的电脑上运行并创建自己的私有 Tunnel。OpenAI 官方说明 Secure MCP Tunnel 适合私有服务器和开发模式，但不能替代公开插件提交所要求的稳定公网 HTTPS 服务。参见 [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 与 [连接 ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

## 能力

仓库只暴露五个只读工具：

1. `douyin_transcribe_link_accurate`：提交公开抖音链接，创建本机 Qwen 转写任务。
2. `douyin_get_accurate_transcription_job`：查询后台任务状态。
3. `douyin_read_transcript`：按片段读取长字幕。
4. `douyin_search_transcript`：在字幕中搜索关键词和时间点。
5. `douyin_list_transcripts`：列出本机缓存。

它只处理视频语音，不识别纯画面、贴纸或画面文字；字幕属于不可信外部内容，不能当作指令执行。

## 适用环境

- Windows 10/11 x64
- Node.js 20 或更高版本
- Python 3.12（也可由 `uv` 管理）
- NVIDIA GPU，建议至少 8 GB 显存
- 至少 12 GB 可用磁盘空间
- FFmpeg 与 FFprobe 已加入 `PATH`
- 能够访问抖音、ModelScope、GitHub 和 OpenAI 的出站 HTTPS
- OpenAI Platform Tunnel 权限与 ChatGPT Developer Mode；具体可用性取决于账号和工作区策略

## 安装

### 1. 准备基础软件

安装 Node.js 20+、Python 3.12/`uv` 和 FFmpeg。Windows 可通过 `winget` 安装 FFmpeg：

```powershell
winget install --id Gyan.FFmpeg -e
```

重新打开终端后确认：

```powershell
node --version
ffmpeg -version
ffprobe -version
```

### 2. 构建 MCP

双击 `SETUP.cmd`。它会运行 `npm ci`、类型检查、构建和离线 fixtures。

### 3. 安装本机 Qwen3-ASR

双击 `INSTALL_QWEN.cmd`。安装器会：

- 创建隔离的 Python 环境；
- 安装并校验 CUDA 版 PyTorch；
- 安装 Qwen3-ASR 与 ModelScope；
- 下载 Qwen3-ASR-1.7B 到被 Git 忽略的 `runtime/`。

模型较大，只需下载一次。

### 4. 安装 OpenAI 官方 tunnel-client

双击 `INSTALL_TUNNEL_CLIENT.cmd`。脚本只从 OpenAI 官方 GitHub Release 的 `latest` 版本下载 Windows x64 资产，并根据 Release 提供的 SHA-256 摘要校验；二进制保存在被 Git 忽略的 `tools/`。

### 5. 创建并配置自己的 Tunnel

1. 在 [OpenAI Platform Tunnel 设置](https://platform.openai.com/settings/organization/tunnels) 创建 Tunnel。
2. 创建专用的 runtime API key。不要把 key 发到聊天、Issue、截图或日志中。
3. 双击 `CONFIGURE_TUNNEL.cmd`。
4. 按提示粘贴自己的 `tunnel_id`；输入 API key 时终端不会显示字符。

API key 使用 Windows DPAPI CurrentUser 加密，配置和 tunnel profile 只写入被忽略且限制 ACL 的 `runtime/private-config/`。它不能跨 Windows 用户或跨电脑直接恢复；换电脑时应重新创建配置。

### 6. 启动并连接 ChatGPT

1. 双击 `START.cmd`。
2. 双击 `STATUS.cmd`，确认 `localMcpReady`、`tunnelHealthy`、`tunnelReady` 都为 `true`。
3. 在 ChatGPT 打开 Developer Mode。
4. 进入插件页面，点击加号，Connection 选择 **Tunnel**。
5. 选择刚才创建的 Tunnel，确认发现的工具恰好是上面的五个只读工具。

现在可以直接说：“请用抖音转文字处理这个链接：……”

## 日常使用

- 每次 Windows 重启后运行 `START.cmd`。
- 查看状态运行 `STATUS.cmd`。
- 安全停止运行 `STOP.cmd`；模型和字幕缓存不会删除。
- 排查环境运行 `DIAGNOSE.cmd`；它只输出布尔状态，不输出 key 或 tunnel ID。

## 备份

可备份 `runtime/transcripts/` 中已经完成的字幕。模型和 Python 环境可以重新下载，不建议备份。不要把以下内容上传 GitHub、网盘公开链接或 Issue：

- `runtime/private-config/`
- `runtime/tunnel-*`、`runtime/pids.json`
- `logs/`
- `tools/`
- Qwen 模型、Python 虚拟环境和下载缓存

## 开发验证

```powershell
npm ci
npm test
npm run start:http
```

HTTP 调试端点只监听 `127.0.0.1:31338/mcp`，不会监听局域网或公网地址。也可以运行 `npm run start:stdio` 连接其他本地 MCP 客户端。

## 安全与边界

- 只接受不含账号信息、自定义端口的抖音 HTTPS 链接。
- 每一次跳转都执行 DNS 和私网/保留地址检查，避免 SSRF。
- 媒体下载有大小、超时和类型限制，临时文件在任务结束后清理。
- 子进程不会继承名称中含 token、secret、password、cookie 或 authorization 的环境变量。
- 日志会删去媒体路径、查询参数和常见令牌格式。
- 工具均为只读，不负责登录、点赞、评论、发布、删除或绕过访问控制。

完整说明见 [SECURITY.md](SECURITY.md)。

## 项目来源与许可

此仓库从 `douyin-controlled-mcp` 中经过白名单抽取，移除了浏览器控制、账号操作、VPS 中继、Cloudflare 和写入工具，形成独立的本机转录项目。项目代码使用 MIT License；依赖与模型遵循各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [PROJECT_ORIGIN.md](PROJECT_ORIGIN.md)。
