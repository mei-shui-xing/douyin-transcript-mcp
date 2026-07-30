import { startHttpServer, startStdioServer } from "./server.js";

const useStdio = process.argv.includes("--stdio");
const useHttp = process.argv.includes("--http") || !useStdio;

if (useStdio && useHttp && process.argv.includes("--http")) {
  throw new Error("Choose exactly one transport: --stdio or --http.");
}

if (useStdio) await startStdioServer();
else await startHttpServer();
