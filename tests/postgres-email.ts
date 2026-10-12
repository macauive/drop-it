// Disposable real PostgreSQL concurrency/restart checks; no .env or SMTP.
import assert from "node:assert/strict";
import { execFile, fork, spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { migrate, type Database } from "../server/db.js";
import { Auth } from "../server/auth.js";
import { EmailAuth } from "../server/email-auth.js";
import type { Config } from "../server/config.js";
import { postgresFixture } from "./postgres-fixture.js";
import { Library, digest } from "../server/library.js";
import { readFile } from "node:fs/promises";
import { AppError } from "../server/errors.js";
const run = promisify(execFile),
  fixture = await postgresFixture();
const root = fixture.root,
  binary = fixture.binary;
const pass = () => randomBytes(24).toString("base64url");
const config: Config = {
  port: 4317,
  origin: "http://127.0.0.1:4317",
  local: true,
  production: false,
  dataDir: root,
  ai: undefined,
  databaseUrl: undefined,
  redirectUris: [],
  publicAccounts: true,
  signupEnabled: true,
  emailAuth: {
    secret: pass(),
    from: "sender@example.test",
    username: pass(),
    password: pass(),
  },
};
let db: Database | undefined, peer: Database | undefined;
const start = fixture.start,
  stop = fixture.stop;
try {
  db = await fixture.create("auth");
  peer = await fixture.connect("auth");
  await migrate(db);
  const a = new Auth(db, config),
    b = new Auth(peer, config);
  const mailA: string[] = [],
    mailB: string[] = [];
  const ea = new EmailAuth(db, a, config, async (_email, code) => {
      mailA.push(code);
    }),
    eb = new EmailAuth(peer, b, config, async (_email, code) => {
      mailB.push(code);
    });
  const password = pass(),
    c = await ea.request("signup", "concurrent@example.test", password),
    code = mailA.at(-1)!;
  const signup = await Promise.allSettled([
    ea.verify("signup", { requestId: c.requestId, code }, password),
    eb.verify("signup", { requestId: c.requestId, code }, password),
  ]);
  assert.equal(signup.filter((x) => x.status === "fulfilled").length, 1);
  console.log("PASS: concurrent signup verification grants once across pools");
  const legacyPass = pass(),
    legacy = await a.register("legacy_pg", legacyPass),
    owner = (await a.sessionOwner(legacy))!;
  const collision = await ea.request(
      "signup",
      "collision@example.test",
      password,
    ),
    signupCode = mailA.at(-1)!;
  await db.query(
    "UPDATE email_request_limits SET last_at=now()-interval '2 minutes'",
  );
  const linking = await eb.request(
      "link",
      "collision@example.test",
      legacyPass,
      owner,
      legacy,
    ),
    linkCode = mailB.at(-1)!;
  const claims = await Promise.allSettled([
    ea.verify(
      "signup",
      { requestId: collision.requestId, code: signupCode },
      password,
    ),
    eb.verify(
      "link",
      { requestId: linking.requestId, code: linkCode },
      legacyPass,
      owner,
      legacy,
    ),
  ]);
  assert.equal(claims.filter((x) => x.status === "fulfilled").length, 1);
  const loser = claims.find(
    (x) => x.status === "rejected",
  ) as PromiseRejectedResult;
  assert.ok(loser.reason instanceof AppError);
  assert.equal(loser.reason.code, "EMAIL_CODE_INVALID");
  assert.equal(
    (
      await db.query(
        "SELECT id FROM users WHERE email='collision@example.test'",
      )
    ).rows.length,
    1,
  );
  assert.equal(await a.sessionOwner(legacy), owner);
  console.log(
    "PASS: competing signup/link claims return a generic rejection without merging owners",
  );
  const session = await a.login(password, undefined, "concurrent@example.test"),
    account = (await a.sessionOwner(session))!;
  await db.query(
    "UPDATE email_request_limits SET last_at=now()-interval '2 minutes'",
  );
  const reset = await ea.request("reset", "concurrent@example.test"),
    resetCode = mailA.at(-1)!;
  const resets = await Promise.allSettled([
    ea.verify("reset", { requestId: reset.requestId, code: resetCode }, pass()),
    eb.verify("reset", { requestId: reset.requestId, code: resetCode }, pass()),
  ]);
  assert.equal(resets.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(await a.sessionOwner(session), undefined);
  assert.equal(
    (await db.query("SELECT id FROM users WHERE id=$1", [account])).rows.length,
    1,
  );
  console.log("PASS: concurrent reset grants once and revokes old credentials");
  const restartPass = pass(),
    pending = await ea.request("signup", "restart@example.test", restartPass),
    restartCode = mailA.at(-1)!,
    wrong = restartCode === "000000" ? "000001" : "000000";
  await assert.rejects(
    ea.verify(
      "signup",
      { requestId: pending.requestId, code: wrong },
      restartPass,
    ),
  );
  await ea.close();
  await eb.close();
  await peer.close();
  peer = undefined;
  await db.close();
  db = undefined;
  await stop();
  await start();
  db = await fixture.connect("auth");
  const auth = new Auth(db, config),
    emails = new EmailAuth(db, auth, config, async () => {});
  assert.equal(
    (
      await db.query<{ attempts: number }>(
        "SELECT attempts FROM email_challenges WHERE email='restart@example.test'",
      )
    ).rows[0].attempts,
    1,
  );
  await emails.verify(
    "signup",
    { requestId: pending.requestId, code: restartCode },
    restartPass,
  );
  await assert.rejects(
    emails.verify(
      "signup",
      { requestId: pending.requestId, code: restartCode },
      restartPass,
    ),
  );
  assert.ok(
    await auth.sessionOwner(
      await auth.login(restartPass, undefined, "restart@example.test"),
    ),
  );
  console.log(
    "PASS: pending codes and failed attempts survive PostgreSQL restart",
  );
  const disposable = await auth.register("delete_email", pass());
  const id = (await auth.sessionOwner(disposable))!;
  await db.query(
    "INSERT INTO email_challenges(hash,email,purpose,owner,auth_version,code_hash) VALUES($1,$2,$3,$4,0,$5)",
    [
      randomUUID(),
      "delete@example.test",
      "link",
      id,
      randomBytes(32).toString("hex"),
    ],
  );
  await db.query("DELETE FROM sessions WHERE owner=$1", [id]);
  await db.query("DELETE FROM users WHERE id=$1", [id]);
  assert.equal(
    (await db.query("SELECT hash FROM email_challenges WHERE owner=$1", [id]))
      .rows.length,
    0,
  );
  console.log("PASS: account deletion cascades pending email challenges");
  const crashPassword = pass();
  const worker = fork(
    fileURLToPath(new URL("./postgres-email-worker.ts", import.meta.url)),
    [],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  try {
    const message = once(worker, "message");
    worker.send({
      root,
      databaseUrl: fixture.url("auth"),
      secret: config.emailAuth!.secret,
      password: crashPassword,
    });
    const [result] = (await message) as [{ requestId: string; code: string }];
    assert.match(result.requestId, /^[A-Za-z0-9_-]{43}$/);
    assert.match(result.code, /^[0-9]{6}$/);
    const exited = once(worker, "exit");
    worker.kill("SIGKILL");
    await exited;
    const postCrashMail: string[] = [];
    const postCrashEmails = new EmailAuth(
      db,
      auth,
      config,
      async (_email, code) => {
        postCrashMail.push(code);
      },
    );
    assert.equal(
      (
        await db.query("SELECT hash FROM email_challenges WHERE hash=$1", [
          digest(result.requestId),
        ])
      ).rows.length,
      1,
    );
    await db.query(
      "UPDATE email_request_limits SET last_at=now()-interval '2 minutes'",
    );
    const replacement = await postCrashEmails.request(
      "signup",
      "crash@example.test",
      crashPassword,
    );
    await assert.rejects(
      postCrashEmails.verify(
        "signup",
        { requestId: result.requestId, code: result.code },
        crashPassword,
      ),
    );
    await postCrashEmails.verify(
      "signup",
      { requestId: replacement.requestId, code: postCrashMail.at(-1)! },
      crashPassword,
    );
    await postCrashEmails.close();
    console.log(
      "PASS: killing a process during SMTP delivery preserves the database and resend recovers safely",
    );
  } finally {
    worker.kill("SIGKILL");
  }

  // Rehearse pg_dump/pg_restore across the v10 -> v11 boundary with original
  // files and active credentials, without ever opening a hosted database.
  const source = await fixture.create("legacy_restore"),
    sourceAuth = new Auth(source, config),
    library = new Library(source);
  await migrate(source);
  const legacyPassword = pass(),
    legacySession = await sourceAuth.setup(legacyPassword),
    legacyOwner = (await sourceAuth.sessionOwner(legacySession))!;
  const attachment = await library.upload(
    legacyOwner,
    Buffer.from("Synthetic original retained across restore"),
    "text/plain",
    "original.txt",
  );
  const saved = await library.save(legacyOwner, {
    requestId: randomUUID(),
    title: "Migration restore fixture",
    source: {
      attachmentId: attachment.attachmentId,
      originalText: "Immutable fixture text",
    },
  });
  const bearer = pass();
  await source.query(
    "INSERT INTO oauth_tokens(hash,family,owner,client_id,kind,scopes,resource,expires_at) VALUES($1,$2,$3,$4,'access',$5,$6,now()+interval '1 hour')",
    [
      digest(bearer),
      randomUUID(),
      legacyOwner,
      randomUUID(),
      ["library:read"],
      `${config.origin}/mcp`,
    ],
  );
  await source.query(
    "INSERT INTO chatgpt_connections(owner,issuer,client_id,subject,credentials) VALUES($1,$2,$3,$4,$5)",
    [
      legacyOwner,
      "https://auth.openai.com",
      randomUUID(),
      randomUUID(),
      pass(),
    ],
  );
  await source.query("DROP TABLE email_challenges,email_request_limits");
  await source.query(
    "ALTER TABLE users DROP COLUMN email,DROP COLUMN email_verified_at",
  );
  await source.query("DELETE FROM schema_migrations WHERE version=11");
  const tables = [
    "users",
    "sessions",
    "items",
    "sources",
    "attachments",
    "oauth_tokens",
    "chatgpt_connections",
  ] as const;
  const fingerprint = async (database: Database) => {
    const result: Record<string, unknown> = {};
    for (const table of tables) {
      const projection =
        table === "users"
          ? "id,singleton,username,password_hash,created_at,auth_version,recovery_hash,recovery_created_at,ai_search_enabled,chatgpt_plan_selected"
          : "*";
      result[table] = (
        await database.query(
          `SELECT count(*)::int AS count,md5(coalesce(string_agg(row_to_json(records)::text,'' ORDER BY row_to_json(records)::text),'')) AS digest FROM (SELECT ${projection} FROM ${table}) records`,
        )
      ).rows;
    }
    return result;
  };
  const before = await fingerprint(source),
    dump = join(root, "synthetic-v10.dump");
  await run(binary("pg_dump"), [
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "--file",
    dump,
    "--dbname",
    fixture.url("legacy_restore"),
  ]);
  assert.ok((await readFile(dump)).byteLength > 0);
  const restored = await fixture.create("restored_fixture");
  await run(binary("pg_restore"), [
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    "--dbname",
    fixture.url("restored_fixture"),
    dump,
  ]);
  await migrate(restored);
  await migrate(restored);
  assert.deepEqual(await fingerprint(restored), before);
  const restoredAuth = new Auth(restored, config),
    restoredLibrary = new Library(restored);
  assert.equal(await restoredAuth.sessionOwner(legacySession), legacyOwner);
  assert.equal(
    await restoredAuth.sessionOwner(
      await restoredAuth.login(legacyPassword, undefined, "owner"),
    ),
    legacyOwner,
  );
  assert.equal(
    (await restoredAuth.verifyAccessToken(bearer)).extra?.owner,
    legacyOwner,
  );
  assert.equal(
    (await restoredLibrary.get(legacyOwner, saved.item.id)).source.originalText,
    "Immutable fixture text",
  );
  console.log(
    "PASS: PostgreSQL 16 dump/restore and repeated migration preserve IDs, libraries, original bytes and active connections",
  );
  // The previous release's username-only read remains valid against v11.
  const oldQuery = (
    await restored.query<{ id: string }>(
      "SELECT id FROM users WHERE username=$1 OR ($1='owner' AND singleton=true) LIMIT 1",
      ["owner"],
    )
  ).rows[0];
  assert.equal(oldQuery.id, legacyOwner);
  assert.equal(
    (await restored.query("SELECT id FROM items WHERE owner=$1", [oldQuery.id]))
      .rows.length,
    1,
  );
  const rollbackMail: string[] = [];
  const restoredEmails = new EmailAuth(
    restored,
    restoredAuth,
    config,
    async (_email, code) => {
      rollbackMail.push(code);
    },
  );
  const emailPassword = pass(),
    emailSignup = await restoredEmails.request(
      "signup",
      "rollback-email@example.test",
      emailPassword,
    );
  await restoredEmails.verify(
    "signup",
    { requestId: emailSignup.requestId, code: rollbackMail.at(-1)! },
    emailPassword,
  );
  assert.equal(
    (
      await restored.query("SELECT id FROM users WHERE username=$1", [
        "rollback-email@example.test",
      ])
    ).rows.length,
    0,
  );
  assert.ok(
    await restoredAuth.sessionOwner(
      await restoredAuth.login(
        emailPassword,
        undefined,
        "rollback-email@example.test",
      ),
    ),
  );
  console.log(
    "PASS: legacy rollback compatibility verified; email-only accounts require the new auth release (roll-forward after admission)",
  );
  await restoredEmails.close();
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const startupPort = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const startupOrigin = `http://127.0.0.1:${startupPort}`;
  const service = spawn(
    process.execPath,
    [
      "--import",
      fileURLToPath(
        new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
      ),
      fileURLToPath(new URL("../server/index.ts", import.meta.url)),
    ],
    {
      cwd: root,
      stdio: "ignore",
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        PORT: String(startupPort),
        PUBLIC_URL: startupOrigin,
        DATABASE_URL: fixture.url("restored_fixture"),
        ACCOUNT_MODE: "public",
        ALLOW_SIGNUP: "false",
        EMAIL_AUTH_ENABLED: "false",
      },
    },
  );
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      ready = await fetch(startupOrigin + "/ready")
        .then((response) => response.ok)
        .catch(() => false);
      if (ready) break;
      if (service.exitCode !== null) break;
      await delay(100);
    }
    assert.equal(
      ready,
      true,
      "The actual production entry point must start against restored PostgreSQL",
    );
    for (const credentials of [
      { username: "owner", password: legacyPassword },
      { email: "rollback-email@example.test", password: emailPassword },
    ]) {
      const response = await fetch(startupOrigin + "/api/login", {
        method: "POST",
        headers: { Origin: startupOrigin, "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
    }
    const exited = once(service, "exit");
    service.kill("SIGTERM");
    assert.equal((await exited)[0], 0);
    console.log(
      "PASS: actual production entry point starts on restored PostgreSQL, supports closed-signup login and shuts down cleanly",
    );
  } finally {
    if (service.exitCode === null) service.kill("SIGKILL");
  }
} finally {
  await peer?.close();
  await db?.close();
  await fixture.close();
}
