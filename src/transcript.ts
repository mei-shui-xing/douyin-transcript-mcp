import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import {
  assertSafePublicHttpsUrl,
  fetchPublicHttpsWithRedirects,
  readResponseTextWithLimit,
} from "./public-network.js";
import type { TranscriptRecord } from "./types.js";

const MEDIA_URL_RE = /(?:\.mp4(?:$|\?)|\.m4a(?:$|\?)|\.mp3(?:$|\?)|video\/tos|douyinvod|bytecdn|mime_type=video|playwm|play\/)/i;
const PUBLIC_SHARE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
const PUBLIC_VIDEO_CACHE_TTL_MS = 5 * 60_000;
const QWEN_ASR_MODEL_NAME = "Qwen/Qwen3-ASR-1.7B";
const QWEN_ASR_CONTEXT_VERSION = "ai-technical-v2";
const QWEN_MAX_PENDING_JOBS = 2;
const QWEN_TRANSCRIPTION_TIMEOUT_MS = 2 * 60 * 60_000;
const QWEN_MAX_DURATION_SECONDS = 2 * 60 * 60;
const MAX_LOCAL_MEDIA_BYTES = 512 * 1024 * 1024;
const MAX_PUBLIC_METADATA_BYTES = 8 * 1024 * 1024;
const DOUYIN_METADATA_HOST_SUFFIXES = ["douyin.com", "iesdouyin.com"] as const;
const DEFAULT_TECHNICAL_GLOSSARY = [
  "OpenAI",
  "Anthropic",
  "Claude",
  "Claude Code",
  "Codex",
  "ChatGPT",
  "Token",
  "RAG",
  "Retrieval-Augmented Generation",
  "Agent",
  "Agentic Search",
  "MCP",
  "embedding",
  "向量检索",
  "向量数据库",
  "语义检索",
  "JavaScript",
  "TypeScript",
  "Python",
  "React",
  "GitHub",
];

export type PublicVideoResolution = {
  source: "iesdouyin-router-data";
  workId: string;
  canonicalUrl: string;
  title: string;
  author: string | null;
  durationSeconds: number | null;
  videoCandidates: string[];
};

export type QwenTranscriptionJob = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  sourceUrl: string;
  language: "Chinese" | "auto";
  attempt: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  transcriptId?: string;
  error?: string;
  record?: TranscriptRecord;
};

const publicVideoCache = new Map<string, { expiresAt: number; value: PublicVideoResolution }>();
const qwenTranscriptionJobs = new Map<string, QwenTranscriptionJob>();
let qwenTranscriptionQueue: Promise<void> = Promise.resolve();

export function buildTranscriptInitialPrompt(input: {
  title?: string | null;
  author?: string | null;
  extraGlossary?: string[];
}): string {
  const hashtags = (input.title ?? "").match(/#[^#\s，。！？、]{1,40}/g)?.slice(0, 20) ?? [];
  const environmentGlossary = (process.env.DOUYIN_TRANSCRIPT_GLOSSARY ?? "")
    .split(/[,，；;\n]/)
    .map(item => item.trim())
    .filter(Boolean);
  const terms = [...new Set([
    ...DEFAULT_TECHNICAL_GLOSSARY,
    ...environmentGlossary,
    ...(input.extraGlossary ?? []),
  ])].slice(0, 100);
  return [
    input.title ? `作品标题：${input.title}` : "",
    input.author ? `作者：${input.author}` : "",
    hashtags.length ? `话题：${hashtags.join(" ")}` : "",
    `术语表：${terms.join("、")}`,
    "请按原音准确转写；术语表只用于识别提示，不要添加音频中不存在的内容。",
  ].filter(Boolean).join("\n");
}

function safeId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return cleaned || createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export function mediaUrlForLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const pathFingerprint = createHash("sha256").update(parsed.pathname).digest("hex").slice(0, 12);
    return `${parsed.origin}/[path-redacted]#sha256-${pathFingerprint}`.slice(0, 180);
  } catch {
    return "[invalid-url]";
  }
}

