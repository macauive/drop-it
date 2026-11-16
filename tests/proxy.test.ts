import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { proxyTrust } from "../server/proxy.js";
import { createApp } from "../server/app.js";
import { openDatabase, migrate } from "../server/db.js";

test("Cloudflare trust is bounded by hop and network, with legacy defaults preserved", () => {
  assert.equal(proxyTrust(), 0);
  assert.equal(proxyTrust(1), 1);
  assert.equal(proxyTrust(2), 2);
  for (const hops of [0, 2, 5]) assert.throws(() => proxyTrust(hops, true));
  const trust = proxyTrust(1, true);
  assert.equal(typeof trust, "function");
  if (typeof trust !== "function") throw new Error("Expected trust function");
  for (const address of [
    "104.16.0.1",
    "173.245.48.1",
    "2606:4700::1",
    "::ffff:104.16.0.1",
    "::ffff:6810:1",
  ]) {
    assert.equal(trust(address, 1), true, address);
    assert.equal(trust(address, 2), false, address);
  }
  for (const address of [
    "104.15.255.255",
    "198.51.100.77",
    "2001:db8::1",
    "unknown",
    "104.16.0.1:443",
    "",
    "104.16.0.1, 203.0.113.1",
  ])
    assert.equal(trust(address, 1), false, address);
  assert.equal(trust("127.0.0.1", 0), true);
});

test("Express stops at the authentic peer on shorter paths and ignores forged header aliases", async () => {
  const app = express();
  app.set("trust proxy", proxyTrust(1, true));
  app.get("/", (req, res) => res.json({ ip: req.ip }));
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const [xff, expected] of [
      [undefined, "127.0.0.1"],
      ["203.0.113.45, 198.51.100.77, 104.16.0.1", "198.51.100.77"],
      ["203.0.113.45, 198.51.100.77, 2606:4700::1", "198.51.100.77"],
      ["203.0.113.45, 198.51.100.77, ::ffff:104.16.0.1", "198.51.100.77"],
      ["203.0.113.45, 104.16.0.1, 198.51.100.77", "198.51.100.77"],
      ["203.0.113.45, 104.16.0.2, 104.16.0.1", "104.16.0.2"],
      ["203.0.113.45, 2001:db8::77, 2606:4700::1", "2001:db8::77"],
      ["203.0.113.45, unknown", "unknown"],
    ] as const) {
      const response = await fetch(origin, {
        headers: {
          ...(xff ? { "X-Forwarded-For": xff } : {}),
          "CF-Connecting-IP": "203.0.113.90",
          "X-Real-IP": "203.0.113.91",
        },
      });
      assert.equal((await response.json()).ip, expected);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Cloudflare edge rotation and forged prefixes share API, login and OAuth counters across apps", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "drop-it-proxy-"));
  const db = await openDatabase({ dataDir });
  await migrate(db);
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const config = {
    origin,
    port,
    local: true,
    production: false,
    dataDir,
    redirectUris: [],
    databaseUrl: undefined,
    ai: undefined,
    trustProxy: 1,
    trustCloudflareProxy: true,
  };
  const apps = [
    createApp(db, config, "<html></html>"),
    createApp(db, config, "<html></html>"),
  ];
  server.on("request", (req, res) =>
    apps[Number(req.headers["x-fixture-app"])].app(req, res),
  );
  try {
    for (const [path, count] of [
      ["/api/login", 10],
      ["/register", 20],
      ["/api/session", 120],
    ] as const) {
      const ms = Number(
        (
          await db.query<{ ms: string }>(
            "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms",
          )
        ).rows[0].ms,
      );
      const window =
        path === "/api/session"
          ? 60000
          : path === "/register"
            ? 3600000
            : 900000;
      if (window - (ms % window) < 3000)
        await new Promise((resolve) =>
          setTimeout(resolve, window - (ms % window) + 50),
        );
      await db.query("DELETE FROM rate_limit_counters");
      for (let i = 0; i <= count; i++) {
        const edge = [
          "104.16.0.1",
          "173.245.48.1",
          "2606:4700::1",
          "::ffff:104.16.0.1",
        ][i % 4];
        const xff =
          i % 5 === 0
            ? `203.0.113.${i}, 104.16.0.1, 198.51.100.77`
            : `203.0.113.${i}, 198.51.100.77, ${edge}`;
        const response = await fetch(origin + path, {
          method: path === "/api/session" ? "GET" : "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            "X-Fixture-App": String(i % 2),
            "X-Forwarded-For": xff,
            "CF-Connecting-IP": `203.0.113.${i}`,
            "X-Real-IP": `203.0.113.${i}`,
          },
          ...(path !== "/api/session" ? { body: "{}" } : {}),
        });
        assert.equal(
          response.status,
          i === count ? 429 : path === "/api/session" ? 200 : 400,
          `${path} request ${i}`,
        );
        if (path !== "/register")
          assert.match(
            response.headers.get("ratelimit")!,
            new RegExp(`remaining=${Math.max(0, count - i - 1)},`),
          );
        else
          assert.equal(
            response.headers.get("ratelimit-remaining"),
            String(Math.max(0, count - i - 1)),
          );
        await response.arrayBuffer();
      }
    }
  } finally {
    await Promise.all(apps.map((app) => app.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
