# AI 分层排障手册

本手册用于已经开始安装或运行 Douyin Transcript MCP，但某一层没有正常工作的情况。全新部署顺序见 [`AI_SETUP.md`](AI_SETUP.md)。

## 第一原则：先确认故障层，不要直接重装

依次区分六层：

1. **基础环境层**：Node.js、FFmpeg、FFprobe 和 `dist/`；
2. **本机 MCP 层**：`127.0.0.1:31338`、`/healthz` 和五个只读工具；
3. **Qwen 层**：Python 环境、CUDA、模型文件、显存和转录子进程；
4. **抖音解析层**：公开分享页、DNS、跳转、媒体候选和下载；
5. **Tunnel 层**：本机 tunnel-client 健康状态与 OpenAI 控制平面就绪状态；
6. **ChatGPT 层**：Developer Mode、选中的 Tunnel、工具发现和当前会话。

前一层没有证据证明失败时，不要破坏后一层已经工作的配置。例如三个 ready 状态均为 `true` 时，不要重装 Qwen、轮换 API key 或重建 Tunnel；应检查 ChatGPT 连接层。

## 首轮只读检查

```powershell
git status --short
PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnose.ps1
PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\status.ps1
```

`STATUS.cmd` 与 `DIAGNOSE.cmd` 的完整输出只包含布尔状态 JSON 和固定提示语，可以直接交给 AI。`STATUS.cmd` 在未就绪时返回非零退出码，这是状态结论，不代表脚本本身损坏。

如果同一台电脑可能存在多个仓库副本，`localMcpReady=true` 还不足以证明 31338 端口属于当前目录。让本机 AI 运行以下检查；它只输出布尔量，不输出 PID、用户名或完整路径：

```powershell
$expected = [IO.Path]::GetFullPath((Join-Path (Get-Location) 'dist\index.js'))
$listener = Get-NetTCPConnection -LocalPort 31338 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$owner = if ($listener) { Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue }
[pscustomobject]@{
  listenerPresent = [bool]$listener
  processIsNode = [bool]($owner -and $owner.Name -eq 'node.exe')
  belongsToThisCheckout = [bool]($owner -and $owner.CommandLine -and $owner.CommandLine.Contains($expected))
}
```

发现端口属于另一个目录时，不要停止未知进程。先向设备所有者说明两个副本的关系，再决定继续使用现有副本还是为当前副本安排迁移。

## 诊断字段的准确含义

| 字段 | 只代表什么 | 为 `false` 时 |
| --- | --- | --- |
| `node20OrNewer` | 当前终端找到 Node.js 20+ | 安装或切换版本并重开终端 |
| `ffmpegAvailable` / `ffprobeAvailable` | 命令存在于当前 `PATH` | 安装 FFmpeg 或修复 `PATH` |
| `buildPresent` | `dist/index.js` 存在 | 运行 `SETUP.cmd` |
| `qwenPythonConfigured` | Python 指针文件存在 | 运行 `INSTALL_QWEN.cmd` |
| `qwenModelConfigured` | 模型指针文件存在 | 运行 `INSTALL_QWEN.cmd` |
| `tunnelClientInstalled` | `tools/tunnel-client.exe` 存在 | 运行 `INSTALL_TUNNEL_CLIENT.cmd` |
| `tunnelConfigured` | Tunnel 状态文件与 profile 存在 | 由所有者运行 `CONFIGURE_TUNNEL.cmd` |
| `localMcpReady` | loopback MCP 健康响应且工具数为 5 | 检查本机 MCP 层 |
| `tunnelHealthy` | 本机 tunnel-client 健康端点响应 | 检查进程启动与本机 Tunnel 层 |
| `tunnelReady` | Tunnel 已准备好连接控制平面 | 检查出站网络、权限和 Tunnel 配置 |

两个 `qwen*Configured=true` 只证明指针文件存在，不证明 Python、CUDA、依赖和模型分片实际可用。`tunnelConfigured=true` 也只证明配置文件存在，不证明 DPAPI 解密、runtime key 权限或 Tunnel identity 当前有效。需要真实转录或 Tunnel ready 结果才能证明这些层工作。

## 常见状态组合

### `localMcpReady=false`

1. 先确认 `node20OrNewer` 与 `buildPresent`；
2. 确认 31338 没有被另一个程序或仓库占用；
3. 如果刚重启 Windows，运行一次 `START.cmd`；
4. 如果仍失败，只在本机摘取一条已经去除路径、URL、ID 和个人内容的错误摘要，不要上传整份日志。

### `localMcpReady=true`、`tunnelHealthy=false`

本机 MCP 正常，问题在 tunnel-client 进程或本机健康端点。先确认是否已经运行 `START.cmd`，不要重装 Qwen，也不要立即覆盖 Tunnel 配置。

### `tunnelHealthy=true`、`tunnelReady=false`

tunnel-client 已运行，但尚未连接成功。检查 OpenAI 出站 HTTPS、runtime key 权限、Tunnel 是否仍存在以及工作区策略。只有证据指向凭据或 profile 损坏时，才由设备所有者重新运行 `CONFIGURE_TUNNEL.cmd`。

### 三个 ready 状态都为 `true`，但 ChatGPT 不显示工具

本机与 Tunnel 层已经就绪。检查 ChatGPT Developer Mode、当前选择的 Tunnel、插件是否启用以及是否发现恰好五个工具。不要修改端口、监听地址或 URL。

### 只有某个公开抖音链接失败

先单独验证解析层：

```powershell
node .\scripts\accept-link-resolution.mjs "<公开抖音链接>"
```