function safeErrorForLog(error: unknown): string {
  return String(error)
    .replace(/[a-z]:\\[^\r\n"'<>]+/gi, "[path-redacted]")
    .replace(/(^|[\s("'=])\/(?:tmp|var|opt|etc|home|root)\/[^\s"'<>]*/gim, "$1[path-redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => mediaUrlForLog(value))
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function transcriptPath(transcriptId: string): string {
  return path.join(CONFIG.transcriptDir, safeId(transcriptId), "transcript.json");
}

export async function withTranscriptTemporaryDirectory<T>(
  transcriptId: string,
  task: (directory: string) => Promise<T>,
): Promise<T> {
  const temporaryRoot = path.join(CONFIG.transcriptDir, ".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(path.join(temporaryRoot, `${safeId(transcriptId)}-`));
  try {
    return await task(directory);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function douyinWorkId(rawUrl: string): string | null {
  const direct = rawUrl.match(/\/(?:video|note|article)\/(\d{8,})/i)?.[1];
  if (direct) return direct;
  return rawUrl.match(/(?:modal_id|aweme_id)=(\d{8,})/i)?.[1] ?? null;
}

function assertPublicDouyinUrl(rawUrl: string): URL {
  try {
    return assertSafePublicHttpsUrl(rawUrl, DOUYIN_METADATA_HOST_SUFFIXES);
  } catch {
    throw new Error("INVALID_DOUYIN_URL: 只允许不含账号信息和自定义端口的抖音 HTTPS 链接。");
  }
}

function extractAssignedJson(html: string, marker: string): unknown {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error("ROUTER_DATA_MISSING");
  const start = html.indexOf("{", markerIndex + marker.length);
  if (start < 0) throw new Error("ROUTER_DATA_INVALID");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, index + 1));
    }
  }
  throw new Error("ROUTER_DATA_INVALID");
}

function findItemRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findItemRecord(item);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.item_list) && record.item_list[0] && typeof record.item_list[0] === "object") {
    return record.item_list[0] as Record<string, unknown>;
  }
  for (const child of Object.values(record)) {
    const found = findItemRecord(child);
    if (found) return found;
  }
  return null;
}

function collectMediaUrls(
  value: unknown,
  keyPath = "",
  output: Array<{ url: string; score: number }> = [],
): Array<{ url: string; score: number }> {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && /^https:\/\//i.test(item) && MEDIA_URL_RE.test(item)) {
        const pathScore = /play_addr|playapi|download_addr/i.test(keyPath) ? 100 : 0;
        const codecScore = /h264|play_addr(?!_bytevc)/i.test(keyPath) ? 20 : 0;
        const formatScore = /\.m3u8(?:$|\?)/i.test(item) ? -100 : 10;
        output.push({ url: item.replace(/playwm/gi, "play"), score: pathScore + codecScore + formatScore });
      } else {
        collectMediaUrls(item, keyPath, output);
      }
    }
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectMediaUrls(child, `${keyPath}.${key}`, output);
  }
  return output;
}

export function parsePublicShareHtml(html: string, requestedWorkId: string): PublicVideoResolution {
  const item = findItemRecord(extractAssignedJson(html, "window._ROUTER_DATA"));
  if (!item) throw new Error("PUBLIC_VIDEO_METADATA_MISSING: 分享页没有返回作品元数据。");
  const actualWorkId = String(item.aweme_id ?? item.item_id ?? "");
  if (actualWorkId && actualWorkId !== requestedWorkId) {
    throw new Error(`PUBLIC_VIDEO_ID_MISMATCH: 分享页作品与请求作品不一致。`);
  }
  const candidates = collectMediaUrls(item.video)
    .sort((left, right) => right.score - left.score)
    .map(candidate => candidate.url);
  const videoCandidates = [...new Set(candidates)];
  if (!videoCandidates.length) throw new Error("PUBLIC_VIDEO_URL_MISSING: 分享页没有返回可下载的视频地址。");
  const author = item.author && typeof item.author === "object"
    ? item.author as Record<string, unknown>
    : null;
  const durationMs = item.video && typeof item.video === "object"
    ? Number((item.video as Record<string, unknown>).duration)
    : Number.NaN;
  const workId = actualWorkId || requestedWorkId;
  return {
    source: "iesdouyin-router-data",
    workId,
    canonicalUrl: `https://www.douyin.com/video/${workId}`,
    title: String(item.desc ?? ""),
    author: author ? String(author.nickname ?? author.unique_id ?? "") || null : null,
    durationSeconds: Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : null,
    videoCandidates,
  };
}

