// Opt-in real PostgreSQL verification. No .env files or existing databases are
// read. Requires the already-installed Homebrew PostgreSQL 16 binaries.
// Run: node --import tsx tests/postgres-security.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Response } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Auth } from "../server/auth.js";
import type { Config } from "../server/config.js";
import { migrate, openDatabase, type Database } from "../server/db.js";
import { digest, Library } from "../server/library.js";
import { cleanupExpired } from "../server/maintenance.js";
import { AppError } from "../server/errors.js";

const runFile = promisify(execFile);
const binary = (name: string) => `/opt/homebrew/bin/${name}`;
const root = await mkdtemp("/private/tmp/drop-it-pg-security-");
await chmod(root, 0o700);
const cluster = join(root, "cluster"),
  socket = join(root, "socket");
await mkdir(socket, { mode: 0o700 });
let db: Database | undefined, admin: Database | undefined;
let shutdownPromise: Promise<void> | undefined;
let checks = 0;

async function shutdown() {
  shutdownPromise ??= (async () => {
    try {
      await db?.close();
      await admin?.close();
    } finally {
      if (existsSync(join(cluster, "postmaster.pid")))
        await runFile(
          binary("pg_ctl"),
          ["-D", cluster, "stop", "-m", "fast", "-w", "-t", "20"],
          { timeout: 25000 },
        );
      // Do not delete the cluster if stopping its process failed.
      await rm(root, { recursive: true, force: true });
    }
  })();
  return shutdownPromise;
}

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)
  process.once(signal, () => {
    void shutdown().then(
      () => process.exit(exitCode),
      () => {
        console.error("PostgreSQL cleanup failed; isolated cluster retained.");
        process.exit(1);
      },
    );
  });

async function check(name: string, run: () => Promise<void>) {
  await run();
  checks++;
  console.log(`PASS ${checks}: ${name}`);
}
const isCode = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const input = (title: string) => ({
  requestId: randomUUID(),
  title,
  source: { originalText: title },
});
const connectionString = (user: string, database: string) => {
  const url = new URL(`postgresql://${user}@localhost:55432/${database}`);
  url.searchParams.set("host", socket);
  return url.href;
};

// Hold exactly one credential operation after its password/code snapshot and
// expensive hashing, allowing a second pooled connection to revoke it first.
function pauseTransaction(database: Database, config: Config, inside = false) {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const delayed: Database = {
    ...database,
    transaction: async (run) => {
      if (!first) return database.transaction(run);
      first = false;
      if (inside)
        return database.transaction(async (tx) => {
          entered();
          await gate;
          return run(tx);
        });
      entered();
      await gate;
      return database.transaction(run);
    },
  };
  return { auth: new Auth(delayed, config), reached, release };
}

