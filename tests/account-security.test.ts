import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../server/auth.js";
import { migrate, openDatabase, type Database } from "../server/db.js";
import type { Config } from "../server/config.js";
import { digest } from "../server/library.js";
import { securityInfoSchema } from "../shared/schema.js";

let dir: string, db: Database, auth: Auth, config: Config;
let owner: string, session: string, originalHash: string;
const password = randomBytes(24).toString("base64url");
const nextPassword = () => randomBytes(24).toString("base64url");
const code = (value: string) => ({ code: value });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "drop-it-account-security-"));
  db = await openDatabase({ dataDir: dir });
  await migrate(db);
  config = {
    origin: "http://localhost:4317",
    port: 4317,
    local: true,
    redirectUris: [],
    dataDir: dir,
    databaseUrl: undefined,
    production: false,
    ai: undefined,
  };
  auth = new Auth(db, config);
  session = await auth.setup(password);
  owner = (await auth.sessionOwner(session))!;
  originalHash = (
    await db.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id=$1",
      [owner],
    )
  ).rows[0].password_hash;
});

beforeEach(async () => {
  for (const table of [
    "oauth_tokens",
    "oauth_codes",
    "oauth_pending",
    "sessions",
  ])
    await db.query(`DELETE FROM ${table}`);
  await db.query("DELETE FROM users WHERE id<>$1", [owner]);
  await db.query(
    "UPDATE users SET password_hash=$1,auth_version=auth_version+1,recovery_hash=NULL,recovery_created_at=NULL WHERE id=$2",
    [originalHash, owner],
  );
  session = await auth.session(owner);
});

after(async () => {
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function otherOwner() {
  const id = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$2)",
    [id, originalHash],
  );
  return { owner: id, session: await auth.session(id) };
}

async function seedOAuth(forOwner = owner) {
  await db.query(
    "INSERT INTO oauth_codes(hash,owner,client_id,params,expires_at) VALUES($1,$2,$3,'{}',now()+interval '1 minute')",
    [digest(randomBytes(32).toString("base64url")), forOwner, randomUUID()],
  );
  await db.query(
    "INSERT INTO oauth_tokens(hash,family,owner,client_id,kind,scopes,resource,expires_at) VALUES($1,$2,$3,$4,'refresh',$5,$6,now()+interval '1 day')",
    [
      digest(randomBytes(32).toString("base64url")),
      randomUUID(),
      forOwner,
      randomUUID(),
      ["library:read"],
      `${config.origin}/mcp`,
    ],
  );
}

async function credentialCounts(forOwner = owner) {
  return Promise.all(
    ["sessions", "oauth_codes", "oauth_tokens"].map(
      async (table) =>
        (await db.query(`SELECT hash FROM ${table} WHERE owner=$1`, [forOwner]))
          .rows.length,
    ),
  );
}

function pausedTransaction() {
  let started!: () => void, resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let armed = true;
  const wrapped: Database = {
    query: db.query.bind(db),
    close: async () => {},
    transaction: async (run) => {
      if (armed) {
        armed = false;
        started();
        await gate;
      }
      return db.transaction(run);
    },
  };
  return { auth: new Auth(wrapped, config), entered, resume };
}

async function credentialState() {
  const users = await db.query<{
    id: string;
    password_hash: string;
    auth_version: number;
    recovery_hash: string | null;
    recovery_created_at: Date | null;
  }>(
    "SELECT id,password_hash,auth_version,recovery_hash,recovery_created_at FROM users ORDER BY id",
  );
  const sessions = await db.query("SELECT * FROM sessions ORDER BY hash");
  const codes = await db.query("SELECT * FROM oauth_codes ORDER BY hash");
  const tokens = await db.query("SELECT * FROM oauth_tokens ORDER BY hash");
  return {
    users: users.rows,
    sessions: sessions.rows,
    codes: codes.rows,
    tokens: tokens.rows,
  };
}

async function reopenDatabase() {
  await db.close();
  db = await openDatabase({ dataDir: dir });
  await migrate(db);
  auth = new Auth(db, config);
}