export async function resolvePublicDouyinVideo(rawUrl: string): Promise<PublicVideoResolution> {
  const input = assertPublicDouyinUrl(rawUrl);
  let workId = douyinWorkId(input.href);
  if (!workId) {
    const response = await fetchPublicHttpsWithRedirects(input, {
      headers: { "User-Agent": PUBLIC_SHARE_UA, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(12_000),
    }, { allowedHostSuffixes: DOUYIN_METADATA_HOST_SUFFIXES });
    workId = douyinWorkId(response.url)
      ?? douyinWorkId(await readResponseTextWithLimit(response, MAX_PUBLIC_METADATA_BYTES));
  }
  if (!workId) throw new Error("WORK_ID_NOT_FOUND: 无法从分享链接解析作品 ID。");
  const cached = publicVideoCache.get(workId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const response = await fetchPublicHttpsWithRedirects(`https://www.iesdouyin.com/share/video/${workId}`, {
    headers: {
      "User-Agent": PUBLIC_SHARE_UA,
      Referer: "https://www.douyin.com/",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15_000),
  }, { allowedHostSuffixes: DOUYIN_METADATA_HOST_SUFFIXES });
  if (!response.ok) throw new Error(`PUBLIC_VIDEO_FETCH_FAILED: 分享页返回 HTTP ${response.status}。`);
  const result = parsePublicShareHtml(
    await readResponseTextWithLimit(response, MAX_PUBLIC_METADATA_BYTES),
    workId,
  );
  publicVideoCache.set(workId, { expiresAt: Date.now() + PUBLIC_VIDEO_CACHE_TTL_MS, value: result });
  return result;
}

async function readQwenRuntime(): Promise<{ python: string; modelPath: string }> {
  try {
    const [pythonValue, modelValue] = await Promise.all([
      readFile(CONFIG.qwenTranscriptPythonFile, "utf8"),
      readFile(CONFIG.qwenTranscriptModelFile, "utf8"),
    ]);
    const python = pythonValue.trim();
    const modelPath = modelValue.trim();
    if (!python || !modelPath) throw new Error("empty-runtime-pointer");
    await Promise.all([stat(python), stat(modelPath)]);
    return { python, modelPath };
  } catch {
    throw new Error("QWEN_NOT_INSTALLED: 请先运行 INSTALL_QWEN.cmd；模型只保存在本机，不会提交到 GitHub。");
  }
}

async function downloadCandidateWithHeaders(
  url: string,
  targetWithoutExtension: string,
  headers: Record<string, string>,
): Promise<string> {
  const safeUrl = assertSafePublicHttpsUrl(url);
  if (/\.m3u8$/i.test(safeUrl.pathname)) throw new Error("HLS_NOT_SUPPORTED");
  let target: string | null = null;
  try {
    const response = await fetchPublicHttpsWithRedirects(safeUrl, {
      headers,
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (/text\/html|application\/json/i.test(contentType)) {
      throw new Error(`UNEXPECTED_CONTENT_TYPE:${contentType}`);
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > MAX_LOCAL_MEDIA_BYTES) throw new Error("MEDIA_TOO_LARGE");
    target = `${targetWithoutExtension}${/audio/i.test(contentType) ? ".m4a" : ".mp4"}`;
    let streamedBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        streamedBytes += chunk.length;
        callback(streamedBytes > MAX_LOCAL_MEDIA_BYTES ? new Error("MEDIA_TOO_LARGE") : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(target));
    const downloaded = await stat(target);
    if (downloaded.size < 20_000) throw new Error("MEDIA_TOO_SMALL");
    return target;
  } catch (error) {
    if (target) await rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function downloadPublicMedia(resolved: PublicVideoResolution, outputDir: string): Promise<string> {
  const failures: string[] = [];
  for (const candidate of resolved.videoCandidates.slice(0, 4)) {
    try {
      return await downloadCandidateWithHeaders(candidate, path.join(outputDir, "source"), {
        "User-Agent": PUBLIC_SHARE_UA,
        Referer: resolved.canonicalUrl,
        Accept: "*/*",
      });
    } catch (error) {
      failures.push(`${mediaUrlForLog(candidate)} => ${safeErrorForLog(error)}`);
    }
  }
  throw new Error(`VIDEO_DOWNLOAD_FAILED: 公开抖音作品没有可下载媒体。${failures.length ? ` ${failures.slice(0, 4).join(" | ")}` : ""}`);
}

function stopChildProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.pid == null) return;
  if (process.platform !== "win32") {
    child.kill("SIGKILL");
    return;
  }
  const killer = spawn("C:\\Windows\\System32\\taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  killer.on("error", () => child.kill());
  killer.on("close", () => {
    if (child.exitCode === null) child.kill();
  });
}

async function runPython(
  python: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      cwd: CONFIG.projectRoot,
      windowsHide: true,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env)
            .filter(([name]) => !/(?:TOKEN|SECRET|PASSWORD|COOKIE|AUTHORIZATION)/i.test(name)),
        ),
        PYTHONUTF8: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", chunk => {
      stdout = (stdout + chunk).slice(-64_000);
    });
    child.stderr.setEncoding("utf8").on("data", chunk => {
      stderr = (stderr + chunk).slice(-64_000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stopChildProcessTree(child);
    }, timeoutMs);
    timer.unref();
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("LOCAL_TRANSCRIPTION_TIMEOUT"));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`QWEN_PROCESS_FAILED: 退出码 ${code}；${safeErrorForLog(stderr)}`));
    });
  });
}

