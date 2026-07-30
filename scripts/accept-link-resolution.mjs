import process from "node:process";
import { resolvePublicDouyinVideo } from "../dist/transcript.js";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/accept-link-resolution.mjs <public-douyin-url>");
  process.exit(2);
}

const result = await resolvePublicDouyinVideo(input);
console.log(JSON.stringify({
  ok: true,
  workIdIsNumeric: /^\d{8,20}$/.test(result.workId),
  titleCharacters: result.title.length,
  durationSeconds: result.durationSeconds,
  mediaCandidateCount: result.videoCandidates.length,
  usedVps: false,
}));
