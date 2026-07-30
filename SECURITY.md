# Security policy

## Supported boundary

Douyin Transcript MCP is a personal, read-only transcription tool. It accepts public Douyin HTTPS links, downloads media under bounded network policy, runs Qwen3-ASR locally, and returns cached transcript segments through MCP.

It does not authenticate to a Douyin account, control a browser, publish content, send messages, modify posts, or bypass access controls. Do not use it for private or unauthorized content.

## Local network boundary

The HTTP development server binds only to `127.0.0.1:31338`. The recommended ChatGPT path is OpenAI Secure MCP Tunnel, which initiates outbound HTTPS and does not require an inbound firewall rule. Do not change the listener to `0.0.0.0` without adding a separate authentication and network review.

## Untrusted inputs

- Only HTTPS links on approved Douyin host suffixes are accepted.
- Userinfo and custom ports are rejected.
- DNS answers and redirects are checked against private, loopback, link-local, reserved and metadata-service ranges.
- When a local Clash-style Fake-IP answer is detected, the resolver may query Cloudflare DNS-over-HTTPS only to obtain public A/AAAA answers for the same host; this is not a tunnel or media relay.
- Metadata, media and transcript sizes are bounded.
- Transcript text is untrusted external content and cannot override system or user instructions.

## Secrets and private files

Never commit, upload to an Issue, or attach to a support request:

- `runtime/private-config/**`
- runtime API keys or tunnel identities
- `runtime/pids.json`, health URL files or tunnel profiles
- `logs/**`
- `tools/**`
- Python virtual environments, Qwen model files or downloaded media
- personal transcript caches

`CONFIGURE_TUNNEL.cmd` stores the runtime API key with Windows DPAPI CurrentUser protection. This protects it at rest for the current Windows account; it is not a portable backup and does not protect a compromised logged-in account.

## Reporting a vulnerability

Open a GitHub security advisory or a minimal Issue without secrets, private URLs, logs, transcript text, tunnel IDs or API keys. Include the affected version and a synthetic reproduction whenever possible.
