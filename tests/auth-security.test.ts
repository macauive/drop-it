import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Auth, hashPassword } from "../server/auth.js";
import { openDatabase, migrate, type Database } from "../server/db.js";
import type { Config } from "../server/config.js";
import { cleanupExpired } from "../server/maintenance.js";
import { digest } from "../server/library.js";
import { AppError } from "../server/errors.js";

let db: Database, auth: Auth, dir: string, owner: string;
let client: OAuthClientInformationFull;
const origin = "http://localhost:4317";
const resource = new URL(`${origin}/mcp`);
const password = randomBytes(24).toString("base64url");

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "drop-it-auth-security-"));
  db = await openDatabase({ dataDir: dir });
  await migrate(db);
  const config: Config = {
    origin,
    port: 4317,
    local: true,
    redirectUris: [`${origin}/callback`],
    dataDir: dir,
    databaseUrl: undefined,
    production: false,
    ai: undefined,
  };
  auth = new Auth(db, config);
  owner = (await auth.sessionOwner(await auth.setup(password)))!;
  client = await auth.clientsStore.registerClient({
    redirect_uris: config.redirectUris,
    token_endpoint_auth_method: "none",
    client_name: "Synthetic security test",
  });
});

after(async () => {
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function approvedCode(scopes = ["library:read", "library:write"]) {
  const verifier = randomBytes(32).toString("base64url");
  let location = "";
  await auth.authorize(
    client,
    {
      redirectUri: client.redirect_uris[0],
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      scopes,
      resource,
    },
    {
      redirect: (url: string) => {
        location = url;
      },
    } as Response,
  );
  const pending = new URL(location).searchParams.get("authorize")!;
  const consent = await auth.consent(owner, pending, true);
  const code = new URL(consent.redirect).searchParams.get("code")!;
  return { code, verifier };
}

async function tokens(scopes?: string[]) {
  const { code, verifier } = await approvedCode(scopes);
  return auth.exchangeAuthorizationCode(
    client,
    code,
    verifier,
    client.redirect_uris[0],
    resource,
  );
}

test("reusing a rotated refresh token revokes the successor token family", async () => {
  const first = await tokens();
  const successor = await auth.exchangeRefreshToken(
    client,
    first.refresh_token,
    undefined,
    resource,
  );
  assert.equal(
    (await auth.verifyAccessToken(successor.access_token)).extra.owner,
    owner,
  );
  await assert.rejects(
    auth.exchangeRefreshToken(client, first.refresh_token, undefined, resource),
  );
  await assert.rejects(auth.verifyAccessToken(successor.access_token));
  await assert.rejects(
    auth.exchangeRefreshToken(
      client,
      successor.refresh_token,
      undefined,
      resource,
    ),
  );
});

test("disconnecting revokes both tokens and previously approved authorization codes", async () => {
  const issued = await tokens();
  const { code, verifier } = await approvedCode();
  await auth.revokeAll(owner);
  await assert.rejects(auth.verifyAccessToken(issued.access_token));
  await assert.rejects(
    auth.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
      resource,
    ),
  );
  assert.equal(await auth.sessionOwner(await auth.login(password)), owner);
});

test("concurrent refresh replay cannot leave a usable successor", async () => {
  const first = await tokens();
  const exchanges = await Promise.allSettled([
    auth.exchangeRefreshToken(client, first.refresh_token, undefined, resource),
    auth.exchangeRefreshToken(client, first.refresh_token, undefined, resource),
  ]);
  assert.equal(
    exchanges.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  assert.equal(
    exchanges.filter((entry) => entry.status === "rejected").length,
    1,
  );
  for (const exchange of exchanges) {
    if (exchange.status === "fulfilled")
      await assert.rejects(auth.verifyAccessToken(exchange.value.access_token));
  }
});

test("incorrect clients, resources and escalated scopes cannot consume a valid refresh token", async () => {
  const first = await tokens(["library:read"]);
  const wrongClient = await auth.clientsStore.registerClient({
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: "none",
  });
  await assert.rejects(
    auth.exchangeRefreshToken(
      wrongClient,
      first.refresh_token,
      undefined,
      resource,
    ),
  );
  await assert.rejects(
    auth.exchangeRefreshToken(
      client,
      first.refresh_token,
      undefined,
      new URL("https://other.example/mcp"),
    ),
  );
  await assert.rejects(
    auth.exchangeRefreshToken(
      client,
      first.refresh_token,
      ["library:write"],
      resource,
    ),
  );
  const successor = await auth.exchangeRefreshToken(
    client,
    first.refresh_token,
    undefined,
    resource,
  );
  assert.deepEqual(
    (await auth.verifyAccessToken(successor.access_token)).scopes,
    ["library:read"],
  );
  await auth.revokeToken(wrongClient, { token: successor.refresh_token });
  assert.equal(
    (await auth.verifyAccessToken(successor.access_token)).extra.owner,
    owner,
  );
  await auth.revokeToken(client, { token: first.refresh_token });
  await assert.rejects(auth.verifyAccessToken(successor.access_token));
});

test("cleanup preserves old replay evidence while a refresh family is active", async () => {
  const first = await tokens();
  const successor = await auth.exchangeRefreshToken(
    client,
    first.refresh_token,
    undefined,
    resource,
  );
  await db.query(
    "UPDATE oauth_tokens SET expires_at=now()-interval '1 day' WHERE hash=$1",
    [digest(first.refresh_token)],
  );
  await cleanupExpired(db);
  assert.equal(
    (
      await db.query("SELECT hash FROM oauth_tokens WHERE hash=$1", [
        digest(first.refresh_token),
      ])
    ).rows.length,
    1,
  );
  await assert.rejects(
    auth.exchangeRefreshToken(client, first.refresh_token, undefined, resource),
  );
  await assert.rejects(auth.verifyAccessToken(successor.access_token));

  const expired = await tokens();
  await auth.exchangeRefreshToken(
    client,
    expired.refresh_token,
    undefined,
    resource,
  );
  const family = (
    await db.query<{ family: string }>(
      "SELECT family FROM oauth_tokens WHERE hash=$1",
      [digest(expired.refresh_token)],
    )
  ).rows[0].family;
  await db.query(
    "UPDATE oauth_tokens SET expires_at=now()-interval '1 day' WHERE family=$1",
    [family],
  );
  await cleanupExpired(db);
  assert.equal(
    (await db.query("SELECT hash FROM oauth_tokens WHERE family=$1", [family]))
      .rows.length,
    0,
  );
});

test("revocation is scoped to its owner and serializes with code exchange", async () => {
  const other = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$2)",
    [other, "synthetic-unusable-hash"],
  );
  const otherCode = randomBytes(32).toString("base64url");
  const otherToken = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO oauth_codes(hash,owner,client_id,params,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 minute')",
    [digest(otherCode), other, client.client_id, JSON.stringify({})],
  );
  await db.query(
    "INSERT INTO oauth_tokens(hash,family,owner,client_id,kind,scopes,resource,expires_at) VALUES($1,$2,$3,$4,'access',$5,$6,now()+interval '1 hour')",
    [
      digest(otherToken),
      randomUUID(),
      other,
      client.client_id,
      ["library:read"],
      resource.href,
    ],
  );
  const { code, verifier } = await approvedCode();
  const exchange = auth.exchangeAuthorizationCode(
    client,
    code,
    verifier,
    client.redirect_uris[0],
    resource,
  );
  const [result] = await Promise.allSettled([exchange, auth.revokeAll(owner)]);
  if (result.status === "fulfilled")
    await assert.rejects(auth.verifyAccessToken(result.value.access_token));
  assert.equal(
    (await db.query("SELECT hash FROM oauth_codes WHERE owner=$1", [owner]))
      .rows.length,
    0,
  );
  assert.equal(
    (await db.query("SELECT hash FROM oauth_tokens WHERE owner=$1", [owner]))
      .rows.length,
    0,
  );
  assert.equal(
    (await db.query("SELECT hash FROM oauth_codes WHERE owner=$1", [other]))
      .rows.length,
    1,
  );
  assert.equal((await auth.verifyAccessToken(otherToken)).extra.owner, other);
  await auth.revokeAll(other);
  await db.query("DELETE FROM users WHERE id=$1", [other]);
});