function qwenTranscriptId(workId: string, language: "Chinese" | "auto"): string {
  return safeId(`${workId}-qwen3-asr-1-7b-${language.toLowerCase()}-${QWEN_ASR_CONTEXT_VERSION}`);
}

export async function transcribePublicLinkQwen(
  rawUrl: string,
  language: "Chinese" | "auto" = "Chinese",
): Promise<TranscriptRecord> {
  const resolved = await resolvePublicDouyinVideo(rawUrl);
  if (resolved.durationSeconds != null && resolved.durationSeconds > QWEN_MAX_DURATION_SECONDS) {
    throw new Error(`VIDEO_TOO_LONG: 最长允许 ${QWEN_MAX_DURATION_SECONDS} 秒。`);
  }
  const transcriptId = qwenTranscriptId(resolved.workId, language);
  const outputDir = path.join(CONFIG.transcriptDir, transcriptId);
  const recordFile = transcriptPath(transcriptId);
  await mkdir(outputDir, { recursive: true });
  try {
    const cached = JSON.parse(await readFile(recordFile, "utf8")) as TranscriptRecord;
    if (cached.segments?.length && cached.model === QWEN_ASR_MODEL_NAME && cached.method === "local-qwen3-asr") {
      log("qwen_transcript_cache_hit", { transcriptId, workId: resolved.workId, language });
      return { ...cached, cacheHit: true };
    }
  } catch {
    // A missing or incomplete cache is rebuilt.
  }

  const runtime = await readQwenRuntime();
  const script = path.join(CONFIG.projectRoot, "scripts", "transcribe_qwen.py");
  const recognitionContext = buildTranscriptInitialPrompt({ title: resolved.title, author: resolved.author });
  await writeFile(path.join(outputDir, "source-meta.json"), JSON.stringify({
    workId: resolved.workId,
    sourceUrl: resolved.canonicalUrl,
    title: resolved.title,
    author: resolved.author,
    model: QWEN_ASR_MODEL_NAME,
    method: "local-qwen3-asr",
    requestedLanguage: language,
    chunkSeconds: CONFIG.qwenTranscriptChunkSeconds,
    contextVersion: QWEN_ASR_CONTEXT_VERSION,
  }, null, 2), "utf8");

  return withTranscriptTemporaryDirectory(transcriptId, async temporaryDirectory => {
    const mediaFile = await downloadPublicMedia(resolved, temporaryDirectory);
    const { stdout, stderr } = await runPython(runtime.python, [
      script,
      "--input", mediaFile,
      "--output", recordFile,
      "--transcript-id", transcriptId,
      "--work-id", resolved.workId,
      "--source-url", resolved.canonicalUrl,
      "--title", resolved.title,
      "--author", resolved.author ?? "",
      "--model-path", runtime.modelPath,
      "--model-name", QWEN_ASR_MODEL_NAME,
      "--language", language,
      "--chunk-seconds", String(CONFIG.qwenTranscriptChunkSeconds),
      "--max-duration-seconds", String(QWEN_MAX_DURATION_SECONDS),
      "--context", recognitionContext,
      "--context-version", QWEN_ASR_CONTEXT_VERSION,
    ], QWEN_TRANSCRIPTION_TIMEOUT_MS);
    log("qwen_transcript_completed", {
      transcriptId,
      workId: resolved.workId,
      stdout: safeErrorForLog(stdout),
      stderr: safeErrorForLog(stderr),
    });
    const record = JSON.parse(await readFile(recordFile, "utf8")) as TranscriptRecord;
    if (!record.segments?.length) throw new Error("QWEN_EMPTY_TRANSCRIPT: 没有生成有效字幕片段。");
    return { ...record, cacheHit: false };
  });
}

