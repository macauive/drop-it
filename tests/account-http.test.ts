import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.js";
import { migrate, openDatabase } from "../server/db.js";
import type { Config } from "../server/config.js";
import { digest } from "../server/library.js";

const password = () => randomBytes(24).toString("base64url");
type Security = {
  recoveryEnabled: boolean;
  recoveryCreatedAt: string | null;
  sessions: {
    id: string;
    label: string;
    createdAt: string;
    lastSeenAt: string;
    expiresAt: string;
    current: boolean;
  }[];
};
async function createFixture(configure = true) {
  const dir = await mkdtemp(join(tmpdir(), "drop-it-account-http-"));
  const db = await openDatabase({ dataDir: dir });
  await migrate(db);
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const config: Config = {
    port,
    origin,
    local: true,
    production: false,
    redirectUris: [],
    dataDir: dir,
    databaseUrl: undefined,
    ai: undefined,
  };
  const built = createApp(
    db,
    config,
    "<!doctype html><title>Account fixture</title>",
  );
  server.on("request", built.app);
  const initialPassword = password();
  const session = configure ? await built.auth.setup(initialPassword) : "";
  const owner = session ? (await built.auth.sessionOwner(session))! : "";
  const cookie = session ? `drop_it_session=${session}` : "";
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method,
      redirect: "manual",
      headers: {
        Origin: origin,
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    ...built,
    db,
    owner,
    session,
    cookie,
    password: initialPassword,
    origin,
    request,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function fixture(run: (f: Fixture) => Promise<void>, configure = true) {
  const f = await createFixture(configure);
  try {
    await run(f);
  } finally {
    await f.close();
  }
}
async function security(f: Fixture, cookie = f.cookie): Promise<Security> {
  const response = await f.request("/api/security", "GET", undefined, {
    Cookie: cookie,
  });
  assert.equal(response.status, 200);
  return response.json();
}
function signedInCookie(response: Response) {
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /^drop_it_session=[A-Za-z0-9_-]{43};/);
  return cookie.split(";")[0];
}
function signedOutCookie(response: Response) {
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^drop_it_session=;/);
  assert.match(cookie, /Expires=Thu, 01 Jan 1970/);
  assert.match(cookie, /HttpOnly/);
}
async function seedLibrary(f: Fixture) {
  return f.library.save(f.owner, {
    requestId: randomUUID(),
    title: "Account safety fixture",
    notes: "Preserve this library",
    source: { originalText: "Immutable synthetic original" },
  });
}
async function seedOAuth(f: Fixture) {
  const access = randomBytes(32).toString("base64url");
  const client = randomUUID();
  await f.db.query(
    "INSERT INTO oauth_tokens(hash,family,owner,client_id,kind,scopes,resource,expires_at) VALUES($1,$2,$3,$4,'access',$5,$6,now()+interval '1 hour')",
    [
      digest(access),
      randomUUID(),
      f.owner,
      client,
      ["library:read"],
      `${f.origin}/mcp`,
    ],
  );
  await f.db.query(
    "INSERT INTO oauth_codes(hash,owner,client_id,params,expires_at) VALUES($1,$2,$3,'{}',now()+interval '1 minute')",
    [digest(randomBytes(32)), f.owner, client],
  );
  return access;
}
async function noOAuth(f: Fixture, access: string) {
  await assert.rejects(f.auth.verifyAccessToken(access));
  for (const table of ["oauth_tokens", "oauth_codes"])
    assert.equal(
      (await f.db.query(`SELECT owner FROM ${table} WHERE owner=$1`, [f.owner]))
        .rows.length,
      0,
    );
}

test("account routes require a live session and reject cross-origin writes", () =>
  fixture(async (f) => {
    const body = { currentPassword: f.password };
    const routes: [string, string, unknown?][] = [
      ["/api/security", "GET"],
      ["/api/change-password", "POST", { ...body, newPassword: password() }],
      ["/api/recovery-code", "POST", body],
      ["/api/logout-all", "POST", body],
      [`/api/sessions/${randomUUID()}`, "DELETE", body],
    ];
    for (const [path, method, payload] of routes) {
      for (const Cookie of [
        "",
        `drop_it_session=${randomBytes(32).toString("base64url")}`,
      ])
        assert.equal(
          (await f.request(path, method, payload, { Cookie })).status,
          401,
          path,
        );
      if (method !== "GET") {
        for (const Origin of ["", "https://attacker.example"])
          assert.equal(
            (await f.request(path, method, payload, { Origin })).status,
            403,
            path,
          );
      }
    }
    assert.equal(
      (
        await f.request(
          "/api/recover",
          "POST",
          {
            recoveryCode: randomBytes(32).toString("base64url"),
            newPassword: password(),
          },
          { Cookie: "", Origin: "https://attacker.example" },
        )
      ).status,
      403,
    );
    assert.equal((await security(f)).recoveryEnabled, false);
  }));