test("password, expired sessions, logout and stored token hashes fail closed", async () => {
  await assert.rejects(auth.login(randomBytes(24).toString("base64url")));
  const session = await auth.login(password);
  assert.equal(await auth.sessionOwner(session), owner);
  assert.equal(await auth.sessionOwner(digest(session)), undefined);
  assert.equal(await auth.sessionOwner({ token: session }), undefined);
  assert.equal(await auth.sessionOwner("x".repeat(101)), undefined);
  await db.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE hash=$1",
    [digest(session)],
  );
  assert.equal(await auth.sessionOwner(session), undefined);
  const fresh = await auth.login(password);
  await auth.logout(fresh);
  assert.equal(await auth.sessionOwner(fresh), undefined);
  const issued = await tokens();
  await assert.rejects(auth.verifyAccessToken(digest(issued.access_token)));
});

const versionedHashPattern =
  /^scrypt\$1\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/;

async function storedPassword() {
  return (
    await db.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id=$1",
      [owner],
    )
  ).rows[0].password_hash;
}

test("new passwords use unique salts and the explicit versioned scrypt profile", async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, versionedHashPattern);
  assert.match(second, versionedHashPattern);
  assert.notEqual(first, second);
  const fields = first.split("$");
  const independent = scryptSync(password, fields[5], 64, {
    N: 32768,
    r: 8,
    p: 3,
    maxmem: 64 * 1024 * 1024,
  });
  assert.equal(independent.toString("hex"), fields[6]);
  assert.match(await storedPassword(), versionedHashPattern);
});

