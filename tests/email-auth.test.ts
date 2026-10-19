import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { createApp } from "../server/app.js";
import { Auth } from "../server/auth.js";
import {
  EmailDelivery,
  EmailDeliveryError,
  enqueueEmail,
  resendEmailSender,
} from "../server/email-delivery.js";
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
      apiKey: "re_" + password(),
      deliveryKey: randomBytes(32).toString("hex"),
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
  // Explicitly drain synthetic jobs; production starts the polling worker in index.ts.
  const requestEmail = built.emailAuth.request.bind(built.emailAuth);
  built.emailAuth.request = async (
    ...args: Parameters<EmailAuth["request"]>
  ) => {
    const result = await requestEmail(...args);
    await built.emailAuth.delivery?.processPending();
    return result;
  };
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
    await f.db.query(
      "DROP TABLE email_outbox,email_challenges,email_request_limits",
    );
    await f.db.query(
      "ALTER TABLE users DROP COLUMN email,DROP COLUMN email_verified_at",
    );
    await f.db.query("DELETE FROM schema_migrations WHERE version IN (11,12)");
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
    await service.delivery!.processPending();
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

test("permanent delivery failure retains a failed job without logging private provider details", () =>
  fixture(async (f) => {
    const logs: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    const failing = new EmailAuth(f.db, f.auth, f.config, async () => {
      throw new EmailDeliveryError(false);
    });
    try {
      const c = await failing.request(
        "signup",
        "failure@example.test",
        password(),
      );
      assert.equal(c.ok, true);
      await failing.delivery!.processPending();
      await failing.close();
      assert.equal(
        (
          await f.db.query("SELECT hash FROM email_challenges WHERE hash=$1", [
            digest(c.requestId),
          ])
        ).rows.length,
        1,
      );
      assert.equal(
        (
          await f.db.query<{ status: string }>(
            "SELECT status FROM email_outbox WHERE challenge_hash=$1",
            [digest(c.requestId)],
          )
        ).rows[0].status,
        "failed",
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
    await f.emailAuth.delivery!.processPending();
    await f.emailAuth.close();
    assert.equal(count(), 1);
    assert.equal(f.sent.at(-1)!.email, account.email);
    assert.equal(f.sent.at(-1)!.code, "");
    // New app instance after shutdown models a normal process restart.
    const emails = new EmailAuth(f.db, f.auth, f.config, f.sender);
    const session = await f.auth.login(next, undefined, account.email);
    const recovery = await f.auth.createRecoveryCode(
      account.owner,
      session,
      next,
    );
    const recovered = password();
    await f.auth.recover(recovery.recoveryCode, recovered);
    await emails.delivery!.processPending();
    assert.equal(count(), 2);
    await assert.rejects(f.auth.recover(recovery.recoveryCode, password()));
    await emails.delivery!.processPending();
    assert.equal(count(), 2);
    await f.cooldown();
    const reset = await emails.request("reset", account.email);
    await emails.delivery!.processPending();
    const code = f.code();
    await emails.verify(
      "reset",
      { requestId: reset.requestId, code },
      password(),
    );
    await emails.delivery!.processPending();
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
    try {
      await f.auth.changePassword(
        account.owner,
        account.session,
        account.pass,
        next,
      );
      await emails.delivery!.processPending();
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
      assert.match(serialized, /EMAIL_DELIVERY_RETRY/);
    } finally {
      console.error = old;
    }
  }));

async function queueFixture(
  run: (f: {
    db: Database;
    config: Config;
    auth: Auth;
    emails: EmailAuth;
    sent: { email: string; code: string; purpose: string; id: string }[];
  }) => Promise<void>,
) {
  const dataDir = await mkdtemp(join(tmpdir(), "drop-it-outbox-"));
  const db = await openDatabase({ dataDir });
  const config: Config = {
    port: 4317,
    origin: "http://127.0.0.1:4317",
    local: true,
    production: false,
    dataDir,
    databaseUrl: undefined,
    ai: undefined,
    redirectUris: [],
    publicAccounts: true,
    signupEnabled: true,
    emailAuth: {
      secret: password(),
      from: "sender@example.test",
      apiKey: "re_" + password(),
      deliveryKey: randomBytes(32).toString("hex"),
    },
  };
  await migrate(db);
  const sent: { email: string; code: string; purpose: string; id: string }[] =
    [];
  const auth = new Auth(db, config);
  const sender: EmailSender = async (email, code, purpose, delivery) => {
    sent.push({ email, code, purpose, id: delivery.id });
    return randomUUID();
  };
  const emails = new EmailAuth(db, auth, config, sender);
  try {
    await run({ db, config, auth, emails, sent });
  } finally {
    await emails.close();
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
const due = (db: Database) =>
  db.query(
    "UPDATE email_outbox SET next_attempt_at=now()-interval '1 second',locked_until=NULL,lease_token=NULL WHERE status='pending'",
  );

test("challenge and encrypted job commit together; a fresh worker delivers without requesting another code", () =>
  queueFixture(async ({ db, config, auth, emails, sent }) => {
    const pass = password(),
      request = await emails.request("signup", "restart@example.test", pass);
    assert.equal(sent.length, 0);
    const job = (
      await db.query<{ id: string; payload: string; challenge_hash: string }>(
        "SELECT * FROM email_outbox",
      )
    ).rows[0];
    assert.equal(job.challenge_hash, digest(request.requestId));
    assert.doesNotMatch(job.payload, /restart@example|code|password/);
    assert.equal(job.payload.includes(pass), false);
    await emails.close();
    const restarted = new EmailAuth(
      db,
      auth,
      config,
      async (email, code, purpose, delivery) => {
        sent.push({ email, code, purpose, id: delivery.id });
        return randomUUID();
      },
    );
    await restarted.delivery!.processPending();
    assert.equal(sent.length, 1);
    const stored = (
      await db.query<{ payload: null; status: string; provider_id: string }>(
        "SELECT * FROM email_outbox",
      )
    ).rows[0];
    assert.equal(stored.status, "accepted");
    assert.equal(stored.payload, null);
    assert.ok(stored.provider_id);
    await restarted.verify(
      "signup",
      { requestId: request.requestId, code: sent[0].code },
      pass,
    );
    assert.equal(
      (await db.query("SELECT id FROM email_outbox")).rows.length,
      0,
    );
    await restarted.close();
  }));

test("database rollback prevents both challenges and jobs, and prevents password rotation without its notification", () =>
  queueFixture(async ({ db, config, auth, emails }) => {
    await db.query(
      `CREATE FUNCTION reject_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic queue failure'; END $$`,
    );
    await db.query(
      "CREATE TRIGGER reject_mail BEFORE INSERT ON email_outbox FOR EACH ROW EXECUTE FUNCTION reject_mail()",
    );
    await assert.rejects(
      emails.request("signup", "rollback@example.test", password()),
    );
    assert.equal(
      (await db.query("SELECT hash FROM email_challenges")).rows.length,
      0,
    );
    const pass = password(),
      session = await auth.setup(pass),
      owner = (await auth.sessionOwner(session))!;
    await db.query(
      "UPDATE users SET email=$1,email_verified_at=now() WHERE id=$2",
      ["rollback@example.test", owner],
    );
    await assert.rejects(auth.changePassword(owner, session, pass, password()));
    assert.equal(await auth.sessionOwner(session), owner);
    assert.ok(await auth.login(pass, undefined, "rollback@example.test"));
    assert.equal(
      (await db.query("SELECT id FROM email_outbox")).rows.length,
      0,
    );
    assert.ok(config.emailAuth);
  }));

test("transient failures retry the same immutable message and key, permanent failures erase private payloads", () =>
  queueFixture(async ({ db, config, emails }) => {
    await emails.request("signup", "retry@example.test", password());
    const calls: string[] = [];
    let attempts = 0;
    const send = resendEmailSender(config.emailAuth!, async (_url, options) => {
      calls.push(
        new Headers(options!.headers).get("idempotency-key")! +
          String(options!.body),
      );
      if (++attempts === 1)
        return Response.json(
          { name: "rate_limit_exceeded" },
          { status: 429, headers: { "retry-after": "120" } },
        );
      return Response.json({ id: randomUUID() });
    });
    const worker = new EmailDelivery(db, config.emailAuth!, send);
    await worker.processPending();
    assert.equal(
      (
        await db.query<{ delayed: boolean }>(
          "SELECT next_attempt_at>now()+interval '119 seconds' AS delayed FROM email_outbox",
        )
      ).rows[0].delayed,
      true,
    );
    await worker.processPending();
    assert.equal(attempts, 1);
    config.emailAuth!.from = "changed@example.test";
    await due(db);
    await worker.processPending();
    assert.equal(calls[0], calls[1]);
    await emails.request("signup", "permanent@example.test", password());
    const rejected = new EmailDelivery(db, config.emailAuth!, async () => {
      throw new EmailDeliveryError(false);
    });
    await rejected.processPending();
    const job = (
      await db.query<{ status: string; payload: null }>(
        "SELECT * FROM email_outbox WHERE status='failed'",
      )
    ).rows[0];
    assert.equal(job.status, "failed");
    assert.equal(job.payload, null);
    await rejected.close();
    await worker.close();
  }));

test("crash after provider acceptance reuses the same idempotency key after lease expiry", () =>
  queueFixture(async ({ db, config, emails }) => {
    await emails.request("signup", "accepted@example.test", password());
    let failAck = true;
    const faultDb: Database = {
      ...db,
      query: async (sql, params) => {
        if (failAck && sql.includes("status='accepted'")) {
          failAck = false;
          throw new Error("Synthetic lost acknowledgement");
        }
        return db.query(sql, params);
      },
    };
    const keys: string[] = [],
      providerAccepted = new Set<string>();
    const sender: EmailSender = async (_email, _code, _purpose, delivery) => {
      keys.push(delivery.id);
      providerAccepted.add(delivery.id);
      return randomUUID();
    };
    const crashed = new EmailDelivery(faultDb, config.emailAuth!, sender);
    await assert.rejects(crashed.processPending());
    assert.equal(
      (await db.query<{ status: string }>("SELECT status FROM email_outbox"))
        .rows[0].status,
      "pending",
    );
    await crashed.close();
    const restarted = new EmailDelivery(db, config.emailAuth!, sender);
    await restarted.processPending();
    assert.equal(keys.length, 1);
    await due(db);
    await restarted.processPending();
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(providerAccepted.size, 1);
    await restarted.close();
  }));

test("replacement, verification, revocation, deletion and expiry cancel stale email jobs", () =>
  queueFixture(async ({ db, auth, emails, sent }) => {
    const pass = password();
    await emails.request("signup", "replace@example.test", pass);
    const oldJob = (
      await db.query<{ id: string }>("SELECT id FROM email_outbox")
    ).rows[0].id;
    await db.query(
      "UPDATE email_request_limits SET last_at=now()-interval '2 minutes'",
    );
    const replacement = await emails.request(
      "signup",
      "replace@example.test",
      pass,
    );
    assert.equal(
      (await db.query("SELECT id FROM email_outbox WHERE id=$1", [oldJob])).rows
        .length,
      0,
    );
    await emails.delivery!.processPending();
    await emails.verify(
      "signup",
      { requestId: replacement.requestId, code: sent[0].code },
      pass,
    );
    const session = await auth.login(pass, undefined, "replace@example.test"),
      owner = (await auth.sessionOwner(session))!;
    await db.query(
      "UPDATE email_request_limits SET last_at=now()-interval '2 minutes'",
    );
    await emails.request("reset", "replace@example.test");
    await auth.logoutEverywhere(owner, session, pass);
    assert.equal(
      (await db.query("SELECT id FROM email_outbox")).rows.length,
      0,
    );
    await emails.request("signup", "expired@example.test", password());
    await db.query(
      "UPDATE email_outbox SET expires_at=now()-interval '1 second'",
    );
    await emails.delivery!.processPending();
    assert.equal(sent.length, 1);
    assert.equal(
      (await db.query<{ payload: null }>("SELECT payload FROM email_outbox"))
        .rows[0].payload,
      null,
    );
    const nextSession = await auth.login(
      pass,
      undefined,
      "replace@example.test",
    );
    await auth.changePassword(owner, nextSession, pass, password());
    assert.equal(
      (await db.query("SELECT id FROM email_outbox WHERE owner=$1", [owner]))
        .rows.length,
      1,
    );
    await db.query("DELETE FROM users WHERE id=$1", [owner]);
    assert.equal(
      (await db.query("SELECT id FROM email_outbox WHERE owner=$1", [owner]))
        .rows.length,
      0,
    );
  }));

test("ciphertext tampering and retry exhaustion stop safely, and shutdown leaves unclaimed work durable", () =>
  queueFixture(async ({ db, config, emails }) => {
    await emails.request("signup", "tamper@example.test", password());
    const worker = new EmailDelivery(db, config.emailAuth!, async () => {
      throw new Error("Should not send");
    });
    await db.query("UPDATE email_outbox SET payload=$1", [
      randomBytes(100).toString("base64"),
    ]);
    await worker.processPending();
    assert.equal(
      (
        await db.query<{ failure_code: string }>(
          "SELECT failure_code FROM email_outbox",
        )
      ).rows[0].failure_code,
      "invalid_payload",
    );
    await emails.request("signup", "exhausted@example.test", password());
    await db.query(
      "UPDATE email_outbox SET attempts=19 WHERE status='pending'",
    );
    const retrying = new EmailDelivery(db, config.emailAuth!, async () => {
      throw new EmailDeliveryError(true);
    });
    await retrying.processPending();
    assert.equal(
      (await db.query("SELECT id FROM email_outbox WHERE status='pending'"))
        .rows.length,
      0,
    );
    await emails.request("signup", "shutdown@example.test", password());
    await worker.close();
    await worker.processPending();
    assert.equal(
      (await db.query("SELECT id FROM email_outbox WHERE status='pending'"))
        .rows.length,
      1,
    );
    await assert.rejects(
      db.transaction((tx) =>
        enqueueEmail(tx, config.emailAuth!, "bad", "123456", "reset", null),
      ),
    );
    await retrying.close();
  }));

test("exhausted verification attempts cancel an email that has not been submitted", () =>
  queueFixture(async ({ db, emails, sent }) => {
    const request = await emails.request(
      "signup",
      "attempts@example.test",
      password(),
    );
    for (let attempt = 0; attempt < 3; attempt++)
      await assert.rejects(
        emails.verify(
          "signup",
          { requestId: request.requestId, code: "000000" },
          password(),
        ),
      );
    assert.equal(
      (await db.query("SELECT id FROM email_outbox")).rows.length,
      0,
    );
    await emails.delivery!.processPending();
    assert.equal(sent.length, 0);
  }));
