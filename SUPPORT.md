# Support policy

Douyin Transcript MCP is an experimental, self-service project. Its documentation is written so users can give the repository to their own AI coding assistant for local installation, diagnosis, and minimal repair.

## Start here

- Deployment and troubleshooting runbook: [`AI_SETUP.md`](AI_SETUP.md)
- Layered fault diagnosis and safe sharing: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)
- User installation guide: [`README.md`](README.md)
- Security boundary: [`SECURITY.md`](SECURITY.md)

Run `DIAGNOSE.cmd` and `STATUS.cmd` first. Their boolean output can be shared with an AI. Raw `logs/**` and `runtime/**` content must not be pasted into a chat or Issue: third-party Tunnel logs are not processed by the application logger, and other logs or caches may contain local paths, identifiers, source information, or transcript text.

## What is not provided

The project author does not provide:

- per-computer remote installation;
- collection, storage, or entry of user credentials;
- individual support for Windows configuration, NVIDIA drivers, VPN/proxy behavior, network filtering, OpenAI account permissions, or model-download conditions;
- guaranteed response times or custom fixes for unreproducible personal environments.

Do not send credentials, verification codes, Tunnel configuration, full logs, personal transcript caches, private links, or remote-control invitations to the author.

## Appropriate issues and pull requests

An Issue is appropriate only for a general source-code defect that can be reproduced without a private account or personal data. Include:

- the repository version or commit;
- minimal reproduction steps;
- the boolean output from `DIAGNOSE.cmd`;
- the exact non-sensitive error code;
- `npm test` results;
- a synthetic or public test case when possible.

Do not attach `runtime/`, `logs/`, `tools/`, model files, Tunnel profiles, API keys, transcript caches, screenshots containing secrets, or unredacted command output.

For a security vulnerability, use a private GitHub security advisory instead of a public Issue.
