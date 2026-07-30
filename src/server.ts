import http from "node:http";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONFIG } from "./config.js";
import { createStreamableMcpEndpoint } from "./mcp-http-endpoint.js";
import { registerTranscriptMcpTools, TRANSCRIPT_MCP_TOOL_NAMES } from "./transcript-mcp-tools.js";

const VERSION = "0.1.0-alpha.0";

export function createTranscriptMcpServer(): McpServer {
  const server = new McpServer({
    name: "douyin-transcript-mcp",
    version: VERSION,
  });
  registerTranscriptMcpTools(server.registerTool.bind(server));
  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createTranscriptMcpServer();
  await server.connect(new StdioServerTransport());
  console.error(`Douyin Transcript MCP ${VERSION} is ready on stdio.`);
}

export async function startHttpServer(): Promise<http.Server> {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(express.json({ limit: "1mb", strict: true }));

  const endpoint = createStreamableMcpEndpoint({
    endpointName: "transcript",
    createServer: createTranscriptMcpServer,
    sessionTtlMs: CONFIG.sessionTtlMs,
    sessionIdleEvictionMs: CONFIG.sessionIdleEvictionMs,
    maxSessions: CONFIG.maxSessions,
  });

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "douyin-transcript-mcp",
      version: VERSION,
      transport: "streamable-http",
      endpoint: CONFIG.mcpPath,
      tools: TRANSCRIPT_MCP_TOOL_NAMES.length,
      sessions: endpoint.stats(),
      loopbackOnly: true,
    });
  });

  app.post(CONFIG.mcpPath, (req, res) => void endpoint.handlePost(req, res));
  app.get(CONFIG.mcpPath, (req, res) => void endpoint.handleGet(req, res));
  app.delete(CONFIG.mcpPath, (req, res) => void endpoint.handleDelete(req, res));

  // Some tunnel-client versions probe OAuth metadata before forwarding a
  // no-auth MCP server. Return a non-empty 404 so the probe is unambiguous.
  for (const metadataPath of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
  ]) {
    app.all(metadataPath, (_req, res) => res.status(404).send("Not found: this loopback MCP server uses no OAuth."));
  }

  app.use((_req, res) => res.status(404).send("Not found."));

  const httpServer = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(CONFIG.httpPort, CONFIG.httpHost, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const close = async (): Promise<void> => {
    await endpoint.close();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  console.error(`Douyin Transcript MCP ${VERSION} is ready at http://${CONFIG.httpHost}:${CONFIG.httpPort}${CONFIG.mcpPath}`);
  return httpServer;
}