test("security metadata is owner-scoped and contains only public session IDs and coarse labels", async () => {
  const raw =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/99.0 private-device-sentinel";
  const browser = await auth.session(owner, raw);
  const foreign = await otherOwner();
  const result = securityInfoSchema.parse(await auth.security(owner, browser));
  assert.equal(result.recoveryEnabled, false);
  assert.equal(result.recoveryCreatedAt, null);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions[0].current, true);
  assert.equal(result.sessions[0].label, "Chrome on macOS");
  assert.equal(result.sessions.filter((entry) => entry.current).length, 1);
  const encoded = JSON.stringify(result);
  for (const forbidden of [
    browser,
    digest(browser),
    session,
    foreign.session,
    raw,
    "private-device-sentinel",
    "password_hash",
    "recovery_hash",
  ])
    assert.equal(encoded.includes(forbidden), false);
  await assert.rejects(
    auth.security(owner, foreign.session),
    code("UNAUTHENTICATED"),
  );
  const stored = await db.query<{ label: string }>(
    "SELECT label FROM sessions WHERE hash=$1",
    [digest(browser)],
  );
  assert.equal(stored.rows[0].label, "Chrome on macOS");
});

test("last-seen writes are throttled and new logins retain at most fifty active sessions", async () => {
  await db.query(
    "UPDATE sessions SET last_seen_at=now()-interval '10 minutes' WHERE hash=$1",
    [digest(session)],
  );
  await auth.sessionOwner(session);
  const first = (await auth.security(owner, session)).sessions[0].lastSeenAt;
  await auth.sessionOwner(session);
  assert.equal(
    (await auth.security(owner, session)).sessions[0].lastSeenAt,
    first,
  );
  await db.query(
    "UPDATE sessions SET last_seen_at=now()-interval '1 day' WHERE hash=$1",
    [digest(session)],
  );
  for (let i = 0; i < 49; i++) await auth.session(owner);
  const newest = await auth.login(password, "Firefox/99 Linux");
  assert.equal(await auth.sessionOwner(session), undefined);
  const result = await auth.security(owner, newest);
  assert.equal(result.sessions.length, 50);
  assert.equal(result.sessions[0].label, "Firefox on Linux");
  assert.equal((await credentialCounts())[0], 50);
});

test("selective revocation reauthenticates, cannot cross owners and can sign out the current session", async () => {
  const extra = await auth.session(owner);
  const foreign = await otherOwner();
  const foreignId = (await auth.security(foreign.owner, foreign.session))
    .sessions[0].id;
  const extraId = (await auth.security(owner, extra)).sessions[0].id;
  await assert.rejects(
    auth.revokeSession(owner, session, nextPassword(), extraId),
    code("LOGIN_FAILED"),
  );
  await assert.rejects(
    auth.revokeSession(owner, session, password, foreignId),
    code("NOT_FOUND"),
  );
  await assert.rejects(
    auth.revokeSession(owner, foreign.session, password, extraId),
    code("UNAUTHENTICATED"),
  );
  assert.deepEqual(
    await auth.revokeSession(owner, session, password, extraId),
    { signedOut: false },
  );
  assert.equal(await auth.sessionOwner(extra), undefined);
  assert.equal(await auth.sessionOwner(foreign.session), foreign.owner);
  const currentId = (await auth.security(owner, session)).sessions[0].id;
  assert.deepEqual(
    await auth.revokeSession(owner, session, password, currentId),
    { signedOut: true },
  );
  assert.equal(await auth.sessionOwner(session), undefined);
});

test("password change revokes browser, OAuth and recovery credentials only for its owner", async () => {
  const recovery = await auth.createRecoveryCode(owner, session, password);
  await auth.session(owner);
  await seedOAuth();
  const foreign = await otherOwner();
  await seedOAuth(foreign.owner);
  await assert.rejects(
    auth.changePassword(owner, session, nextPassword(), nextPassword()),
    code("LOGIN_FAILED"),
  );
  assert.deepEqual(await credentialCounts(), [2, 1, 1]);
  const replacement = nextPassword();
  await auth.changePassword(owner, session, password, replacement);
  assert.deepEqual(await credentialCounts(), [0, 0, 0]);
  assert.deepEqual(await credentialCounts(foreign.owner), [1, 1, 1]);
  await assert.rejects(auth.login(password), code("LOGIN_FAILED"));
  await assert.rejects(
    auth.recover(recovery.recoveryCode, nextPassword()),
    code("RECOVERY_FAILED"),
  );
  const fresh = await auth.login(replacement);
  assert.equal((await auth.security(owner, fresh)).recoveryEnabled, false);
});