test("account mutation schemas reject unexpected fields, invalid IDs and password boundaries", () =>
  fixture(async (f) => {
    const valid = { currentPassword: f.password, newPassword: password() };
    const cases: [string, string, unknown][] = [
      ["/api/change-password", "POST", { ...valid, owner: randomUUID() }],
      ["/api/change-password", "POST", { ...valid, currentPassword: "" }],
      [
        "/api/change-password",
        "POST",
        { ...valid, currentPassword: "x".repeat(129) },
      ],
      [
        "/api/change-password",
        "POST",
        { ...valid, newPassword: "x".repeat(14) },
      ],
      [
        "/api/change-password",
        "POST",
        { ...valid, newPassword: "x".repeat(129) },
      ],
      [
        "/api/recovery-code",
        "POST",
        { currentPassword: f.password, recoveryCode: "injected" },
      ],
      [
        "/api/logout-all",
        "POST",
        { currentPassword: f.password, allOwners: true },
      ],
      [
        `/api/sessions/${randomUUID()}`,
        "DELETE",
        { currentPassword: f.password, owner: randomUUID() },
      ],
      ["/api/sessions/not-a-uuid", "DELETE", { currentPassword: f.password }],
    ];
    for (const [path, method, body] of cases) {
      const response = await f.request(path, method, body);
      assert.equal(response.status, 400, path);
      const text = await response.text();
      assert.equal(text.includes(f.password), false);
      assert.equal(text.includes("stack"), false);
    }
    assert.equal((await security(f)).sessions.length, 1);
  }));

test("recovery input validation is strict without requiring authentication", () =>
  fixture(async (f) => {
    const valid = {
      recoveryCode: randomBytes(32).toString("base64url"),
      newPassword: password(),
    };
    for (const body of [
      { ...valid, owner: f.owner },
      { ...valid, recoveryCode: "x".repeat(42) },
      { ...valid, recoveryCode: "x".repeat(44) },
      { ...valid, recoveryCode: "!".repeat(43) },
      { ...valid, newPassword: "x".repeat(14) },
      { ...valid, newPassword: "x".repeat(129) },
    ])
      assert.equal(
        (await f.request("/api/recover", "POST", body, { Cookie: "" })).status,
        400,
      );
    assert.equal((await security(f)).recoveryEnabled, false);
  }));