try {
  const version = (
    await runFile(binary("postgres"), ["--version"])
  ).stdout.trim();
  const installedVersion = /^postgres \(PostgreSQL\) (\S+)/.exec(version)?.[1];
  assert.ok(installedVersion);
  console.log(version);
  await runFile(
    binary("initdb"),
    [
      "-D",
      cluster,
      "--username=drop_it_security_admin",
      "--auth-local=trust",
      "--auth-host=reject",
      "--no-locale",
      "--encoding=UTF8",
    ],
    { timeout: 30000 },
  );
  // The socket directory is private and TCP listeners are explicitly disabled.
  // All option values below are constants or a generated, shell-safe temp path.
  await runFile(
    binary("pg_ctl"),
    [
      "-D",
      cluster,
      "start",
      "-l",
      join(root, "postgres.log"),
      "-w",
      "-t",
      "20",
      "-o",
      `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p 55432 -c max_connections=12 -c shared_buffers=16MB -c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=10000 -c log_statement=none -c log_min_error_statement=panic -c log_error_verbosity=terse`,
    ],
    { timeout: 25000 },
  );
  admin = await openDatabase({
    dataDir: root,
    databaseUrl: connectionString("drop_it_security_admin", "postgres"),
  });
  await admin.query(
    "CREATE ROLE drop_it_security_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE",
  );
  await admin.query(
    "CREATE DATABASE drop_it_security OWNER drop_it_security_app",
  );
  const runtime = await admin.query<{ tcp: string; sockets: string }>(
    "SELECT current_setting('listen_addresses') AS tcp,current_setting('unix_socket_directories') AS sockets",
  );
  await admin.close();
  admin = undefined;
  const databaseUrl = connectionString(
    "drop_it_security_app",
    "drop_it_security",
  );
  db = await openDatabase({ dataDir: root, databaseUrl });
  const database = db;
  const library = new Library(database);
  const owner = randomUUID(),
    other = randomUUID();
  const origin = "http://localhost:4317",
    resource = new URL(`${origin}/mcp`);
  const config: Config = {
    port: 4317,
    origin,
    local: true,
    redirectUris: [`${origin}/callback`],
    dataDir: root,
    databaseUrl,
    production: false,
    ai: undefined,
  };
  const auth = new Auth(database, config);
  let client: OAuthClientInformationFull;

  await check(
    "Unix socket only, unprivileged application role, repeated migrations",
    async () => {
      const settings = await database.query<{
        address: string | null;
        role: string;
        superuser: boolean;
        version: string;
      }>(
        "SELECT inet_server_addr()::text AS address,current_user AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,version() AS version",
      );
      assert.equal(runtime.rows[0].tcp, "");
      assert.equal(runtime.rows[0].sockets, socket);
      assert.equal(settings.rows[0].address, null);
      assert.equal(settings.rows[0].role, "drop_it_security_app");
      assert.equal(settings.rows[0].superuser, false);
      assert.ok(
        settings.rows[0].version.startsWith(`PostgreSQL ${installedVersion} `),
      );
      await migrate(database);
      await migrate(database);
      await database.query(
        "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$3),($2,NULL,$3)",
        [owner, other, randomBytes(32).toString("hex")],
      );
      client = await auth.clientsStore.registerClient({
        redirect_uris: config.redirectUris,
        token_endpoint_auth_method: "none",
        client_name: "Synthetic PostgreSQL security test",
      });
    },
  );

  async function approvedCode(grantOwner: string = owner) {
    const verifier = randomBytes(32).toString("base64url");
    let location = "";
    await auth.authorize(
      client,
      {
        redirectUri: client.redirect_uris[0],
        codeChallenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        scopes: ["library:read", "library:write"],
        resource,
      },
      {
        redirect: (url: string) => {
          location = url;
        },
      } as Response,
    );
    const pending = new URL(location).searchParams.get("authorize")!;
    const approved = await auth.consent(grantOwner, pending, true);
    return {
      code: new URL(approved.redirect).searchParams.get("code")!,
      verifier,
    };
  }
  async function tokens(grantOwner: string = owner) {
    const { code, verifier } = await approvedCode(grantOwner);
    return auth.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
      resource,
    );
  }

  await check(
    "owner-scoped reads and composite foreign keys prevent cross-owner links",
    async () => {
      const file = await library.upload(
        owner,
        Buffer.from("Synthetic private source"),
        "text/plain",
        "private.txt",
      );
      const saved = await library.save(owner, {
        ...input("FK isolation"),
        source: { attachmentId: file.attachmentId },
      });
      const foreignKey = (error: unknown) =>
        (error as { code?: string }).code === "23503";
      await assert.rejects(
        database.query(
          "INSERT INTO sources(id,owner,original_text,url,attachment_id,fingerprint) VALUES($1,$2,'','',$3,'fixture')",
          [randomUUID(), other, file.attachmentId],
        ),
        foreignKey,
      );
      await assert.rejects(
        database.query(
          "INSERT INTO items(id,owner,source_id,title,summary,category,tags,notes) VALUES($1,$2,$3,'wrong','','Uncategorized','{}','')",
          [randomUUID(), other, saved.source.id],
        ),
        foreignKey,
      );
      await assert.rejects(
        database.query(
          "INSERT INTO item_embeddings(owner,item_id,model,fingerprint,vector) VALUES($1,$2,'fixture','fixture',ARRAY[1.0])",
          [other, saved.item.id],
        ),
        foreignKey,
      );
      await assert.rejects(
        library.get(other, saved.item.id),
        isCode("NOT_FOUND"),
      );
      await assert.rejects(
        library.file(other, saved.source.id),
        isCode("NOT_FOUND"),
      );
      assert.equal((await library.search(other, {})).total, 0);
      assert.equal((await library.export(other)).items.length, 0);
    },
  );

  await check(
    "ten concurrent retries create exactly one item and source",
    async () => {
      const request = input("Concurrent request retries");
      const results = await Promise.all(
        Array.from({ length: 10 }, () => library.save(owner, request)),
      );
      assert.equal(new Set(results.map((result) => result.item.id)).size, 1);
      assert.equal(results.filter((result) => !result.replayed).length, 1);
      assert.equal(
        (await library.search(owner, { query: request.title, mode: "keyword" }))
          .total,
        1,
      );
      await assert.rejects(
        library.save(owner, { ...request, title: "Different payload" }),
        isCode("REQUEST_REUSED"),
      );
    },
  );

  await check(
    "eight racing duplicate requests have one successful save",
    async () => {
      const request = input("Concurrent duplicate source");
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          library.save(owner, { ...request, requestId: randomUUID() }),
        ),
      );
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      for (const result of results)
        if (result.status === "rejected")
          assert.ok(isCode("DUPLICATE")(result.reason));
    },
  );

  await check(
    "eight racing edits and an edit/delete race enforce revisions",
    async () => {
      const saved = await library.save(
        owner,
        input("Concurrent revision checks"),
      );
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          library.update(owner, {
            id: saved.item.id,
            revision: 1,
            notes: `Synthetic edit ${index}`,
          }),
        ),
      );
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      for (const result of results)
        if (result.status === "rejected")
          assert.ok(isCode("CONFLICT")(result.reason));
      const race = await Promise.allSettled([
        library.update(owner, {
          id: saved.item.id,
          revision: 2,
          notes: "Final edit",
        }),
        library.delete(owner, { id: saved.item.id, revision: 2 }),
      ]);
      assert.equal(
        race.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal((await library.get(owner, saved.item.id)).item.revision, 3);
    },
  );

  await check(
    "a failed transaction rolls back data and releases the pool client",
    async () => {
      const id = randomUUID();
      await assert.rejects(
        database.transaction(async (tx) => {
          await tx.query(
            "INSERT INTO sources(id,owner,original_text,url,fingerprint) VALUES($1,$2,'','','rollback')",
            [id, owner],
          );
          throw new Error("Synthetic transaction failure");
        }),
        /Synthetic transaction failure/,
      );
      assert.equal(
        (await database.query("SELECT id FROM sources WHERE id=$1", [id])).rows
          .length,
        0,
      );
      assert.equal(
        (await database.query<{ ok: number }>("SELECT 1 AS ok")).rows[0].ok,
        1,
      );
    },
  );

  await check(
    "approved-code exchange cannot outlive concurrent disconnect (12 races)",
    async () => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const { code, verifier } = await approvedCode();
        const exchange = auth.exchangeAuthorizationCode(
          client,
          code,
          verifier,
          client.redirect_uris[0],
          resource,
        );
        const [result, revoked] = await Promise.allSettled([
          exchange,
          auth.revokeAll(owner),
        ]);
        assert.equal(revoked.status, "fulfilled");
        if (result.status === "fulfilled")
          await assert.rejects(
            auth.verifyAccessToken(result.value.access_token),
          );
        assert.equal(
          (
            await database.query(
              "SELECT hash FROM oauth_codes WHERE owner=$1",
              [owner],
            )
          ).rows.length,
          0,
        );
        assert.equal(
          (
            await database.query(
              "SELECT hash FROM oauth_tokens WHERE owner=$1",
              [owner],
            )
          ).rows.length,
          0,
        );
      }
    },
  );

  await check(
    "concurrent refresh replay revokes every successor (12 races)",
    async () => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const first = await tokens();
        const results = await Promise.allSettled([
          auth.exchangeRefreshToken(
            client,
            first.refresh_token,
            undefined,
            resource,
          ),
          auth.exchangeRefreshToken(
            client,
            first.refresh_token,
            undefined,
            resource,
          ),
        ]);
        assert.equal(
          results.filter((result) => result.status === "fulfilled").length,
          1,
        );
        assert.equal(
          results.filter((result) => result.status === "rejected").length,
          1,
        );
        for (const result of results)
          if (result.status === "fulfilled") {
            await assert.rejects(
              auth.verifyAccessToken(result.value.access_token),
            );
            await assert.rejects(
              auth.exchangeRefreshToken(
                client,
                result.value.refresh_token,
                undefined,
                resource,
              ),
            );
          }
        assert.equal(
          (
            await database.query(
              "SELECT hash FROM oauth_tokens WHERE owner=$1",
              [owner],
            )
          ).rows.length,
          0,
        );
      }
    },
  );

  await check(
    "JSON export preserves bytea originals and remains coherent during writes",
    async () => {
      const bytes = Buffer.from(
        "Synthetic export original\nwith Unicode: café",
      );
      const file = await library.upload(
        owner,
        bytes,
        "text/plain",
        "export.txt",
      );
      const saved = await library.save(owner, {
        ...input("Export source"),
        source: { attachmentId: file.attachmentId },
      });
      const [exported] = await Promise.all([
        library.export(owner),
        library.update(owner, {
          id: saved.item.id,
          revision: 1,
          notes: "Concurrent update",
        }),
        library.save(owner, input("Concurrent export save")),
      ]);
      const sourceIds = new Set(exported.sources.map((source) => source.id));
      assert.ok(exported.items.every((item) => sourceIds.has(item.sourceId)));
      assert.equal(
        exported.sources.find((source) => source.id === saved.source.id)
          ?.fileBase64,
        bytes.toString("base64"),
      );
      assert.deepEqual(
        (await library.file(owner, saved.source.id)).bytes,
        bytes,
      );
      assert.equal(JSON.parse(JSON.stringify(exported)).version, 2);
    },
  );

  await check(
    "expiry cleanup preserves shared files, prevents replay, then collects the last reference",
    async () => {
      const bytes = Buffer.from("Synthetic shared original");
      const file = await library.upload(
        owner,
        bytes,
        "text/plain",
        "shared.txt",
      );
      const request = {
        ...input("Expiry first reference"),
        source: { attachmentId: file.attachmentId },
      };
      const first = await library.save(owner, request);
      const second = await library.save(owner, {
        requestId: randomUUID(),
        title: "Expiry second reference",
        sourceId: first.source.id,
      });
      await library.delete(owner, { id: first.item.id, revision: 1 });
      await database.query(
        "UPDATE items SET trashed_at=now()-interval '8 days' WHERE owner=$1 AND id=$2",
        [owner, first.item.id],
      );
      await cleanupExpired(database);
      await assert.rejects(library.save(owner, request), isCode("DELETED"));
      assert.deepEqual(
        (await library.file(owner, first.source.id)).bytes,
        bytes,
      );
      await library.delete(owner, { id: second.item.id, revision: 1 });
      await database.query(
        "UPDATE items SET trashed_at=now()-interval '8 days' WHERE owner=$1 AND id=$2",
        [owner, second.item.id],
      );
      await cleanupExpired(database);
      await cleanupExpired(database);
      await assert.rejects(
        library.file(owner, first.source.id),
        isCode("NOT_FOUND"),
      );
      assert.equal(
        (
          await database.query(
            "SELECT id FROM attachments WHERE owner=$1 AND id=$2",
            [owner, file.attachmentId],
          )
        ).rows.length,
        0,
      );
      assert.equal(
        (await library.export(owner)).sources.some(
          (source) => source.id === first.source.id,
        ),
        false,
      );
    },
  );

  await check(
    "migration 7 preserves real legacy sessions, owner records and library data",
    async () => {
      const legacySession = await auth.session(owner);
      const before = await library.export(owner);
      await database.query("DROP INDEX sessions_owner_seen");
      await database.query(
        "ALTER TABLE sessions DROP COLUMN id, DROP COLUMN label, DROP COLUMN created_at, DROP COLUMN last_seen_at",
      );
      await database.query(
        "ALTER TABLE users DROP CONSTRAINT users_recovery_state, DROP COLUMN auth_version, DROP COLUMN recovery_hash, DROP COLUMN recovery_created_at",
      );
      await database.query("DELETE FROM schema_migrations WHERE version=7");
      await migrate(database);
      await migrate(database);
      assert.equal(await auth.sessionOwner(legacySession), owner);
      const metadata = await auth.security(owner, legacySession);
      assert.equal(metadata.sessions[0].current, true);
      assert.equal(metadata.sessions[0].label, "Existing browser session");
      assert.equal(metadata.recoveryEnabled, false);
      const after = await library.export(owner);
      assert.deepEqual(after.items, before.items);
      assert.deepEqual(after.sources, before.sources);
    },
  );

  let accountPassword = randomBytes(24).toString("base64url");
  let accountSession = await auth.setup(accountPassword);
  const accountOwner = (await auth.sessionOwner(accountSession))!;
  const accountDrop = await library.save(
    accountOwner,
    input("Account mutation preserved source"),
  );

  await check(
    "password change rejects a login validated before the password changed",
    async () => {
      const delayed = pauseTransaction(database, config);
      const pendingLogin = delayed.auth.login(accountPassword);
      await delayed.reached;
      const nextPassword = randomBytes(24).toString("base64url");
      try {
        await auth.changePassword(
          accountOwner,
          accountSession,
          accountPassword,
          nextPassword,
        );
      } finally {
        delayed.release();
      }
      await assert.rejects(pendingLogin, isCode("LOGIN_FAILED"));
      assert.equal(await auth.sessionOwner(accountSession), undefined);
      accountPassword = nextPassword;
      accountSession = await auth.login(accountPassword);
      assert.equal(
        (await library.get(accountOwner, accountDrop.item.id)).source
          .originalText,
        accountDrop.source.originalText,
      );
    },
  );

  await check(
    "sign out everywhere rejects stale login and queued security mutations",
    async () => {
      const delayedLogin = pauseTransaction(database, config);
      const delayedMutation = pauseTransaction(database, config);
      const login = delayedLogin.auth.login(accountPassword);
      const mutation = delayedMutation.auth.createRecoveryCode(
        accountOwner,
        accountSession,
        accountPassword,
      );
      const settled = Promise.allSettled([login, mutation]);
      await Promise.all([delayedLogin.reached, delayedMutation.reached]);
      try {
        await auth.logoutEverywhere(
          accountOwner,
          accountSession,
          accountPassword,
        );
      } finally {
        delayedLogin.release();
        delayedMutation.release();
      }
      const results = await settled;
      assert.equal(results[0].status, "rejected");
      assert.equal(results[1].status, "rejected");
      if (results[0].status === "rejected")
        assert.ok(isCode("LOGIN_FAILED")(results[0].reason));
      if (results[1].status === "rejected")
        assert.ok(isCode("UNAUTHENTICATED")(results[1].reason));
      assert.equal(
        (
          await database.query("SELECT id FROM sessions WHERE owner=$1", [
            accountOwner,
          ])
        ).rows.length,
        0,
      );
      accountSession = await auth.login(accountPassword);
      assert.equal(
        (await auth.security(accountOwner, accountSession)).recoveryEnabled,
        false,
      );
    },
  );

  await check(
    "concurrent recovery consumption has one winner and revokes all existing credentials",
    async () => {
      const issued = await tokens(accountOwner);
      const { recoveryCode } = await auth.createRecoveryCode(
        accountOwner,
        accountSession,
        accountPassword,
      );
      const nextPasswords = [
        randomBytes(24).toString("base64url"),
        randomBytes(24).toString("base64url"),
      ];
      const results = await Promise.allSettled(
        nextPasswords.map((next) => auth.recover(recoveryCode, next)),
      );
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
      );
      for (const result of results)
        if (result.status === "rejected")
          assert.ok(isCode("RECOVERY_FAILED")(result.reason));
      assert.equal(await auth.sessionOwner(accountSession), undefined);
      await assert.rejects(auth.verifyAccessToken(issued.access_token));
      await assert.rejects(
        auth.recover(recoveryCode, randomBytes(24).toString("base64url")),
        isCode("RECOVERY_FAILED"),
      );
      accountPassword =
        nextPasswords[
          results.findIndex((result) => result.status === "fulfilled")
        ];
      accountSession = await auth.login(accountPassword);
      assert.equal(
        (await auth.security(accountOwner, accountSession)).recoveryEnabled,
        false,
      );
    },
  );

  await check(
    "replacing a recovery code defeats a reset already validated with the older code",
    async () => {
      const old = await auth.createRecoveryCode(
        accountOwner,
        accountSession,
        accountPassword,
      );
      const delayed = pauseTransaction(database, config);
      const stale = delayed.auth.recover(
        old.recoveryCode,
        randomBytes(24).toString("base64url"),
      );
      await delayed.reached;
      let replacement: { recoveryCode: string };
      try {
        replacement = await auth.createRecoveryCode(
          accountOwner,
          accountSession,
          accountPassword,
        );
      } finally {
        delayed.release();
      }
      await assert.rejects(stale, isCode("RECOVERY_FAILED"));
      assert.equal(await auth.sessionOwner(accountSession), accountOwner);
      const nextPassword = randomBytes(24).toString("base64url");
      await auth.recover(replacement.recoveryCode, nextPassword);
      accountPassword = nextPassword;
      accountSession = await auth.login(accountPassword);
    },
  );

  await check(
    "revoking the current session blocks a queued credential mutation after reauthentication",
    async () => {
      const delayed = pauseTransaction(database, config);
      const stale = delayed.auth.createRecoveryCode(
        accountOwner,
        accountSession,
        accountPassword,
      );
      await delayed.reached;
      try {
        await auth.logout(accountSession);
      } finally {
        delayed.release();
      }
      await assert.rejects(stale, isCode("UNAUTHENTICATED"));
      accountSession = await auth.login(accountPassword);
      assert.equal(
        (await auth.security(accountOwner, accountSession)).recoveryEnabled,
        false,
      );
    },
  );

  await check(
    "session expiry is rechecked against wall time after a transaction has begun",
    async () => {
      const delayed = pauseTransaction(database, config, true);
      const stale = delayed.auth.createRecoveryCode(
        accountOwner,
        accountSession,
        accountPassword,
      );
      await delayed.reached;
      try {
        await database.query(
          "UPDATE sessions SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE owner=$1",
          [accountOwner],
        );
        await database.query("SELECT pg_sleep(0.15)");
      } finally {
        delayed.release();
      }
      await assert.rejects(stale, isCode("UNAUTHENTICATED"));
      accountSession = await auth.login(accountPassword);
      assert.equal(
        (await auth.security(accountOwner, accountSession)).recoveryEnabled,
        false,
      );
      assert.equal(
        (await library.get(accountOwner, accountDrop.item.id)).item.title,
        accountDrop.item.title,
      );
    },
  );

  async function credentialSnapshot() {
    const user = await database.query(
      "SELECT id,password_hash,auth_version,recovery_hash,recovery_created_at FROM users WHERE id=$1",
      [accountOwner],
    );
    const sessions = await database.query(
      "SELECT * FROM sessions WHERE owner=$1 ORDER BY hash",
      [accountOwner],
    );
    const codes = await database.query(
      "SELECT * FROM oauth_codes WHERE owner=$1 ORDER BY hash",
      [accountOwner],
    );
    const credentials = await database.query(
      "SELECT * FROM oauth_tokens WHERE owner=$1 ORDER BY hash",
      [accountOwner],
    );
    const exported = await library.export(accountOwner);
    return {
      user: user.rows,
      sessions: sessions.rows,
      codes: codes.rows,
      tokens: credentials.rows,
      items: exported.items,
      sources: exported.sources,
    };
  }
  async function prepareCredentialRollback() {
    const browser = await auth.session(accountOwner);
    const issued = await tokens(accountOwner);
    await approvedCode(accountOwner);
    const { recoveryCode } = await auth.createRecoveryCode(
      accountOwner,
      accountSession,
      accountPassword,
    );
    return {
      browser,
      issued,
      recoveryCode,
      snapshot: await credentialSnapshot(),
    };
  }
  const injectedFailure = (error: unknown) =>
    (error as { code?: string }).code === "P0001" &&
    (error as Error).message === "Injected credential transaction failure";
  await database.query(`CREATE FUNCTION drop_it_test_credential_fault() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('drop_it_security.inject_failure',true)='on' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='Injected credential transaction failure';
      END IF;
      RETURN NEW;
    END $$`);
  await database.query(`CREATE TRIGGER drop_it_test_credential_fault
    BEFORE UPDATE OF auth_version ON users FOR EACH ROW
    EXECUTE FUNCTION drop_it_test_credential_fault()`);
  const faultyDatabase: Database = {
    ...database,
    transaction: (run) =>
      database.transaction(async (tx) => {
        // A transaction-local setting confines the injected database error to this
        // synthetic client; ordinary requests and cleanup remain unaffected.
        await tx.query("SET LOCAL drop_it_security.inject_failure='on'");
        return run(tx);
      }),
  };
  const faultyAuth = new Auth(faultyDatabase, config);
  try {
    await check(
      "password-change database failure atomically restores password, recovery and revoked credentials",
      async () => {
        const prepared = await prepareCredentialRollback();
        const nextPassword = randomBytes(24).toString("base64url");
        await assert.rejects(
          faultyAuth.changePassword(
            accountOwner,
            accountSession,
            accountPassword,
            nextPassword,
          ),
          injectedFailure,
        );
        assert.deepEqual(await credentialSnapshot(), prepared.snapshot);
        assert.equal(await auth.sessionOwner(prepared.browser), accountOwner);
        assert.equal(
          (await auth.verifyAccessToken(prepared.issued.access_token)).extra
            .owner,
          accountOwner,
        );
        await assert.rejects(auth.login(nextPassword), isCode("LOGIN_FAILED"));
        const verified = await auth.login(accountPassword);
        await auth.logout(verified);
        await auth.changePassword(
          accountOwner,
          accountSession,
          accountPassword,
          nextPassword,
        );
        assert.equal(await auth.sessionOwner(prepared.browser), undefined);
        await assert.rejects(
          auth.verifyAccessToken(prepared.issued.access_token),
        );
        await assert.rejects(
          auth.recover(prepared.recoveryCode, accountPassword),
          isCode("RECOVERY_FAILED"),
        );
        accountPassword = nextPassword;
        accountSession = await auth.login(accountPassword);
      },
    );

    await check(
      "recovery database failure restores its one-time code and every original credential",
      async () => {
        const prepared = await prepareCredentialRollback();
        const nextPassword = randomBytes(24).toString("base64url");
        await assert.rejects(
          faultyAuth.recover(prepared.recoveryCode, nextPassword),
          injectedFailure,
        );
        assert.deepEqual(await credentialSnapshot(), prepared.snapshot);
        assert.equal(await auth.sessionOwner(prepared.browser), accountOwner);
        assert.equal(
          (await auth.verifyAccessToken(prepared.issued.access_token)).extra
            .owner,
          accountOwner,
        );
        await assert.rejects(auth.login(nextPassword), isCode("LOGIN_FAILED"));
        await auth.recover(prepared.recoveryCode, nextPassword);
        assert.equal(await auth.sessionOwner(prepared.browser), undefined);
        await assert.rejects(
          auth.verifyAccessToken(prepared.issued.access_token),
        );
        await assert.rejects(
          auth.recover(prepared.recoveryCode, accountPassword),
          isCode("RECOVERY_FAILED"),
        );
        accountPassword = nextPassword;
        accountSession = await auth.login(accountPassword);
      },
    );

    await check(
      "sign-out-everywhere database failure rolls back all session and OAuth deletions",
      async () => {
        const prepared = await prepareCredentialRollback();
        await assert.rejects(
          faultyAuth.logoutEverywhere(
            accountOwner,
            accountSession,
            accountPassword,
          ),
          injectedFailure,
        );
        assert.deepEqual(await credentialSnapshot(), prepared.snapshot);
        assert.equal(await auth.sessionOwner(prepared.browser), accountOwner);
        assert.equal(
          (await auth.verifyAccessToken(prepared.issued.access_token)).extra
            .owner,
          accountOwner,
        );
        await auth.logoutEverywhere(
          accountOwner,
          accountSession,
          accountPassword,
        );
        assert.equal(await auth.sessionOwner(prepared.browser), undefined);
        await assert.rejects(
          auth.verifyAccessToken(prepared.issued.access_token),
        );
        accountSession = await auth.login(accountPassword);
        assert.equal(
          (await auth.security(accountOwner, accountSession)).recoveryEnabled,
          true,
        );
      },
    );
  } finally {
    await database.query("DROP TRIGGER drop_it_test_credential_fault ON users");
    await database.query("DROP FUNCTION drop_it_test_credential_fault()");
  }

  async function revokeCookieWhileOwnerLocked(
    run: (blockedAuth: Auth) => Promise<unknown>,
  ) {
    assert.equal(await auth.sessionOwner(accountSession), accountOwner);
    let lockAttempt!: () => void;
    const waiting = new Promise<void>((resolve) => {
      lockAttempt = resolve;
    });
    const observed: Database = {
      ...database,
      transaction: (action) =>
        database.transaction((tx) =>
          action({
            query: (sql, params) => {
              if (sql.includes("FROM users") && sql.includes("FOR UPDATE"))
                lockAttempt();
              return tx.query(sql, params);
            },
          }),
        ),
    };
    let pending!: Promise<PromiseSettledResult<unknown>[]>;
    await database.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        accountOwner,
      ]);
      pending = Promise.allSettled([run(new Auth(observed, config))]);
      await Promise.race([
        waiting,
        pending.then(() => {
          throw new Error(
            "OAuth operation completed before requesting the owner lock.",
          );
        }),
      ]);
      // The OAuth operation is waiting for this real PostgreSQL row lock. Its
      // middleware-authenticated cookie disappears before it can acquire it.
      await tx.query("DELETE FROM sessions WHERE owner=$1 AND hash=$2", [
        accountOwner,
        digest(accountSession),
      ]);
    });
    const [result] = await pending;
    assert.equal(result.status, "rejected");
    if (result.status === "rejected")
      assert.ok(isCode("UNAUTHENTICATED")(result.reason));
  }

  await check(
    "OAuth consent rechecks a browser cookie revoked while waiting on the owner lock",
    async () => {
      let location = "";
      await auth.authorize(
        client,
        {
          redirectUri: client.redirect_uris[0],
          codeChallenge: createHash("sha256")
            .update(randomBytes(32))
            .digest("base64url"),
          scopes: ["library:read"],
          resource,
        },
        {
          redirect: (url: string) => {
            location = url;
          },
        } as Response,
      );
      const pending = new URL(location).searchParams.get("authorize")!;
      const before = (await credentialSnapshot()).codes;
      await revokeCookieWhileOwnerLocked((blocked) =>
        blocked.consent(accountOwner, pending, true, accountSession),
      );
      assert.deepEqual((await credentialSnapshot()).codes, before);
      assert.equal(
        (
          await database.query("SELECT id FROM oauth_pending WHERE id=$1", [
            pending,
          ])
        ).rows.length,
        1,
      );
      accountSession = await auth.login(accountPassword);
      const approved = await auth.consent(
        accountOwner,
        pending,
        true,
        accountSession,
      );
      assert.ok(new URL(approved.redirect).searchParams.get("code"));
    },
  );

  await check(
    "OAuth disconnect rechecks a browser cookie revoked while waiting on the owner lock",
    async () => {
      const issued = await tokens(accountOwner);
      await approvedCode(accountOwner);
      const before = await credentialSnapshot();
      await revokeCookieWhileOwnerLocked((blocked) =>
        blocked.revokeAll(accountOwner, accountSession),
      );
      const after = await credentialSnapshot();
      assert.deepEqual(after.codes, before.codes);
      assert.deepEqual(after.tokens, before.tokens);
      assert.equal(
        (await auth.verifyAccessToken(issued.access_token)).extra.owner,
        accountOwner,
      );
      accountSession = await auth.login(accountPassword);
      await auth.revokeAll(accountOwner, accountSession);
      await assert.rejects(auth.verifyAccessToken(issued.access_token));
      assert.equal((await credentialSnapshot()).codes.length, 0);
      assert.equal(await auth.sessionOwner(accountSession), accountOwner);
      assert.equal(
        (await library.get(accountOwner, accountDrop.item.id)).source
          .originalText,
        accountDrop.source.originalText,
      );
    },
  );
  await check("public account registration, recovery and deletion isolate real PostgreSQL owners", async () => {
    const publicAuth = new Auth(db!, {...config, publicAccounts: true, signupEnabled: true});
    const passwordA=randomBytes(24).toString("base64url");
    const a=await publicAuth.register("pg_public_a",passwordA);
    const b=await publicAuth.register("pg_public_b",randomBytes(24).toString("base64url"));
    const ownerA=(await publicAuth.sessionOwner(a))!, ownerB=(await publicAuth.sessionOwner(b))!;
    const dropA=await library.save(ownerA,input("Public account A"));
    const dropB=await library.save(ownerB,input("Public account B"));
    await assert.rejects(library.get(ownerB,dropA.item.id));
    const recovery=await publicAuth.createRecoveryCode(ownerA,a,passwordA);
    const next=randomBytes(24).toString("base64url");
    await publicAuth.recover(recovery.recoveryCode,next);
    assert.equal(await publicAuth.sessionOwner(a),undefined);
    assert.equal(await publicAuth.sessionOwner(b),ownerB);
    const renewed=await publicAuth.login(next,undefined,"pg_public_a");
    await db!.query("CREATE TABLE delete_account_blocker(owner uuid REFERENCES users(id))");
    await db!.query("INSERT INTO delete_account_blocker VALUES($1)",[ownerA]);
    await assert.rejects(publicAuth.deleteAccount(ownerA,renewed,next));
    assert.equal((await library.get(ownerA,dropA.item.id)).item.title,"Public account A");
    assert.equal(await publicAuth.sessionOwner(renewed),ownerA);
    await db!.query("DROP TABLE delete_account_blocker");
    await publicAuth.deleteAccount(ownerA,renewed,next);
    assert.equal(await publicAuth.sessionOwner(renewed),undefined);
    assert.equal((await library.get(ownerB,dropB.item.id)).item.title,"Public account B");
  });
} finally {
  await shutdown();
}
console.log(
  `PostgreSQL security checks: ${checks}/23 passed; temporary cluster stopped and removed.`,
);
