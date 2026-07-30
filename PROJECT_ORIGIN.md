# Project origin

This repository is a clean, allowlisted extraction of the speech-transcription capability developed inside `douyin-controlled-mcp`.

The extraction intentionally removes browser automation, signed-in account handling, publishing, comments, messages, Creator Center workflows, Cloudflare tunnels, VPS relay code and reverse SSH. The retained application code covers public-link parsing, bounded public-network access, local Qwen3-ASR transcription, transcript caching and five read-only MCP tools.

The original project owner reports that the underlying project began as a GPT-assisted MVP built from scratch and did not adopt another GitHub repository as its application codebase. If later review identifies copied or modified third-party source, its attribution and license must be added before redistribution.