test("recovery code is stored only as a hash, replacement invalidates old codes and consumption is one time", async () => {
  const first = await auth.createRecoveryCode(owner, session, password);
  const second = await auth.createRecoveryCode(owner, session, password);
  assert.match(second.recoveryCode, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.recoveryCode, second.recoveryCode);
  const stored = (
    await db.query<{ recovery_hash: string }>(
      "SELECT recovery_hash FROM users WHERE id=$1",
      [owner],
    )
  ).rows[0].recovery_hash;
  assert.equal(stored, digest(second.recoveryCode));
  assert.notEqual(stored, second.recoveryCode);
  assert.equal((await auth.security(owner, session)).recoveryEnabled, true);
  await assert.rejects(
    auth.recover(first.recoveryCode, nextPassword()),
    code("RECOVERY_FAILED"),
  );
  await seedOAuth();
  const replacement = nextPassword();
  await auth.recover(` ${second.recoveryCode}\n`, replacement);
  assert.deepEqual(await credentialCounts(), [0, 0, 0]);
  await assert.rejects(
    auth.recover(second.recoveryCode, nextPassword()),
    code("RECOVERY_FAILED"),
  );
  await assert.rejects(auth.login(password), code("LOGIN_FAILED"));
  const fresh = await auth.login(replacement);
  assert.equal((await auth.security(owner, fresh)).recoveryEnabled, false);
});

test("sign out everywhere invalidates all access while preserving offline recovery", async () => {
  const recovery = await auth.createRecoveryCode(owner, session, password);
  await auth.session(owner);
  await seedOAuth();
  await auth.logoutEverywhere(owner, session, password);
  assert.deepEqual(await credentialCounts(), [0, 0, 0]);
  const fresh = await auth.login(password);
  assert.equal((await auth.security(owner, fresh)).recoveryEnabled, true);
  await auth.recover(recovery.recoveryCode, nextPassword());
  assert.equal(await auth.sessionOwner(fresh), undefined);
});

test("concurrent recovery consumption succeeds exactly once", async () => {
  const { recoveryCode } = await auth.createRecoveryCode(
    owner,
    session,
    password,
  );
  const first = nextPassword(),
    second = nextPassword();
  const outcomes = await Promise.allSettled([
    auth.recover(recoveryCode, first),
    auth.recover(recoveryCode, second),
  ]);
  assert.equal(
    outcomes.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter((entry) => entry.status === "rejected").length,
    1,
  );
  assert.deepEqual(await credentialCounts(), [0, 0, 0]);
  const winner = outcomes[0].status === "fulfilled" ? first : second;
  assert.equal(await auth.sessionOwner(await auth.login(winner)), owner);
});

test("a stale login cannot issue a session after password change or global signout", async () => {
  for (const operation of ["password", "logout"] as const) {
    const paused = pausedTransaction();
    const login = paused.auth.login(password);
    const rejected = assert.rejects(login, code("LOGIN_FAILED"));
    await paused.entered;
    if (operation === "password")
      await auth.changePassword(owner, session, password, nextPassword());
    else await auth.logoutEverywhere(owner, session, password);
    paused.resume();
    await rejected;
    assert.deepEqual(await credentialCounts(), [0, 0, 0]);
    await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
      originalHash,
      owner,
    ]);
    session = await auth.session(owner);
  }
});