该脚本只输出作品 ID 是否为数字、标题字符数、时长、媒体候选数和 `usedVps=false`，不会打印完整媒体地址。只有在使用者愿意公开其观看记录时才把分享短链交给外部 AI；签名 CDN 媒体地址永远不要分享。

## 常见错误码

| 错误码 | 所属层与处理方向 |
| --- | --- |
| `INVALID_DOUYIN_URL` / `PUBLIC_URL_*` | 输入或网络安全校验拒绝了 URL；使用标准公开 HTTPS 抖音链接，不要关闭 SSRF 检查 |
| `PUBLIC_DNS_*` / `PUBLIC_DOH_*` | DNS、代理 Fake-IP、DoH 或出站网络问题；检查网络解析，不要允许私网地址 |
| `PUBLIC_VIDEO_METADATA_MISSING` / `PUBLIC_VIDEO_URL_MISSING` | 分享页结构或作品状态不符合预期；先用公开样例复现 |
| `PUBLIC_VIDEO_FETCH_FAILED` / `VIDEO_DOWNLOAD_FAILED` | 分享页或媒体下载失败；检查网络、HTTP 状态及作品是否公开 |
| `VIDEO_TOO_LONG` | 视频超过当前两小时限制，不应绕过限制强行下载 |
| `QWEN_NOT_INSTALLED` | Qwen 指针、Python 或模型目标不可用；检查本机安装 |
| `QWEN_PROCESS_FAILED` | 转录子进程失败；按脱敏错误摘要检查 CUDA、显存、依赖和模型完整性 |
| `LOCAL_TRANSCRIPTION_TIMEOUT` | 转录超过两小时；检查 GPU 是否实际工作、视频时长和系统负载 |
| `QWEN_EMPTY_TRANSCRIPT` | 模型未生成有效语音片段；可能是无语音、音轨异常或识别失败 |
| `QWEN_TRANSCRIPTION_QUEUE_FULL` | 已有两个待处理任务；等待原任务，不要重复提交 |
| `QWEN_JOB_NOT_FOUND` | 任务队列保存在内存中，服务重启后旧 job ID 失效；重新提交原链接即可 |
| `INVALID_TRANSCRIPT_ID` / `TRANSCRIPT_NOT_FOUND` | 字幕 ID 无效或缓存不存在；重新完成转录并使用新返回的字幕 ID |

服务重启会清空内存中的任务 ID，但已经完成并写入 `runtime/transcripts/` 的字幕仍可在相同作品再次提交时复用。不要因为 `QWEN_JOB_NOT_FOUND` 删除字幕缓存。

## 命令副作用

| 命令 | 副作用 |
| --- | --- |
| `DIAGNOSE.cmd` | 只读；输出安全布尔状态 |
| `STATUS.cmd` | 只读；未就绪时退出码为 1 |
| `START.cmd` | 不是测试命令；若存在 `runtime/pids.json`，会先停止该仓库记录且验证过身份的进程，再重新启动 |
| `STOP.cmd` | 停止该仓库记录且通过路径验证的 MCP 与 tunnel-client 进程 |
| `SETUP.cmd` | `npm ci` 会按锁文件重建 `node_modules/`；`npm test` 会重建 `dist/` |
| `INSTALL_QWEN.cmd` | 写入大型模型、Python 环境、下载缓存和安装日志 |
| `INSTALL_TUNNEL_CLIENT.cmd` | 下载并写入 `tools/tunnel-client.exe` |
| `CONFIGURE_TUNNEL.cmd` | 覆盖本仓库 Tunnel 状态和 profile；只用于首次配置或已有证据的显式重配 |

当前版本端口固定为 `31338`。虽然 `.env.example` 展示了相关环境变量，但项目不会自动加载 `.env`，而启动、状态和 Tunnel 配置脚本都以 31338 为准。AI 不应通过修改端口排障。

## 什么可以安全粘贴给 AI

可以直接粘贴：

- `STATUS.cmd` 的完整输出；
- `DIAGNOSE.cmd` 的完整输出；
- 已删除路径、URL、ID、作品信息和正文的单行错误码摘要；
- `npm test` 的非敏感结果。

不要运行后粘贴 `Get-Content logs\*`、`Get-Content runtime\private-config\*`、`tree /f runtime`，也不要上传整个仓库压缩包或首次 Tunnel 配置截图。原始 tunnel-client 日志未经本项目脱敏，Node/Python 日志可能包含完整本机路径，字幕缓存包含来源和全文。

安全求助模板：

```text
请只根据下面的布尔诊断排查。不要要求我上传 runtime、logs、tools、整个项目压缩包，也不要让我显示 API key、tunnel ID/profile、health URL、PID、完整本机路径、完整抖音媒体 URL、作品标题/作者或字幕正文。

STATUS.cmd 输出：
<粘贴>

DIAGNOSE.cmd 输出：
<粘贴>

我执行的最后一步：<SETUP / START / STATUS / 提交转录>
可见错误码（已删除路径、URL、ID和个人内容）：<可选>
```

如果 AI 仍索要日志，只手工摘取必要错误码，并先替换绝对路径、URL、`tunnel_...`、`sk-...`、session UUID、作品/任务/字幕 ID 和正文；不要上传日志文件。

## 完成修复的证据

AI 应分别报告：

1. `npm test` 等静态检查；
2. `DIAGNOSE.cmd` 与 `STATUS.cmd` 的本机状态；
3. 31338 监听进程是否属于当前仓库；
4. 真实 ChatGPT 是否发现五个工具；
5. 一个公开样例是否完成提交、查询、读取和搜索；
6. 哪些部分仍未验证。

不要把某一层通过写成整个系统已经可用。
