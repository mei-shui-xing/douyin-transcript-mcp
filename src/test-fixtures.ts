import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decideSessionCapacity } from "./mcp-session-policy.js";
import { assertSafePublicHttpsUrl, isPublicIpAddress } from "./public-network.js";
import { createTranscriptMcpServer } from "./server.js";
import {
  buildTranscriptInitialPrompt,
  mediaUrlForLog,
  parsePublicShareHtml,
  withTranscriptTemporaryDirectory,
} from "./transcript.js";
import { TRANSCRIPT_MCP_TOOL_NAMES } from "./transcript-mcp-tools.js";

function testNetworkPolicy(): void {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("127.0.0.1"), false);
  assert.equal(isPublicIpAddress("10.0.0.1"), false);
  assert.throws(() => assertSafePublicHttpsUrl("http://www.douyin.com/video/123"));
  assert.throws(() => assertSafePublicHttpsUrl("https://user:pass@www.douyin.com/video/123"));
  assert.throws(() => assertSafePublicHttpsUrl("https://www.douyin.com:8443/video/123"));
  assert.throws(() => assertSafePublicHttpsUrl("https://127.0.0.1/video/123"));
}

function testShareParser(): void {
  const html = `<script>window._ROUTER_DATA = ${JSON.stringify({
    loaderData: {
      item: {
        item_list: [{
          aweme_id: "1234567890123456789",
          desc: "fixture title #AI",
          author: { nickname: "fixture author" },
          video: {
            duration: 12_345,
            play_addr: { url_list: ["https://media.example.test/video/tos/fixture.mp4?x=1"] },
          },
        }],
      },
    },
  })};</script>`;
  const parsed = parsePublicShareHtml(html, "1234567890123456789");
  assert.equal(parsed.workId, "1234567890123456789");
  assert.equal(parsed.title, "fixture title #AI");
  assert.equal(parsed.durationSeconds, 12.345);
  assert.equal(parsed.videoCandidates.length, 1);
  assert.throws(() => parsePublicShareHtml(html, "9999999999999999999"));
}

function testPromptAndRedaction(): void {
  const prompt = buildTranscriptInitialPrompt({
    title: "Claude Code 与 RAG #Agent",
    author: "fixture author",
    extraGlossary: ["Graph Engineering"],
  });
  assert.match(prompt, /Claude Code/);
  assert.match(prompt, /Graph Engineering/);
  const redacted = mediaUrlForLog("https://cdn.example.test/private/path/video.mp4?token=secret");
  assert.equal(redacted.includes("token=secret"), false);
  assert.equal(redacted.includes("private/path"), false);
}

function testSessionCapacity(): void {
  const decision = decideSessionCapacity({
    sessions: [
      { id: "old", createdAt: 0, lastSeenAt: 0 },
      { id: "active", createdAt: 90_000, lastSeenAt: 99_000 },
    ],
    now: 100_000,
    ttlMs: 50_000,
    idleEvictionMs: 10_000,
    maxSessions: 2,
  });
  assert.deepEqual(decision.expiredIds, ["old"]);
  assert.equal(decision.capacityAvailable, true);
}

async function testTemporaryCleanup(): Promise<void> {
  let directory = "";
  await assert.rejects(withTranscriptTemporaryDirectory("fixture", async value => {
    directory = value;
    throw new Error("fixture failure");
  }));
  const { stat } = await import("node:fs/promises");
  await assert.rejects(stat(directory));
}

async function testMcpSurface(): Promise<void> {
  const server = createTranscriptMcpServer();
  const client = new Client({ name: "fixture-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [...TRANSCRIPT_MCP_TOOL_NAMES].sort());
    for (const tool of listed.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    }
    const result = await client.callTool({ name: "douyin_list_transcripts", arguments: {} });
    assert.equal(result.isError, undefined);
  } finally {
    await client.close();
    await server.close();
  }
}

testNetworkPolicy();
testShareParser();
testPromptAndRedaction();
testSessionCapacity();
await testTemporaryCleanup();
await testMcpSurface();
console.log("All fixtures passed.");