test("security mutations recheck live sessions after password verification", async () => {
  const paused = pausedTransaction();
  const creation = paused.auth.createRecoveryCode(owner, session, password);
  const rejected = assert.rejects(creation, code("UNAUTHENTICATED"));
  await paused.entered;
  await auth.logout(session);
  paused.resume();
  await rejected;
  const row = (
    await db.query<{ recovery_hash: string | null }>(
      "SELECT recovery_hash FROM users WHERE id=$1",
      [owner],
    )
  ).rows[0];
  assert.equal(row.recovery_hash, null);
});

test("replacement wins over an in-flight old recovery code", async () => {
  const old = await auth.createRecoveryCode(owner, session, password);
  const paused = pausedTransaction();
  const recovery = paused.auth.recover(old.recoveryCode, nextPassword());
  const rejected = assert.rejects(recovery, code("RECOVERY_FAILED"));
  await paused.entered;
  const fresh = await auth.createRecoveryCode(owner, session, password);
  paused.resume();
  await rejected;
  await auth.recover(fresh.recoveryCode, nextPassword());
});

test("new password validation and expired-session checks apply inside Auth", async () => {
  await assert.rejects(
    auth.changePassword(owner, session, password, "x".repeat(14)),
  );
  const recovery = await auth.createRecoveryCode(owner, session, password);
  await assert.rejects(auth.recover(recovery.recoveryCode, "x".repeat(129)));
  await db.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE hash=$1",
    [digest(session)],
  );
  await assert.rejects(auth.security(owner, session), code("UNAUTHENTICATED"));
  await assert.rejects(
    auth.createRecoveryCode(owner, session, password),
    code("UNAUTHENTICATED"),
  );
  await assert.rejects(
    auth.changePassword(owner, session, password, nextPassword()),
    code("UNAUTHENTICATED"),
  );
  await assert.rejects(
    auth.logoutEverywhere(owner, session, password),
    code("UNAUTHENTICATED"),
  );
});

test("migration seven preserves legacy sessions and is idempotent", async () => {
  const legacyDir = await mkdtemp(join(tmpdir(), "drop-it-legacy-account-"));
  const legacyDb = await openDatabase({ dataDir: legacyDir });
  try {
    await legacyDb.query(
      "CREATE TABLE schema_migrations(version integer PRIMARY KEY)",
    );
    await legacyDb.query(
      "INSERT INTO schema_migrations VALUES(1),(2),(3),(4),(5),(6)",
    );
    await legacyDb.query(
      "CREATE TABLE users(id uuid PRIMARY KEY,singleton boolean UNIQUE DEFAULT true,password_hash text NOT NULL)",
    );
    await legacyDb.query(
      "CREATE TABLE sessions(hash text PRIMARY KEY,owner uuid NOT NULL REFERENCES users(id),expires_at timestamptz NOT NULL)",
    );
    await legacyDb.query("INSERT INTO users(id,password_hash) VALUES($1,$2)", [
      owner,
      originalHash,
    ]);
    const legacyToken = randomBytes(32).toString("base64url");
    await legacyDb.query(
      "INSERT INTO sessions(hash,owner,expires_at) VALUES($1,$2,now()+interval '6 days')",
      [digest(legacyToken), owner],
    );
    await migrate(legacyDb);
    const legacyAuth = new Auth(legacyDb, { ...config, dataDir: legacyDir });
    assert.equal(await legacyAuth.sessionOwner(legacyToken), owner);
    const snapshot = await legacyAuth.security(owner, legacyToken);
    assert.equal(snapshot.sessions[0].label, "Existing browser session");
    assert.equal(snapshot.sessions[0].current, true);
    assert.notEqual(snapshot.sessions[0].id, legacyToken);
    assert.equal(snapshot.recoveryEnabled, false);
    await migrate(legacyDb);
    assert.deepEqual(await legacyAuth.security(owner, legacyToken), snapshot);
  } finally {
    await legacyDb.close();
    await rm(legacyDir, { recursive: true, force: true });
  }
});

