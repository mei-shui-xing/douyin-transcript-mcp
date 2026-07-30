# Douyin Transcript MCP

A standalone, read-only, local-first MCP server for transcribing speech from public Douyin videos with Qwen3-ASR-1.7B on a Windows PC.

The recommended setup does not use a VPS, reverse SSH, Cloudflare, or a public inbound port. Each user runs the MCP server and model on their own computer and connects it to ChatGPT through their own OpenAI Secure MCP Tunnel over outbound HTTPS.

This repository distributes source code, not one shared public plugin. Secure MCP Tunnel is intended for private and developer-mode connections; public plugin submission still requires a stable public HTTPS endpoint. See the official [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## Five read-only tools

- `douyin_transcribe_link_accurate`
- `douyin_get_accurate_transcription_job`
- `douyin_read_transcript`
- `douyin_search_transcript`
- `douyin_list_transcripts`

The server transcribes spoken audio only. It does not read visual-only content or on-screen text, and transcript content must be treated as untrusted external data.

## Windows quick start

Requirements: Windows 10/11 x64, Node.js 20+, Python 3.12 or `uv`, FFmpeg/FFprobe, an NVIDIA GPU with about 8 GB VRAM, 12 GB free disk space, OpenAI Tunnel permissions, and ChatGPT Developer Mode.

1. Run `SETUP.cmd`.
2. Run `INSTALL_QWEN.cmd`.
3. Run `INSTALL_TUNNEL_CLIENT.cmd`.
4. Create your own tunnel and runtime API key in [OpenAI Platform](https://platform.openai.com/settings/organization/tunnels).
5. Run `CONFIGURE_TUNNEL.cmd`. The API key input is hidden and stored with Windows DPAPI CurrentUser protection.
6. Run `START.cmd`, then `STATUS.cmd`.
7. In ChatGPT developer-mode plugin settings, choose **Tunnel**, select your tunnel, and verify that exactly five tools are discovered.

After a Windows restart, run `START.cmd` again. The tunnel identity remains stable, so the ChatGPT connection does not need a new URL.

Never commit or share `runtime/`, `logs/`, `tools/`, model files, transcripts containing private material, runtime API keys, or tunnel profiles.

Project code is MIT licensed. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency and model licenses.