function qwenJobId(rawUrl: string, language: "Chinese" | "auto"): string {
  return `qwen-${createHash("sha256").update(`${rawUrl.trim()}\n${language}`).digest("hex").slice(0, 20)}`;
}

function qwenJobSnapshot(job: QwenTranscriptionJob): QwenTranscriptionJob {
  return { ...job };
}

export function startQwenTranscriptionJob(
  rawUrl: string,
  language: "Chinese" | "auto" = "Chinese",
): QwenTranscriptionJob {
  assertPublicDouyinUrl(rawUrl);
  const jobId = qwenJobId(rawUrl, language);
  const existing = qwenTranscriptionJobs.get(jobId);
  if (existing && existing.status !== "failed") return qwenJobSnapshot(existing);
  const pendingCount = [...qwenTranscriptionJobs.values()]
    .filter(job => job.status === "queued" || job.status === "running")
    .length;
  if (pendingCount >= QWEN_MAX_PENDING_JOBS) {
    throw new Error("QWEN_TRANSCRIPTION_QUEUE_FULL: 当前已有两个准确转写任务，请稍后再试。");
  }
  const now = new Date().toISOString();
  const job: QwenTranscriptionJob = {
    jobId,
    status: "queued",
    sourceUrl: rawUrl.trim(),
    language,
    attempt: (existing?.attempt ?? 0) + 1,
    startedAt: now,
    updatedAt: now,
  };
  qwenTranscriptionJobs.set(jobId, job);
  log("qwen_transcript_job_started", { jobId, sourceUrl: mediaUrlForLog(job.sourceUrl), language });
  qwenTranscriptionQueue = qwenTranscriptionQueue.then(async () => {
    Object.assign(job, { status: "running" as const, updatedAt: new Date().toISOString() });
    try {
      const record = await transcribePublicLinkQwen(job.sourceUrl, language);
      const completedAt = new Date().toISOString();
      Object.assign(job, {
        status: "completed" as const,
        updatedAt: completedAt,
        completedAt,
        transcriptId: record.transcriptId,
        record,
        error: undefined,
      });
      log("qwen_transcript_job_completed", { jobId, transcriptId: record.transcriptId, cacheHit: record.cacheHit });
    } catch (error) {
      const completedAt = new Date().toISOString();
      const message = safeErrorForLog(error);
      Object.assign(job, {
        status: "failed" as const,
        updatedAt: completedAt,
        completedAt,
        error: message.slice(0, 4000),
      });
      log("qwen_transcript_job_failed", { jobId, error: message.slice(0, 2000) });
    }
  });
  return qwenJobSnapshot(job);
}

export function getQwenTranscriptionJob(jobId: string): QwenTranscriptionJob {
  const job = qwenTranscriptionJobs.get(jobId);
  if (!job) throw new Error(`QWEN_JOB_NOT_FOUND: 找不到任务 ${jobId}；服务重启后请重新提交链接。`);
  return qwenJobSnapshot(job);
}

export async function loadTranscript(transcriptId: string): Promise<TranscriptRecord> {
  const normalized = safeId(transcriptId);
  if (normalized !== transcriptId) throw new Error("INVALID_TRANSCRIPT_ID");
  const record = JSON.parse(await readFile(transcriptPath(transcriptId), "utf8")) as TranscriptRecord;
  if (!record.segments) throw new Error(`TRANSCRIPT_NOT_FOUND: 找不到字幕 ${transcriptId}。`);
  return record;
}

export async function listTranscripts(): Promise<Array<Pick<TranscriptRecord, "transcriptId" | "workId" | "title" | "createdAt" | "durationSeconds">>> {
  await mkdir(CONFIG.transcriptDir, { recursive: true });
  const entries = await readdir(CONFIG.transcriptDir, { withFileTypes: true });
  const output: Array<Pick<TranscriptRecord, "transcriptId" | "workId" | "title" | "createdAt" | "durationSeconds">> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".tmp") continue;
    try {
      const record = await loadTranscript(entry.name);
      output.push({
        transcriptId: record.transcriptId,
        workId: record.workId,
        title: record.title,
        createdAt: record.createdAt,
        durationSeconds: record.durationSeconds,
      });
    } catch {
      // Ignore incomplete or unrelated directories.
    }
  }
  return output.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
