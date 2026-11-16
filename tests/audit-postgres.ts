// Disposable PostgreSQL16 with a private Unix socket; never loads environment
// files or uses a hosted connection string. All identities/data are synthetic.
import { postgresFixture } from "./postgres-fixture.js";
import { migrate } from "../server/db.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Auth } from "../server/auth.js";
import { cleanupExpired } from "../server/maintenance.js";
import { DatabaseRateLimitStore } from "../server/rate-limit-store.js";
import { checkSharedStore, checkSharedHttp } from "./rate-limit-fixture.js";

const fixture = await postgresFixture();
try {
  const db = await fixture.create("security");
  const peer = await fixture.connect("security");
  await migrate(db);
  await migrate(db);
  await checkSharedStore(db, peer);
  await checkSharedHttp(db, peer, 1);
  console.log(
    "PASS: PostgreSQL16 atomic counters, two-connection concurrency, migration rerun, two-app login/API/OAuth limits and trusted forwarding",
  );
  const owner = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,'synthetic-unusable-hash')",
    [owner],
  );
  for (const id of [
    "unused",
    "used",
    "token",
    "pending",
    "code",
    "malformed",
  ]) {
    await db.query(
      "INSERT INTO oauth_clients(id,data,last_used_at) VALUES($1,$2,now()-interval '91 days')",
      [
        id,
        JSON.stringify({
          client_id: id,
          client_id_issued_at:
            id === "malformed"
              ? "unknown"
              : Math.floor(Date.now() / 1000) - 91 * 86400,
        }),
      ],
    );
  }
  await db.query(
    "INSERT INTO oauth_tokens(hash,family,owner,client_id,kind,scopes,resource,expires_at) VALUES('synthetic-retention-token',$1,$2,'token','refresh',ARRAY['library:read'],'https://example.test/mcp',now()+interval '1 day')",
    [randomUUID(), owner],
  );
  await db.query(
    "INSERT INTO oauth_pending(id,client_id,params,expires_at) VALUES('synthetic-retention-pending','pending','{}',now()+interval '1 hour')",
  );
  await db.query(
    "INSERT INTO oauth_codes(hash,owner,client_id,params,expires_at) VALUES('synthetic-retention-code',$1,'code','{}',now()+interval '1 hour')",
    [owner],
  );
  const auth = new Auth(peer, {
    origin: "https://example.test",
    port: 443,
    local: false,
    production: false,
    dataDir: fixture.root,
    redirectUris: [],
    databaseUrl: undefined,
    ai: undefined,
  });
  assert.ok(await auth.clientsStore.getClient("used"));
  await db.query(
    "INSERT INTO rate_limit_counters VALUES('expired-retention-counter',now()-interval '2 days',1)",
  );
  await cleanupExpired(db);
  assert.deepEqual(
    (
      await db.query<{ id: string }>("SELECT id FROM oauth_clients ORDER BY id")
    ).rows.map((row) => row.id),
    ["code", "malformed", "pending", "token", "used"],
  );
  assert.equal(
    (
      await db.query(
        "SELECT key FROM rate_limit_counters WHERE key='expired-retention-counter'",
      )
    ).rows.length,
    0,
  );
  console.log(
    "PASS: PostgreSQL OAuth cleanup deletes only unused clients, preserves live references/last use/malformed timestamps, and expires old counters",
  );
  const store = new DatabaseRateLimitStore(db, "restart-fixture");
  store.init({ windowMs: 3600000 });
  assert.equal((await store.increment("synthetic-client")).totalHits, 1);
  await fixture.stop();
  await assert.rejects(store.increment("synthetic-client"), {
    status: 503,
    code: "RATE_LIMIT_UNAVAILABLE",
  });
  await fixture.start();
  assert.equal((await store.increment("synthetic-client")).totalHits, 2);
  console.log(
    "PASS: PostgreSQL shutdown fails closed and restart preserves rate counters",
  );
} finally {
  await fixture.close();
}
