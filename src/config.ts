import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export const CONFIG = {
  projectRoot,
  runtimeDir: path.join(projectRoot, "runtime"),
  logsDir: path.join(projectRoot, "logs"),
  transcriptDir: path.join(projectRoot, "runtime", "transcripts"),
  qwenTranscriptPythonFile: path.join(projectRoot, "runtime", "QWEN_TRANSCRIPT_PYTHON.txt"),
  qwenTranscriptModelFile: path.join(projectRoot, "runtime", "QWEN_TRANSCRIPT_MODEL.txt"),
  qwenTranscriptChunkSeconds: boundedInteger(process.env.QWEN_ASR_CHUNK_SECONDS, 90, 30, 180),
  httpHost: "127.0.0.1",
  httpPort: boundedInteger(process.env.DOUYIN_TRANSCRIPT_PORT, 31338, 1024, 65_535),
  mcpPath: "/mcp",
  sessionTtlMs: 30 * 60_000,
  sessionIdleEvictionMs: 5 * 60_000,
  maxSessions: 32,
} as const;