test("session metadata uses public IDs and coarse labels without raw agents, IPs or token hashes", () =>
  fixture(async (f) => {
    const marker = `PrivateAgentMarker-${randomUUID()}`;
    const response = await f.request(
      "/api/login",
      "POST",
      { password: f.password },
      {
        Cookie: "",
        "User-Agent": `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 ${marker}`,
      },
    );
    const secondCookie = signedInCookie(response);
    const secondToken = secondCookie.slice("drop_it_session=".length);
    const other = randomUUID();
    await f.db.query(
      "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$2)",
      [other, "synthetic-unusable-hash"],
    );
    const otherToken = await f.auth.session(other);
    const expired = await f.auth.session(f.owner);
    await f.db.query(
      "UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE hash=$1",
      [digest(expired)],
    );
    const metadata = await security(f, secondCookie);
    assert.deepEqual(Object.keys(metadata).sort(), [
      "recoveryCreatedAt",
      "recoveryEnabled",
      "sessions",
    ]);
    assert.equal(metadata.sessions.length, 2);
    assert.equal(
      metadata.sessions.filter((session) => session.current).length,
      1,
    );
    const serialized = JSON.stringify(metadata);
    for (const secret of [
      marker,
      f.session,
      secondToken,
      otherToken,
      digest(f.session),
      digest(secondToken),
      "127.0.0.1",
      "::1",
    ])
      assert.equal(serialized.includes(secret), false);
    for (const session of metadata.sessions) {
      assert.deepEqual(Object.keys(session).sort(), [
        "createdAt",
        "current",
        "expiresAt",
        "id",
        "label",
        "lastSeenAt",
      ]);
      assert.match(session.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
      assert.ok(session.label.length > 0 && session.label.length < 100);
      for (const timestamp of [
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
      ])
        assert.ok(Number.isFinite(Date.parse(timestamp)));
    }
    assert.equal(
      (await f.request("/api/security")).headers.get("cache-control"),
      "no-store",
    );
  }));

test("password changes reauthenticate, revoke every credential, clear the cookie and preserve the library", () =>
  fixture(async (f) => {
    const saved = await seedLibrary(f),
      access = await seedOAuth(f);
    const secondSession = await f.auth.session(f.owner);
    const recovery = await f.request("/api/recovery-code", "POST", {
      currentPassword: f.password,
    });
    assert.equal(recovery.status, 200);
    const recoveryCode = (await recovery.json()).recoveryCode as string;
    const nextPassword = password();
    assert.equal(
      (
        await f.request("/api/change-password", "POST", {
          currentPassword: password(),
          newPassword: nextPassword,
        })
      ).status,
      401,
    );
    assert.equal(await f.auth.sessionOwner(secondSession), f.owner);
    const changed = await f.request("/api/change-password", "POST", {
      currentPassword: f.password,
      newPassword: nextPassword,
    });
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), { ok: true });
    signedOutCookie(changed);
    assert.equal(await f.auth.sessionOwner(secondSession), undefined);
    assert.equal((await f.request("/api/security")).status, 401);
    await noOAuth(f, access);
    assert.equal(
      (
        await f.request(
          "/api/recover",
          "POST",
          { recoveryCode, newPassword: password() },
          { Cookie: "" },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await f.request(
          "/api/login",
          "POST",
          { password: f.password },
          { Cookie: "" },
        )
      ).status,
      401,
    );
    const cookie = signedInCookie(
      await f.request(
        "/api/login",
        "POST",
        { password: nextPassword },
        { Cookie: "" },
      ),
    );
    assert.equal((await security(f, cookie)).recoveryEnabled, false);
    assert.deepEqual(await f.library.get(f.owner, saved.item.id), {
      item: saved.item,
      source: saved.source,
    });
  }));