test("legacy passwords upgrade only after successful login and remain usable", async () => {
  const original = await storedPassword();
  const salt = randomBytes(16).toString("hex");
  const legacy = `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
  await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
    legacy,
    owner,
  ]);
  try {
    await assert.rejects(auth.login(randomBytes(24).toString("base64url")), {
      code: "LOGIN_FAILED",
    });
    assert.equal(await storedPassword(), legacy);
    assert.equal(await auth.sessionOwner(await auth.login(password)), owner);
    const upgraded = await storedPassword();
    assert.match(upgraded, versionedHashPattern);
    assert.equal(await auth.sessionOwner(await auth.login(password)), owner);
    assert.equal(await storedPassword(), upgraded);
  } finally {
    await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
      original,
      owner,
    ]);
  }
});

test("malformed hashes and unrecognized work factors fail without derivation or disclosure", async () => {
  const original = await storedPassword();
  try {
    for (const malformed of [
      "not-a-password-hash",
      original.replace("$32768$", "$1073741824$"),
      original.replace("$1$", "$999$"),
      `${original}$extra`,
      `${"a".repeat(32)}:${"z".repeat(128)}`,
    ]) {
      await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
        malformed,
        owner,
      ]);
      await assert.rejects(auth.login(password), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.status, 401);
        assert.equal(error.code, "LOGIN_FAILED");
        assert.equal(error.message, "The password was not accepted.");
        return true;
      });
      assert.equal(await storedPassword(), malformed);
    }
  } finally {
    await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
      original,
      owner,
    ]);
  }
});

test("password hashing has bounded concurrency and a bounded queue that recovers", async () => {
  const requests = Array.from({ length: 11 }, () => hashPassword(password));
  const results = await Promise.allSettled(requests);
  assert.equal(
    results.filter((entry) => entry.status === "fulfilled").length,
    10,
  );
  const failures = results.filter((entry) => entry.status === "rejected");
  assert.equal(failures.length, 1);
  assert.ok(failures[0].reason instanceof AppError);
  assert.equal(failures[0].reason.status, 503);
  assert.equal(failures[0].reason.code, "AUTH_BUSY");
  assert.equal(failures[0].reason.message.includes(password), false);
  assert.match(await hashPassword(password), versionedHashPattern);
});
