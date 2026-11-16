import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { migrate, type Database } from "../server/db.js";
import { cleanupExpired } from "../server/maintenance.js";
import { Auth } from "../server/auth.js";

test("maintenance removes old counters and only unused, unreferenced OAuth clients", async () => {
  const pg = new PGlite({ extensions: { vector, pg_trgm } });
  await pg.waitReady;
  const db: Database = {
    query: (sql, params) => pg.query(sql, params),
    transaction: (run) => pg.transaction(run),
    close: () => pg.close(),
  };
  await migrate(db);
  try {
    const owner = randomUUID();
    await db.query(
      "INSERT INTO users(id,password_hash) VALUES($1,'synthetic-unusable-hash')",
      [owner],
    );
    const stale = Math.floor(Date.now() / 1000) - 91 * 86400;
    for (const id of [
      "stale",
      "token",
      "pending",
      "code",
      "used",
      "recent",
      "unknown",
    ]) {
      await db.query(
        "INSERT INTO oauth_clients(id,data,last_used_at) VALUES($1,$2,now()-interval '91 days')",
        [
          id,
          JSON.stringify({
            client_id: id,
            ...(id === "unknown"
              ? {}
              : {
                  client_id_issued_at:
                    id === "recent" ? Math.floor(Date.now() / 1000) : stale,
                }),
          }),
        ],
      );
    }
    await db.query(
      "INSERT INTO oauth_tokens(hash,family,owner,client_id,kind,scopes,resource,expires_at) VALUES('synthetic-token',$1,$2,'token','refresh',ARRAY['library:read'],'https://example.test/mcp',now()+interval '1 day')",
      [randomUUID(), owner],
    );
    await db.query(
      "INSERT INTO oauth_pending(id,client_id,params,expires_at) VALUES('synthetic-pending','pending','{}',now()+interval '1 hour')",
    );
    await db.query(
      "INSERT INTO oauth_codes(hash,owner,client_id,params,expires_at) VALUES('synthetic-code',$1,'code','{}',now()+interval '1 hour')",
      [owner],
    );
    const auth = new Auth(db, {
      origin: "https://example.test",
      port: 443,
      local: false,
      production: false,
      dataDir: "/tmp/unused",
      redirectUris: [],
      databaseUrl: undefined,
      ai: undefined,
    });
    assert.ok(await auth.clientsStore.getClient("used"));
    await db.query(
      "INSERT INTO rate_limit_counters VALUES('old',now()-interval '2 days',1),('fresh',now(),1)",
    );
    await cleanupExpired(db);
    assert.deepEqual(
      (
        await db.query<{ id: string }>(
          "SELECT id FROM oauth_clients ORDER BY id",
        )
      ).rows.map((row) => row.id),
      ["code", "pending", "recent", "token", "unknown", "used"],
    );
    assert.deepEqual(
      (
        await db.query<{ key: string }>("SELECT key FROM rate_limit_counters")
      ).rows.map((row) => row.key),
      ["fresh"],
    );
    assert.equal(
      (await db.query("SELECT hash FROM oauth_tokens")).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});
