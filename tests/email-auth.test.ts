import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/app.js";
import { EmailAuth, type EmailSender } from "../server/email-auth.js";
import type { Config } from "../server/config.js";
import { digest } from "../server/library.js";
import { exportLibrary } from "./legacy-export-fixture.js";

const password = () => randomBytes(24).toString("base64url");
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "drop-it-email-"));
  const db = await openDatabase({ dataDir });
  await migrate(db);
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port,
    origin = `http://127.0.0.1:${port}`;
  const config: Config = {
    port,
    origin,
    local: true,
    production: false,
    dataDir,
    ai: undefined,
    databaseUrl: undefined,
    redirectUris: [],
    publicAccounts: true,
    signupEnabled: true,
    emailAuth: {
      secret: password(),
      from: "sender@example.test",
      username: password(),
      password: password(),
    },
  };
  const sent: { email: string; code: string; purpose: string }[] = [];
  const sender: EmailSender = async (email, code, purpose) => {
    sent.push({ email, code, purpose });
  };
  const built = createApp(
    db,
    config,
    "<!doctype html><title>Synthetic email fixture</title>",
    undefined,
    fetch,
    sender,
  );
  server.on("request", built.app);
  const request = (path: string, body?: unknown, cookie = "", site = origin) =>
    fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: site,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const code = () => sent.at(-1)!.code;
  const cooldown = () =>
    db.query(
      "UPDATE email_request_limits SET last_at=now()-interval '2 minutes'",
    );
  return {
    ...built,
    db,
    config,
    sent,
    sender,
    request,
    code,
    cooldown,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await built.close();
      await db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function fixture(run: (f: Fixture) => Promise<void>) {
  const f = await setup();
  try {
    await run(f);
  } finally {
    await f.close();
  }
}
async function signup(f: Fixture, email: string, pass = password()) {
  const challenge = await f.emailAuth.request("signup", email, pass);
  await f.emailAuth.verify(
    "signup",
    { requestId: challenge.requestId, code: f.code() },
    pass,
  );
  const session = await f.auth.login(pass, undefined, email);
  return { email, pass, session, owner: (await f.auth.sessionOwner(session))! };
}
async function seedCredentials(f: Fixture, owner: string) {
  const access = password();
  await f.db.query(
    `INSERT INTO oauth_tokens(hash,family,owner,client_id,kind,scopes,resource,expires_at)
    VALUES($1,$2,$3,$4,'access',$5,$6,now()+interval '1 hour')`,
    [
      digest(access),
      randomUUID(),
      owner,
      randomUUID(),
      ["library:read"],
      `${f.config.origin}/mcp`,
    ],
  );
  await f.db.query(
    "INSERT INTO chatgpt_connections(owner,issuer,client_id,subject,credentials) VALUES($1,$2,$3,$4,$5)",
    [owner, "https://auth.openai.com", randomUUID(), randomUUID(), password()],
  );
  return access;
}

test("email signup creates no account or session before verification, normalizes email and scopes libraries", () =>
  fixture(async (f) => {
    const pass = password();
    const start = await f.request("/api/register", {
      email: "  New.User@EXAMPLE.TEST  ",
      password: pass,
    });
    assert.equal(start.status, 200);
    assert.equal(start.headers.get("set-cookie"), null);
    const { requestId } = await start.json();
    assert.equal(f.sent[0].email, "new.user@example.test");
    assert.equal((await f.db.query("SELECT id FROM users")).rows.length, 0);
    assert.equal(
      (
        await f.request("/api/login", {
          email: "new.user@example.test",
          password: pass,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await f.request("/api/email/verify-signup", {
          requestId,
          code: f.code(),
          password: password(),
        })
      ).status,
      400,
    );
    const verified = await f.request("/api/email/verify-signup", {
      requestId,
      code: f.code(),
      password: pass,
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.headers.get("set-cookie"), null);
    const login = await f.request("/api/login", {
      email: "NEW.USER@example.test",
      password: pass,
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.match(login.headers.get("set-cookie")!, /HttpOnly/);
    const owner = (await f.auth.sessionOwner(cookie.split("=")[1]))!;
    const other = await signup(f, "other@example.test");
    const item = await f.library.save(other.owner, {
      requestId: randomUUID(),
      title: "Other library",
      source: { originalText: "Synthetic original" },
    });
    assert.equal(
      (await f.request(`/api/items/${item.item.id}`, undefined, cookie)).status,
      404,
    );
    assert.equal((await exportLibrary(f.library, owner)).items.length, 0);
    await assert.rejects(
      f.emailAuth.verify("signup", { requestId, code: f.code() }, pass),
    );
    assert.equal(
      (
        await f.request("/api/register", {
          email: "extra@example.test",
          password: pass,
          owner,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request("/api/register", {
          email: "x@example.test\r\nBcc: evil@example.test",
          password: pass,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(
          "/api/register",
          { email: "csrf@example.test", password: pass },
          "",
          "https://attacker.invalid",
        )
      ).status,
      403,
    );
  }));

test("codes expire, are purpose-bound, single-use and enforce committed attempt limits", () =>
  fixture(async (f) => {
    const pass = password();
    const c = await f.emailAuth.request("signup", "limits@example.test", pass),
      code = f.code();
    const stored = (
      await f.db.query<{ code_hash: string; password_hash: string }>(
        "SELECT code_hash,password_hash FROM email_challenges",
      )
    ).rows[0];
    assert.notEqual(stored.code_hash, code);
    assert.notEqual(stored.password_hash, pass);
    await assert.rejects(
      f.emailAuth.verify("reset", { requestId: c.requestId, code }, password()),
    );
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 3; i++)
      await assert.rejects(
        f.emailAuth.verify(
          "signup",
          { requestId: c.requestId, code: wrong },
          pass,
        ),
      );
    assert.equal(
      (
        await f.db.query<{ attempts: number }>(
          "SELECT attempts FROM email_challenges",
        )
      ).rows[0].attempts,
      3,
    );
    await assert.rejects(
      f.emailAuth.verify("signup", { requestId: c.requestId, code }, pass),
    );
    await f.cooldown();
    const next = await f.emailAuth.request(
      "signup",
      "limits@example.test",
      pass,
    );
    await f.db.query(
      "UPDATE email_challenges SET expires_at=now()-interval '1 second'",
    );
    await assert.rejects(
      f.emailAuth.verify(
        "signup",
        { requestId: next.requestId, code: f.code() },
        pass,
      ),
    );
    assert.equal((await f.db.query("SELECT id FROM users")).rows.length, 0);
  }));

test("migration and verified email linking retain legacy account IDs, libraries, sessions and ChatGPT credentials", () =>
  fixture(async (f) => {
    const pass = password(),
      session = await f.auth.setup(pass),
      owner = (await f.auth.sessionOwner(session))!;
    const item = await f.library.save(owner, {
      requestId: randomUUID(),
      title: "Preserved original library",
      source: { originalText: "Immutable source" },
    });
    const access = await seedCredentials(f, owner);
    const usernameSession = await f.auth.register("legacy_user", password());
    const tables = [
      "users",
      "sessions",
      "items",
      "sources",
      "oauth_tokens",
      "chatgpt_connections",
    ] as const;
    const before = await Promise.all(
      tables.map((table) => f.db.query(`SELECT * FROM ${table}`)),
    );
    // Recreate exactly the v10 boundary with synthetic data only.
    await f.db.query("DROP TABLE email_challenges,email_request_limits");
    await f.db.query(
      "ALTER TABLE users DROP COLUMN email,DROP COLUMN email_verified_at",
    );
    await f.db.query("DELETE FROM schema_migrations WHERE version=11");
    await migrate(f.db);
    await migrate(f.db);
    const after = await Promise.all(
      tables.map((table) => f.db.query(`SELECT * FROM ${table}`)),
    );
    assert.deepEqual(after, before);
    const c = await f.emailAuth.request(
      "link",
      "Owner@EXAMPLE.TEST",
      pass,
      owner,
      session,
    );
    assert.equal((await f.auth.security(owner, session)).email, null);
    await f.emailAuth.verify(
      "link",
      { requestId: c.requestId, code: f.code() },
      pass,
      owner,
      session,
    );
    assert.equal(
      await f.auth.sessionOwner(
        await f.auth.login(pass, undefined, "owner@example.test"),
      ),
      owner,
    );
    assert.equal(
      await f.auth.sessionOwner(await f.auth.login(pass, undefined, "owner")),
      owner,
    );
    assert.ok(await f.auth.sessionOwner(usernameSession));
    assert.equal((await f.auth.verifyAccessToken(access)).extra?.owner, owner);
    assert.deepEqual(
      (await f.db.query("SELECT * FROM chatgpt_connections")).rows,
      before[5].rows,
    );
    assert.equal(
      (await f.library.get(owner, item.item.id)).source.originalText,
      "Immutable source",
    );
  }));

test("email reset revokes only the recovering owner's credentials and preserves both libraries", () =>
  fixture(async (f) => {
    const a = await signup(f, "reset@example.test"),
      b = await signup(f, "keep@example.test");
    const access = await seedCredentials(f, a.owner),
      otherAccess = await seedCredentials(f, b.owner);
    const recovery = await f.auth.createRecoveryCode(
      a.owner,
      a.session,
      a.pass,
    );
    const item = await f.library.save(a.owner, {
      requestId: randomUUID(),
      title: "Keep after reset",
      source: { originalText: "Preserved" },
    });
    await f.cooldown();
    const c = await f.emailAuth.request("reset", a.email),
      code = f.code(),
      next = password();
    const result = await f.request("/api/email/reset-password", {
      requestId: c.requestId,
      code,
      newPassword: next,
    });
    assert.equal(result.status, 200);
    assert.match(result.headers.get("set-cookie")!, /Expires=Thu, 01 Jan 1970/);
    assert.equal(await f.auth.sessionOwner(a.session), undefined);
    assert.ok(await f.auth.sessionOwner(b.session));
    await assert.rejects(f.auth.verifyAccessToken(access));
    await f.auth.verifyAccessToken(otherAccess);
    assert.equal(
      (
        await f.db.query(
          "SELECT owner FROM chatgpt_connections WHERE owner=$1",
          [a.owner],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT owner FROM chatgpt_connections WHERE owner=$1",
          [b.owner],
        )
      ).rows.length,
      1,
    );
    await assert.rejects(f.auth.recover(recovery.recoveryCode, password()));
    await assert.rejects(f.auth.login(a.pass, undefined, a.email));
    assert.equal(
      await f.auth.sessionOwner(await f.auth.login(next, undefined, a.email)),
      a.owner,
    );
    assert.equal(
      (await f.library.get(a.owner, item.item.id)).item.title,
      "Keep after reset",
    );
    await assert.rejects(
      f.emailAuth.verify("reset", { requestId: c.requestId, code }, password()),
    );
  }));

test("email requests use generic responses and durable per-email/service throttles without overwriting accounts", () =>
  fixture(async (f) => {
    const a = await signup(f, "taken@example.test");
    const original = (
      await f.db.query("SELECT * FROM users WHERE id=$1", [a.owner])
    ).rows;
    const sent = f.sent.length;
    const existing = await f.emailAuth.request("signup", a.email, password());
    const unknown = await f.emailAuth.request("reset", "missing@example.test");
    assert.deepEqual(Object.keys(existing), Object.keys(unknown));
    assert.equal(f.sent.length, sent);
    const service = new EmailAuth(f.db, f.auth, f.config, f.sender);
    await f.cooldown();
    const first = await service.request("reset", a.email);
    assert.equal(f.sent.length, sent + 1);
    const second = await service.request("reset", a.email);
    assert.notEqual(first.requestId, second.requestId);
    assert.equal(f.sent.length, sent + 1);
    await f.db.query(
      "UPDATE email_request_limits SET last_at=now()-interval '2 minutes',count=5 WHERE key<>'service'",
    );
    await service.request("reset", a.email);
    assert.equal(f.sent.length, sent + 1);
    await f.db.query(
      "UPDATE email_request_limits SET count=100 WHERE key='service'",
    );
    await service.request("signup", "global-limit@example.test", password());
    assert.equal(f.sent.length, sent + 1);
    assert.deepEqual(
      (await f.db.query("SELECT * FROM users WHERE id=$1", [a.owner])).rows,
      original,
    );
    f.config.signupEnabled = false;
    await assert.rejects(
      service.request("signup", "closed@example.test", password()),
    );
    assert.ok(
      await f.auth.sessionOwner(await f.auth.login(a.pass, undefined, a.email)),
    );
  }));

test("linking requires same-origin live owner session and password, and cannot claim another account", () =>
  fixture(async (f) => {
    const pass = password(),
      session = await f.auth.register("legacy_link", pass),
      owner = (await f.auth.sessionOwner(session))!,
      cookie = `drop_it_session=${session}`;
    const other = await signup(f, "claimed@example.test");
    assert.equal(
      (
        await f.request("/api/email/link", {
          email: "legacy@example.test",
          currentPassword: pass,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await f.request(
          "/api/email/link",
          { email: "legacy@example.test", currentPassword: password() },
          cookie,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await f.request(
          "/api/email/link",
          {
            email: "legacy@example.test",
            currentPassword: pass,
            owner: other.owner,
          },
          cookie,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(
          "/api/email/link",
          { email: "legacy@example.test", currentPassword: pass },
          cookie,
          "https://attacker.invalid",
        )
      ).status,
      403,
    );
    const start = await f.request(
      "/api/email/link",
      { email: "legacy@example.test", currentPassword: pass },
      cookie,
    );
    assert.equal(start.status, 200);
    const { requestId } = await start.json(),
      code = f.code();
    await assert.rejects(
      f.emailAuth.verify(
        "link",
        { requestId, code },
        other.pass,
        other.owner,
        other.session,
      ),
    );
    const done = await f.request(
      "/api/email/verify-link",
      { requestId, code, currentPassword: pass },
      cookie,
    );
    assert.equal(done.status, 200);
    assert.equal(
      (await f.auth.security(owner, session)).email,
      "legacy@example.test",
    );
    assert.equal(
      await f.auth.sessionOwner(
        await f.auth.login(pass, undefined, "legacy_link"),
      ),
      owner,
    );
    await f.cooldown();
    const taken = await f.emailAuth.request(
      "link",
      other.email,
      pass,
      owner,
      session,
    );
    await assert.rejects(
      f.emailAuth.verify(
        "link",
        { requestId: taken.requestId, code },
        pass,
        owner,
        session,
      ),
    );
    assert.equal(
      (await f.auth.security(other.owner, other.session)).email,
      other.email,
    );
  }));

test("concurrent verification grants once and password changes invalidate pending reset/link codes", () =>
  fixture(async (f) => {
    const pass = password(),
      c = await f.emailAuth.request("signup", "race@example.test", pass),
      code = f.code();
    const result = await Promise.allSettled([
      f.emailAuth.verify("signup", { requestId: c.requestId, code }, pass),
      f.emailAuth.verify("signup", { requestId: c.requestId, code }, pass),
    ]);
    assert.equal(result.filter((x) => x.status === "fulfilled").length, 1);
    const session = await f.auth.login(pass, undefined, "race@example.test"),
      owner = (await f.auth.sessionOwner(session))!;
    await f.cooldown();
    const reset = await f.emailAuth.request("reset", "race@example.test"),
      resetCode = f.code();
    await f.auth.changePassword(owner, session, pass, password());
    await assert.rejects(
      f.emailAuth.verify(
        "reset",
        { requestId: reset.requestId, code: resetCode },
        password(),
      ),
    );
    assert.equal(
      (
        await f.db.query("SELECT hash FROM email_challenges WHERE owner=$1", [
          owner,
        ])
      ).rows.length,
      0,
    );
  }));

test("failed asynchronous delivery clears only its challenge and never logs email/code/provider errors", () =>
  fixture(async (f) => {
    const logs: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    const failing = new EmailAuth(f.db, f.auth, f.config, async () => {
      throw new Error("Synthetic private provider details");
    });
    try {
      const c = await failing.request(
        "signup",
        "failure@example.test",
        password(),
      );
      assert.equal(c.ok, true);
      await failing.close();
      assert.equal(
        (
          await f.db.query("SELECT hash FROM email_challenges WHERE hash=$1", [
            digest(c.requestId),
          ])
        ).rows.length,
        0,
      );
      const logged = JSON.stringify(logs);
      assert.doesNotMatch(logged, /failure@example|private provider/);
      assert.match(logged, /EMAIL_DELIVERY_FAILED/);
    } finally {
      console.error = original;
    }
  }));

test("closed or unconfigured signup cannot fall back to username registration", () =>
  fixture(async (f) => {
    f.config.emailAuth = undefined;
    assert.equal(
      (
        await f.request("/api/register", {
          email: "disabled@example.test",
          password: password(),
        })
      ).status,
      503,
    );
    assert.equal(
      (
        await f.request("/api/register", {
          username: "bypass",
          password: password(),
        })
      ).status,
      400,
    );
    assert.equal(
      (await (await f.request("/api/session")).json()).signupEnabled,
      false,
    );
  }));

test("email reset, settings password change and offline recovery notify only after success", () =>
  fixture(async (f) => {
    const account = await signup(f, "notifications@example.test");
    const other = await signup(f, "notification-other@example.test");
    const count = () =>
      f.sent.filter((mail) => mail.purpose === "password-changed").length;
    await assert.rejects(
      f.auth.changePassword(
        account.owner,
        account.session,
        password(),
        password(),
      ),
    );
    assert.equal(count(), 0);
    const next = password();
    await f.auth.changePassword(
      account.owner,
      account.session,
      account.pass,
      next,
    );
    await f.emailAuth.close();
    assert.equal(count(), 1);
    assert.equal(f.sent.at(-1)!.email, account.email);
    assert.equal(f.sent.at(-1)!.code, "");
    // New app instance after shutdown models a normal process restart.
    const emails = new EmailAuth(f.db, f.auth, f.config, f.sender);
    f.auth.setPasswordChangedNotifier((email) =>
      emails.notifyPasswordChanged(email),
    );
    const session = await f.auth.login(next, undefined, account.email);
    const recovery = await f.auth.createRecoveryCode(
      account.owner,
      session,
      next,
    );
    const recovered = password();
    await f.auth.recover(recovery.recoveryCode, recovered);
    assert.equal(count(), 2);
    await assert.rejects(f.auth.recover(recovery.recoveryCode, password()));
    assert.equal(count(), 2);
    await f.cooldown();
    const reset = await emails.request("reset", account.email),
      code = f.code();
    await emails.verify(
      "reset",
      { requestId: reset.requestId, code },
      password(),
    );
    await emails.close();
    assert.equal(count(), 3);
    assert.ok(await f.auth.sessionOwner(other.session));
    assert.ok(
      f.sent
        .filter((mail) => mail.purpose === "password-changed")
        .every((mail) => mail.email === account.email && mail.code === ""),
    );
  }));

test("rolled-back password changes never send confirmation mail", () =>
  fixture(async (f) => {
    const account = await signup(f, "rollback-notification@example.test"),
      next = password();
    await f.db.query(
      `CREATE FUNCTION reject_auth_rotation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic rollback'; END $$`,
    );
    await f.db.query(
      "CREATE TRIGGER reject_rotation BEFORE UPDATE OF auth_version ON users FOR EACH ROW EXECUTE FUNCTION reject_auth_rotation()",
    );
    await assert.rejects(
      f.auth.changePassword(account.owner, account.session, account.pass, next),
    );
    assert.equal(
      f.sent.filter((mail) => mail.purpose === "password-changed").length,
      0,
    );
    assert.ok(await f.auth.sessionOwner(account.session));
    assert.ok(
      await f.auth.sessionOwner(
        await f.auth.login(account.pass, undefined, account.email),
      ),
    );
    await f.db.query("DROP TRIGGER reject_rotation ON users");
  }));

test("confirmation delivery failure cannot roll back a committed password or expose it", () =>
  fixture(async (f) => {
    const account = await signup(f, "failed-notification@example.test"),
      next = password();
    const logs: unknown[][] = [],
      old = console.error;
    console.error = (...args) => {
      logs.push(args);
    };
    const emails = new EmailAuth(f.db, f.auth, f.config, async () => {
      throw new Error("Synthetic secret transport detail");
    });
    f.auth.setPasswordChangedNotifier((email) =>
      emails.notifyPasswordChanged(email),
    );
    try {
      await f.auth.changePassword(
        account.owner,
        account.session,
        account.pass,
        next,
      );
      await emails.close();
      assert.equal(await f.auth.sessionOwner(account.session), undefined);
      assert.ok(
        await f.auth.sessionOwner(
          await f.auth.login(next, undefined, account.email),
        ),
      );
      const serialized = JSON.stringify(logs);
      for (const privateValue of [
        account.email,
        account.pass,
        next,
        "secret transport",
      ])
        assert.equal(serialized.includes(privateValue), false);
      assert.match(serialized, /EMAIL_DELIVERY_FAILED/);
    } finally {
      console.error = old;
    }
  }));

test("resend invalidates the old code and a late delivery failure cannot delete its replacement", () =>
  fixture(async (f) => {
    let rejectFirst!: (error: Error) => void;
    const sent: { code: string }[] = [];
    const emails = new EmailAuth(
      f.db,
      f.auth,
      f.config,
      async (_email, code) => {
        sent.push({ code });
        if (sent.length === 1)
          await new Promise<void>((_, reject) => {
            rejectFirst = reject;
          });
      },
    );
    const pass = password(),
      first = await emails.request("signup", "resend@example.test", pass),
      oldCode = sent[0].code;
    await f.cooldown();
    const second = await emails.request("signup", "resend@example.test", pass),
      newCode = sent[1].code;
    await assert.rejects(
      emails.verify(
        "signup",
        { requestId: first.requestId, code: oldCode },
        pass,
      ),
    );
    const old = console.error;
    console.error = () => {};
    try {
      rejectFirst(new Error("Synthetic delayed failure"));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = old;
    }
    assert.equal(
      (
        await f.db.query("SELECT hash FROM email_challenges WHERE hash=$1", [
          digest(second.requestId),
        ])
      ).rows.length,
      1,
    );
    await emails.verify(
      "signup",
      { requestId: second.requestId, code: newCode },
      pass,
    );
    await emails.close();
  }));

test("delivery saturation is bounded and graceful shutdown drains sends and rejects new requests", () =>
  fixture(async (f) => {
    const releases: (() => void)[] = [];
    const emails = new EmailAuth(f.db, f.auth, f.config, async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
    });
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        emails.request("signup", `saturation-${i}@example.test`, password()),
      ),
    );
    assert.equal(releases.length, 4);
    let closed = false;
    const closing = emails.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    await assert.rejects(
      emails.request("signup", "after-close@example.test", password()),
    );
    releases.forEach((release) => release());
    await closing;
    assert.equal(closed, true);
  }));
