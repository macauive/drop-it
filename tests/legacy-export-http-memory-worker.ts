// Isolated server for the opt-in HTTP/RSS regression. Never load .env files.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import type { Config } from "../server/config.js";
import { openDatabase } from "../server/db.js";

const ceilingBytes = 384 * 1024 * 1024;
let sampledPeakBytes = process.memoryUsage().rss;
let samples = 0;
let stopping = false;
let close: (() => Promise<void>) | undefined;
const memory = () => {
  const rssBytes = process.memoryUsage().rss;
  sampledPeakBytes = Math.max(sampledPeakBytes, rssBytes);
  return {
    rssBytes,
    sampledPeakBytes,
    // Node reports maxRSS in KiB on both Darwin and Linux.
    maximumRssBytes: process.resourceUsage().maxRSS * 1024,
    samples,
  };
};
const sampler = setInterval(() => {
  samples++;
  const measured = memory();
  if (
    Math.max(measured.sampledPeakBytes, measured.maximumRssBytes) >=
    ceilingBytes
  ) {
    process.send?.({ type: "budget-exceeded", ...measured });
    process.exit(1);
  }
  if (samples % 10 === 0) process.send?.({ type: "memory", ...measured });
}, 20);

async function start(message: unknown) {
  assert.equal(process.versions.node.split(".")[0], "24");
  assert.ok(message && typeof message === "object");
  const input = message as Record<string, unknown>;
  assert.deepEqual(Object.keys(input).sort(), [
    "dataDir",
    "databaseUrl",
    "type",
  ]);
  assert.equal(input.type, "start");
  assert.equal(typeof input.databaseUrl, "string");
  assert.equal(typeof input.dataDir, "string");
  const databaseUrl = new URL(input.databaseUrl as string);
  assert.equal(databaseUrl.protocol, "postgresql:");
  assert.equal(databaseUrl.hostname, "localhost");
  assert.equal(databaseUrl.port, "55437");
  assert.equal(databaseUrl.username, "synthetic_auth_app");
  assert.equal(databaseUrl.password, "");
  assert.equal(databaseUrl.pathname, "/legacy_export_http_memory");
  assert.equal(
    databaseUrl.searchParams.get("host"),
    join(input.dataDir as string, "socket"),
  );
  const db = await openDatabase({
    dataDir: input.dataDir as string,
    databaseUrl: databaseUrl.href,
  });
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const config: Config = {
    port,
    origin: "https://legacy-export.synthetic.invalid",
    local: false,
    production: true,
    publicAccounts: true,
    signupEnabled: false,
    trustProxy: 1,
    redirectUris: [],
    dataDir: input.dataDir as string,
    databaseUrl: databaseUrl.href,
    ai: undefined,
  };
  let html: string;
  let builtHtml = true;
  try {
    html = await readFile(
      new URL("../dist/web/index.html", import.meta.url),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    builtHtml = false;
    html = "<!doctype html><title>Synthetic export regression</title>";
  }
  const built = createApp(db, config, html);
  server.on("request", built.app);
  close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await built.close();
    } finally {
      await db.close();
    }
  };
  process.send?.({ type: "ready", port, builtHtml, ...memory() });
}

process.once("message", (message) => {
  void start(message).catch(() => {
    process.send?.({ type: "failure", code: "WORKER_START_FAILED" });
    process.exit(1);
  });
});
process.on("message", (message) => {
  if (
    !message ||
    typeof message !== "object" ||
    !("type" in message) ||
    message.type !== "shutdown" ||
    stopping
  )
    return;
  stopping = true;
  void (async () => {
    try {
      await close?.();
      clearInterval(sampler);
      process.send?.({ type: "stopped", ...memory() }, () => process.exit(0));
    } catch {
      process.send?.({ type: "failure", code: "WORKER_CLEANUP_FAILED" });
      process.exit(1);
    }
  })();
});