test("credential state survives database reopening and consumed recovery stays revoked after another reopen", async () => {
  const { recoveryCode } = await auth.createRecoveryCode(
    owner,
    session,
    password,
  );
  const extra = await auth.session(owner, "Firefox/99 Linux");
  const foreign = await otherOwner();
  await seedOAuth();
  await seedOAuth(foreign.owner);
  const metadata = await auth.security(owner, session);
  const initial = await credentialState();
  const initialUser = initial.users.find((entry) => entry.id === owner)!;
  assert.equal(initialUser.recovery_hash, digest(recoveryCode));
  assert.equal(JSON.stringify(initial).includes(recoveryCode), false);

  await reopenDatabase();
  assert.deepEqual(await credentialState(), initial);
  assert.deepEqual(await auth.security(owner, session), metadata);
  assert.equal(await auth.sessionOwner(session), owner);
  assert.equal(await auth.sessionOwner(extra), owner);
  assert.equal(await auth.sessionOwner(foreign.session), foreign.owner);

  const replacement = nextPassword();
  await auth.recover(recoveryCode, replacement);
  const consumed = await credentialState();
  const consumedUser = consumed.users.find((entry) => entry.id === owner)!;
  assert.notEqual(consumedUser.password_hash, initialUser.password_hash);
  assert.equal(consumedUser.auth_version, initialUser.auth_version + 1);
  assert.equal(consumedUser.recovery_hash, null);
  assert.equal(consumedUser.recovery_created_at, null);
  assert.deepEqual(await credentialCounts(), [0, 0, 0]);
  assert.deepEqual(await credentialCounts(foreign.owner), [1, 1, 1]);

  await reopenDatabase();
  assert.deepEqual(await credentialState(), consumed);
  assert.equal(await auth.sessionOwner(session), undefined);
  assert.equal(await auth.sessionOwner(extra), undefined);
  assert.equal(await auth.sessionOwner(foreign.session), foreign.owner);
  await assert.rejects(
    auth.recover(recoveryCode, nextPassword()),
    code("RECOVERY_FAILED"),
  );
  await assert.rejects(auth.login(password), code("LOGIN_FAILED"));
  const fresh = await auth.login(replacement);
  assert.equal(await auth.sessionOwner(fresh), owner);
  assert.equal((await auth.security(owner, fresh)).recoveryEnabled, false);
});

test("password change, recovery and global signout roll back every credential when final invalidation fails", async () => {
  const { recoveryCode } = await auth.createRecoveryCode(
    owner,
    session,
    password,
  );
  await auth.session(owner);
  const foreign = await otherOwner();
  await seedOAuth();
  await seedOAuth(foreign.owner);
  const initial = await credentialState();

  for (const operation of ["password", "recovery", "logout"] as const) {
    const failure = new Error("Synthetic credential invalidation failure");
    let injected = 0;
    const wrapped: Database = {
      query: db.query.bind(db),
      close: async () => {},
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            query: async <T>(sql: string, params?: unknown[]) => {
              const result = await tx.query<T>(sql, params);
              // Fail after the password/session/OAuth changes and the final user
              // version/recovery update have all executed within the transaction.
              if (
                sql.startsWith("UPDATE users SET auth_version=auth_version+1")
              ) {
                injected++;
                throw failure;
              }
              return result;
            },
          }),
        ),
    };
    const failing = new Auth(wrapped, config);
    const mutation =
      operation === "password"
        ? failing.changePassword(owner, session, password, nextPassword())
        : operation === "recovery"
          ? failing.recover(recoveryCode, nextPassword())
          : failing.logoutEverywhere(owner, session, password);
    await assert.rejects(mutation, (error: unknown) => error === failure);
    assert.equal(injected, 1, operation);
    assert.deepEqual(await credentialState(), initial, operation);
  }

  // Actual credentials remain usable after rollback, including the same
  // recovery code that the failed recovery transaction tried to consume.
  assert.equal(await auth.sessionOwner(session), owner);
  assert.equal(await auth.sessionOwner(await auth.login(password)), owner);
  const replacement = nextPassword();
  await auth.recover(recoveryCode, replacement);
  assert.deepEqual(await credentialCounts(), [0, 0, 0]);
  assert.equal(await auth.sessionOwner(await auth.login(replacement)), owner);
  assert.equal(await auth.sessionOwner(foreign.session), foreign.owner);
});
