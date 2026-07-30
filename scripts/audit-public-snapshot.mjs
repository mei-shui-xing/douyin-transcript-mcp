import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1))), "..");
const raw = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: root,
  encoding: "utf8",
});
const files = raw.split("\0").filter(Boolean).map(value => value.replaceAll("\\", "/"));
const forbiddenTrees = /^(?:runtime|logs|tools|node_modules|dist|backups|release)\//i;
const forbiddenFile = /(?:^|\/).+\.(?:bak|zip|exe|sqlite3(?:-shm|-wal)?)$/i;
const findings = [];

for (const file of files) {
  if (forbiddenTrees.test(file) || forbiddenFile.test(file)) findings.push(`${file}: forbidden release path`);
  if (!/^(?:src|scripts)\/|\.cmd$/i.test(file) || file === "scripts/audit-public-snapshot.mjs") continue;
  const text = readFileSync(path.join(root, file), "utf8");
  const checks = [
    [/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/i, "private key block"],
    [/sk-[A-Za-z0-9_-]{24,}/, "OpenAI-style secret"],
    [/tunnel_[a-z0-9]{32}/, "configured tunnel identity"],
    [/C:\\Users\\/i, "personal Windows path"],
    [/\b130\.94\.65\.201\b/, "known private deployment address"],
    [/(?:sslip\.io|trycloudflare\.com|TRANSCRIPT_RELAY_SSH|reverse-ssh|ssh\.exe)/i, "forbidden VPS or temporary-tunnel path"],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) findings.push(`${file}: ${label}`);
  }
}

if (findings.length) {
  console.error("Public snapshot audit failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log(`Public snapshot audit passed (${files.length} candidate files).`);
