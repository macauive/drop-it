import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp } from "../server/app.js";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { migrate, type Database } from "../server/db.js";
import { DatabaseRateLimitStore } from "../server/rate-limit-store.js";
import { checkSharedStore, checkSharedHttp } from "./rate-limit-fixture.js";

async function fixture() {
  const pg = new PGlite({ extensions: { vector, pg_trgm } });
  await pg.waitReady;
  const db: Database = {
    query: (sql, params) => pg.query(sql, params),
    transaction: (run) => pg.transaction(run),
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}

test("PGlite store shares atomic counts, isolates prefixes, resets/decrements, and rolls windows", async () => {
  const db = await fixture();
  try {
    await checkSharedStore(db);
    await migrate(db);
  } finally {
    await db.close();
  }
});

test("store outages fail closed with bounded, redacted logging and recover", async (t) => {
  const db = await fixture();
  let failed = true;
  const logs = t.mock.method(console, "error", () => {});
  const store = new DatabaseRateLimitStore(
    {
      query: (sql, params) => {
        if (failed) throw new Error("synthetic-provider-error-do-not-log");
        return db.query(sql, params);
      },
    },
    "outage",
  );
  store.init({ windowMs: 60000 });
  try {
    for (let i = 0; i < 3; i++)
      await assert.rejects(store.increment("private-client"), {
        status: 503,
        code: "RATE_LIMIT_UNAVAILABLE",
      });
    assert.equal(logs.mock.callCount(), 1);
    assert.equal(
      JSON.stringify(logs.mock.calls).includes("private-client"),
      false,
    );
    assert.equal(
      JSON.stringify(logs.mock.calls).includes("synthetic-provider-error"),
      false,
    );
    failed = false;
    assert.equal((await store.increment("private-client")).totalHits, 1);
  } finally {
    await db.close();
  }
});

test("HTTP store outage returns safe 503s before API/OAuth handlers, keeps health available and recovers", async (t) => {
  const db = await fixture();
  const server = createServer();
  let unavailable = true;
  const logs = t.mock.method(console, "error", () => {});
  const failing: Database = {
    ...db,
    query: (sql, params) => {
      if (unavailable && sql.includes("rate_limit_counters"))
        throw new Error("synthetic-provider-detail-do-not-expose");
      return db.query(sql, params);
    },
  };
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const built = createApp(
    failing,
    {
      origin,
      port,
      local: true,
      production: false,
      dataDir: "/tmp/unused-outage-fixture",
      redirectUris: [],
      databaseUrl: undefined,
      ai: undefined,
    },
    "<html></html>",
  );
  server.on("request", built.app);
  try {
    for (let i = 0; i < 3; i++) {
      for (const path of ["/api/session", "/register"]) {
        const response = await fetch(
          origin + path,
          path === "/register"
            ? {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              }
            : {},
        );
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, "RATE_LIMIT_UNAVAILABLE");
        assert.equal(response.headers.get("ratelimit"), null);
        assert.equal(response.headers.get("ratelimit-remaining"), null);
      }
    }
    assert.equal(
      logs.mock.callCount(),
      2,
      "one redacted log per failing limiter",
    );
    assert.equal(
      JSON.stringify(logs.mock.calls).includes("synthetic-provider-detail"),
      false,
    );
    for (const path of ["/health", "/ready"]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    assert.equal(
      (await db.query("SELECT id FROM oauth_clients")).rows.length,
      0,
    );
    unavailable = false;
    const response = await fetch(origin + "/api/session");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("ratelimit")!, /remaining=119,/);
    await response.arrayBuffer();
    const registration = await fetch(origin + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(registration.status, 400);
    assert.equal(registration.headers.get("ratelimit-remaining"), "19");
    await registration.arrayBuffer();
  } finally {
    await built.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});

test("two apps share login, API and OAuth registration budgets; untrusted XFF cannot split buckets", async () => {
  const db = await fixture();
  try {
    await checkSharedHttp(db);
  } finally {
    await db.close();
  }
});

test("trusted one-hop ingress consistently selects its rightmost verified address, ignoring forged earlier hops", async () => {
  const db = await fixture();
  try {
    await checkSharedHttp(db, db, 1);
  } finally {
    await db.close();
  }
});
