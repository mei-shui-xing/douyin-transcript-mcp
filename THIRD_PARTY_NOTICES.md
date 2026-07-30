# Third-party notices

The project source is MIT licensed. Components installed or downloaded by the user retain their own licenses.

| Component | Purpose | License | Upstream |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` 1.30.0 | MCP transports and server APIs | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| Express 5.2.1 | Loopback Streamable HTTP endpoint | MIT | https://github.com/expressjs/express |
| Zod 4.4.3 | Tool input validation | MIT | https://github.com/colinhacks/zod |
| TypeScript 5.9.3 | Development compiler | Apache-2.0 | https://github.com/microsoft/TypeScript |
| Qwen3-ASR / `qwen-asr` | Local speech recognition | Apache-2.0 | https://github.com/QwenLM/Qwen3-ASR |
| PyTorch | CUDA inference runtime | BSD-style | https://github.com/pytorch/pytorch |
| ModelScope | Model download client | Apache-2.0 | https://github.com/modelscope/modelscope |
| OpenAI `tunnel-client` | Optional private ChatGPT MCP connection | Apache-2.0 | https://github.com/openai/tunnel-client |
| FFmpeg / FFprobe | Media probing and audio extraction | Depends on the selected build and enabled codecs | https://ffmpeg.org/legal.html |

The Git repository does not bundle `node_modules`, Qwen model weights, Python packages, FFmpeg, CUDA libraries, PyTorch wheels, or `tunnel-client.exe`. Installers retrieve them from their documented upstream sources. A redistributor who bundles binaries must preserve every applicable license and notice.
