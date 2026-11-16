import { createServer } from "node:http";
import { once } from "node:events";
import { createApp } from "../server/app.js";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseRateLimitStore } from "../server/rate-limit-store.js";
import type { Database } from "../server/db.js";

// Runs unchanged against PGlite and two real PostgreSQL connections.
export async function checkSharedStore(db: Database, peer = db) {
  const a = new DatabaseRateLimitStore(db, "fixture"),
    b = new DatabaseRateLimitStore(peer, "fixture"),
    other = new DatabaseRateLimitStore(peer, "other");
  for (const store of [a, b, other]) store.init({ windowMs: 3600000 });
  const first = await a.increment("synthetic-client");
  const second = await b.increment("synthetic-client");
  assert.equal(first.totalHits, 1);
  assert.equal(second.totalHits, 2);
  assert.equal(+first.resetTime!, +second.resetTime!);
  assert.equal((await other.increment("synthetic-client")).totalHits, 1);
  await a.decrement("synthetic-client");
  assert.equal((await b.increment("synthetic-client")).totalHits, 2);
  await b.resetKey("synthetic-client");
  assert.equal((await a.increment("synthetic-client")).totalHits, 1);
  await b.decrement("synthetic-client");
  await b.decrement("synthetic-client");
  assert.equal((await a.increment("synthetic-client")).totalHits, 1);
  const hits = await Promise.all(
    Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).increment("parallel")),
  );
  assert.deepEqual(
    hits.map((hit) => hit.totalHits).sort((x, y) => x - y),
    Array.from({ length: 40 }, (_, i) => i + 1),
  );
  const short = new DatabaseRateLimitStore(db, "short");
  short.init({ windowMs: 200 });
  const before = await short.increment("synthetic-client");
  await delay(Math.max(0, +before.resetTime! - Date.now()) + 30);
  const after = await short.increment("synthetic-client");
  assert.equal(after.totalHits, 1);
  assert.ok(+after.resetTime! > +before.resetTime!);
}

export async function checkSharedHttp(db: Database, peer = db, trustProxy = 0) {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const config = {
    origin: `http://127.0.0.1:${port}`,
    port,
    local: true,
    production: false,
    dataDir: "/tmp/drop-it-unused-rate-fixture",
    redirectUris: [],
    trustProxy,
    databaseUrl: undefined,
    ai: undefined,
  };
  const apps = [
    createApp(db, config, "<html></html>"),
    createApp(peer, config, "<html></html>"),
  ];
  server.on("request", (req, res) =>
    apps[Number(req.headers["x-fixture-app"])].app(req, res),
  );
  try {
    const request = (i: number, path: string, post = false) =>
      fetch(config.origin + path, {
        method: post ? "POST" : "GET",
        headers: {
          "X-Fixture-App": String(i % 2),
          Origin: config.origin,
          "Content-Type": "application/json",
          "X-Forwarded-For": trustProxy
            ? `198.51.100.${i + 1}, 203.0.113.77`
            : `198.51.100.${i + 1}`,
        },
        ...(post ? { body: "{}" } : {}),
      });
    for (const [path, count, post, policy] of [
      ["/api/login", 10, true, "10;w=900"],
      ["/api/session", 120, false, "120;w=60"],
      ["/register", 20, true, "20;w=3600"],
    ] as const) {
      // Avoid straddling a real DB-clock fixed-window boundary in CI.
      const windowMs =
        path === "/api/session"
          ? 60000
          : path === "/register"
            ? 3600000
            : 900000;
      const clock = await db.query<{ ms: string }>(
        "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms",
      );
      const remaining = windowMs - (Number(clock.rows[0].ms) % windowMs);
      if (remaining < 3000) await delay(remaining + 50);
      await db.query("DELETE FROM rate_limit_counters");
      for (let i = 0; i < count; i++) {
        const response = await request(i, path, post);
        assert.equal(response.status, path === "/api/session" ? 200 : 400);
        if (path !== "/register") {
          assert.equal(response.headers.get("ratelimit-policy"), policy);
          assert.match(
            response.headers.get("ratelimit")!,
            new RegExp(`remaining=${count - i - 1},`),
          );
        } else
          assert.equal(
            response.headers.get("ratelimit-remaining"),
            String(count - i - 1),
          );
        await response.arrayBuffer();
      }
      for (const i of [0, 1]) {
        const response = await request(i, path, post);
        assert.equal(response.status, 429, path);
        await response.arrayBuffer();
      }
    }
  } finally {
    await Promise.all(apps.map((built) => built.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