test("recovery codes are one-time, replace older codes and require a separate login after reset", () =>
  fixture(async (f) => {
    const saved = await seedLibrary(f),
      access = await seedOAuth(f);
    assert.equal(
      (
        await f.request("/api/recovery-code", "POST", {
          currentPassword: password(),
        })
      ).status,
      401,
    );
    assert.equal((await security(f)).recoveryEnabled, false);
    const first = await f.request("/api/recovery-code", "POST", {
      currentPassword: f.password,
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.deepEqual(Object.keys(firstBody), ["recoveryCode"]);
    assert.match(firstBody.recoveryCode, /^[A-Za-z0-9_-]{43}$/);
    const firstCode = firstBody.recoveryCode as string;
    const metadata = await security(f);
    assert.equal(metadata.recoveryEnabled, true);
    assert.ok(Number.isFinite(Date.parse(metadata.recoveryCreatedAt!)));
    assert.equal(JSON.stringify(metadata).includes(firstCode), false);
    const stored = (
      await f.db.query<{ recovery_hash: string }>(
        "SELECT recovery_hash FROM users WHERE id=$1",
        [f.owner],
      )
    ).rows[0].recovery_hash;
    assert.notEqual(stored, firstCode);
    assert.equal(stored, digest(firstCode));
    const second = await f.request("/api/recovery-code", "POST", {
      currentPassword: f.password,
    });
    const code = (await second.json()).recoveryCode as string;
    assert.notEqual(firstCode, code);
    const nextPassword = password();
    assert.equal(
      (
        await f.request(
          "/api/recover",
          "POST",
          { recoveryCode: firstCode, newPassword: nextPassword },
          { Cookie: "" },
        )
      ).status,
      401,
    );
    const reset = await f.request(
      "/api/recover",
      "POST",
      { recoveryCode: `  ${code}\n`, newPassword: nextPassword },
      { Cookie: "" },
    );
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { ok: true });
    signedOutCookie(reset);
    assert.equal((await f.request("/api/security")).status, 401);
    assert.equal(
      (await f.request("/api/session", "GET", undefined, { Cookie: "" }))
        .status,
      200,
    );
    assert.equal(
      (
        await (
          await f.request("/api/session", "GET", undefined, { Cookie: "" })
        ).json()
      ).authenticated,
      false,
    );
    await noOAuth(f, access);
    assert.equal(
      (
        await f.request(
          "/api/recover",
          "POST",
          { recoveryCode: code, newPassword: password() },
          { Cookie: "" },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await f.request(
          "/api/login",
          "POST",
          { password: f.password },
          { Cookie: "" },
        )
      ).status,
      401,
    );
    const cookie = signedInCookie(
      await f.request(
        "/api/login",
        "POST",
        { password: nextPassword },
        { Cookie: "" },
      ),
    );
    assert.equal((await security(f, cookie)).recoveryEnabled, false);
    assert.equal(
      (await f.library.get(f.owner, saved.item.id)).source.originalText,
      saved.source.originalText,
    );
  }));

test("individual session revocation reauthenticates, enforces ownership and clears only the current cookie", () =>
  fixture(async (f) => {
    const initial = await security(f),
      current = initial.sessions.find((session) => session.current)!;
    const second = await f.auth.session(f.owner);
    const secondId = (await security(f)).sessions.find(
      (session) => !session.current,
    )!.id;
    const other = randomUUID();
    await f.db.query(
      "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$2)",
      [other, "synthetic-unusable-hash"],
    );
    const foreign = await f.auth.session(other);
    const foreignId = (
      await f.db.query<{ id: string }>(
        "SELECT id FROM sessions WHERE hash=$1",
        [digest(foreign)],
      )
    ).rows[0].id;
    assert.equal(
      (
        await f.request(`/api/sessions/${secondId}`, "DELETE", {
          currentPassword: password(),
        })
      ).status,
      401,
    );
    assert.equal(await f.auth.sessionOwner(second), f.owner);
    assert.equal(
      (
        await f.request(`/api/sessions/${foreignId}`, "DELETE", {
          currentPassword: f.password,
        })
      ).status,
      404,
    );
    assert.equal(await f.auth.sessionOwner(foreign), other);
    const removed = await f.request(`/api/sessions/${secondId}`, "DELETE", {
      currentPassword: f.password,
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { signedOut: false });
    assert.equal(removed.headers.has("set-cookie"), false);
    assert.equal(await f.auth.sessionOwner(second), undefined);
    const signedOut = await f.request(`/api/sessions/${current.id}`, "DELETE", {
      currentPassword: f.password,
    });
    assert.equal(signedOut.status, 200);
    assert.deepEqual(await signedOut.json(), { signedOut: true });
    signedOutCookie(signedOut);
    assert.equal((await f.request("/api/security")).status, 401);
  }));

test("sign out everywhere reauthenticates and revokes browser and OAuth access without deleting drops", () =>
  fixture(async (f) => {
    const saved = await seedLibrary(f),
      access = await seedOAuth(f);
    const second = await f.auth.session(f.owner);
    assert.equal(
      (
        await f.request("/api/logout-all", "POST", {
          currentPassword: password(),
        })
      ).status,
      401,
    );
    assert.equal(await f.auth.sessionOwner(second), f.owner);
    const response = await f.request("/api/logout-all", "POST", {
      currentPassword: f.password,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    signedOutCookie(response);
    assert.equal(await f.auth.sessionOwner(second), undefined);
    assert.equal((await f.request("/api/security")).status, 401);
    await noOAuth(f, access);
    const cookie = signedInCookie(
      await f.request(
        "/api/login",
        "POST",
        { password: f.password },
        { Cookie: "" },
      ),
    );
    assert.equal((await security(f, cookie)).sessions.length, 1);
    assert.equal(
      (await f.library.get(f.owner, saved.item.id)).item.notes,
      saved.item.notes,
    );
  }));

test("security mutations share a bounded reauthentication limiter independent of login", () =>
  fixture(async (f) => {
    const currentId = (await security(f)).sessions[0].id;
    for (let attempt = 0; attempt < 10; attempt++) {
      const route = [
        "/api/recovery-code",
        "/api/change-password",
        "/api/logout-all",
        `/api/sessions/${currentId}`,
      ][attempt % 4];
      const response = await f.request(
        route,
        route.includes("/sessions/") ? "DELETE" : "POST",
        {
          currentPassword: password(),
          ...(route.endsWith("change-password")
            ? { newPassword: password() }
            : {}),
        },
      );
      assert.equal(response.status, 401, `attempt ${attempt + 1}`);
    }
    const blocked = await f.request("/api/recovery-code", "POST", {
      currentPassword: f.password,
    });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.has("retry-after"));
    assert.equal((await security(f)).recoveryEnabled, false);
    signedInCookie(
      await f.request(
        "/api/login",
        "POST",
        { password: f.password },
        { Cookie: "" },
      ),
    );
  }));

test("fresh setup requires 15 characters while legacy shorter passwords can still log in", async () => {
  await fixture(async (f) => {
    for (const body of [
      { password: "x".repeat(14) },
      { password: "x".repeat(129) },
      { password: password(), owner: randomUUID() },
    ])
      assert.equal((await f.request("/api/setup", "POST", body)).status, 400);
    signedInCookie(
      await f.request("/api/setup", "POST", { password: password() }),
    );
  }, false);
  await fixture(async (f) => {
    const legacy = randomBytes(6).toString("hex"),
      salt = randomBytes(16).toString("hex"),
      owner = randomUUID();
    const hash = `${salt}:${scryptSync(legacy, salt, 64).toString("hex")}`;
    await f.db.query("INSERT INTO users(id,password_hash) VALUES($1,$2)", [
      owner,
      hash,
    ]);
    const cookie = signedInCookie(
      await f.request("/api/login", "POST", { password: legacy }),
    );
    assert.equal((await security(f, cookie)).sessions.length, 1);
    assert.notEqual(
      (
        await f.db.query<{ password_hash: string }>(
          "SELECT password_hash FROM users WHERE id=$1",
          [owner],
        )
      ).rows[0].password_hash,
      hash,
    );
  }, false);
});

test("public recovery is rate limited with login while authenticated reauthentication remains independent", () =>
  fixture(async (f) => {
    const created = await f.request("/api/recovery-code", "POST", {
      currentPassword: f.password,
    });
    assert.equal(created.status, 200);
    const { recoveryCode } = await created.json();
    for (let attempt = 0; attempt < 10; attempt++)
      assert.equal(
        (
          await f.request(
            "/api/recover",
            "POST",
            {
              recoveryCode: randomBytes(32).toString("base64url"),
              newPassword: password(),
            },
            { Cookie: "" },
          )
        ).status,
        401,
      );
    assert.equal(
      (
        await f.request(
          "/api/recover",
          "POST",
          { recoveryCode, newPassword: password() },
          { Cookie: "" },
        )
      ).status,
      429,
    );
    assert.equal(
      (
        await f.request(
          "/api/login",
          "POST",
          { password: f.password },
          { Cookie: "" },
        )
      ).status,
      429,
    );
    assert.equal(
      (
        await f.request("/api/recovery-code", "POST", {
          currentPassword: f.password,
        })
      ).status,
      200,
    );
    assert.equal((await security(f)).recoveryEnabled, true);
  }));

test("migration preserves legacy sessions and library records with safe metadata defaults", () =>
  fixture(async (f) => {
    const saved = await seedLibrary(f);
    const originalHash = (
      await f.db.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id=$1",
        [f.owner],
      )
    ).rows[0].password_hash;
    await f.db.query("DROP INDEX sessions_owner_seen");
    await f.db.query(
      "ALTER TABLE sessions DROP COLUMN id, DROP COLUMN label, DROP COLUMN created_at, DROP COLUMN last_seen_at",
    );
    await f.db.query(
      "ALTER TABLE users DROP CONSTRAINT users_recovery_state, DROP COLUMN auth_version, DROP COLUMN recovery_hash, DROP COLUMN recovery_created_at",
    );
    await f.db.query("DELETE FROM schema_migrations WHERE version=7");
    await migrate(f.db);
    await migrate(f.db);
    assert.equal(await f.auth.sessionOwner(f.session), f.owner);
    const metadata = await security(f);
    assert.equal(metadata.recoveryEnabled, false);
    assert.equal(metadata.sessions.length, 1);
    assert.equal(metadata.sessions[0].current, true);
    assert.equal(metadata.sessions[0].label, "Existing browser session");
    assert.notEqual(metadata.sessions[0].id, f.session);
    assert.deepEqual(await f.library.get(f.owner, saved.item.id), {
      item: saved.item,
      source: saved.source,
    });
    assert.equal(
      (
        await f.db.query<{ password_hash: string }>(
          "SELECT password_hash FROM users WHERE id=$1",
          [f.owner],
        )
      ).rows[0].password_hash,
      originalHash,
    );
  }));
