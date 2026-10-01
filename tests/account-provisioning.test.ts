import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/app.js";
import { provisionAccount, AccountProvisioningError } from "../server/account-provisioning.js";

test("operator account creation preserves owner data, closed signup, and existing credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drop-it-provision-"));
  const db = await openDatabase({ dataDir: dir });
  try {
    await migrate(db);
    const { auth, library } = createApp(db, {
      port: 4317, origin: "http://localhost:4317", local: true,
      production: false, redirectUris: [], dataDir: dir,
      databaseUrl: undefined, ai: undefined, publicAccounts: true, signupEnabled: false,
    }, "<!doctype html><title>Test</title>");
    const ownerPassword = randomBytes(24).toString("base64url");
    const ownerSession = await auth.setup(ownerPassword);
    const owner = (await auth.sessionOwner(ownerSession))!;
    const item = await library.save(owner, { requestId: randomUUID(), title: "Existing data", source: { originalText: "Synthetic owner data" } });
    const before = (await db.query("SELECT * FROM sessions")).rows;
    const password = randomBytes(24).toString("base64url");
    await provisionAccount(db, "  SAMPLE_User  ", password);
    assert.deepEqual((await db.query("SELECT * FROM sessions")).rows, before);
    assert.equal((await db.query("SELECT * FROM oauth_tokens")).rows.length, 0);
    const row = (await db.query<{password_hash: string; singleton: boolean | null}>("SELECT password_hash,singleton FROM users WHERE username=$1", ["sample_user"])).rows[0];
    assert.notEqual(row.password_hash, password);
    assert.equal(row.singleton, null);
    const session = await auth.login(password, undefined, "sample_user");
    const newOwner = (await auth.sessionOwner(session))!;
    assert.notEqual(newOwner, owner);
    assert.equal((await library.export(newOwner)).items.length, 0);
    await assert.rejects(library.get(newOwner, item.item.id));
    await assert.rejects(auth.register("another", password));
    for (const username of ["sample_USER", "owner", " OWNER ", "../../x", "a", "x".repeat(41)])
      await assert.rejects(provisionAccount(db, username, randomBytes(24).toString("base64url")), AccountProvisioningError);
    for (const invalid of ["short", "x".repeat(129)])
      await assert.rejects(provisionAccount(db, "valid", invalid), AccountProvisioningError);
    assert.equal((await db.query("SELECT id FROM users")).rows.length, 2);
    assert.equal((await db.query<{password_hash: string}>("SELECT password_hash FROM users WHERE username=$1", ["sample_user"])).rows[0].password_hash, row.password_hash);
    assert.equal((await library.get(owner, item.item.id)).item.title, "Existing data");
    assert.equal(await auth.sessionOwner(await auth.login(ownerPassword, undefined, "owner")), owner);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("operator CLI refuses piped credentials and arguments before reading configuration", () => {
  const syntheticSecret = randomBytes(24).toString("base64url");
  for (const args of [[], [syntheticSecret]]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/create-account.ts", ...args], {
      encoding: "utf8", input: syntheticSecret,
      env: { ...process.env, DATABASE_URL: syntheticSecret, PUBLIC_URL: syntheticSecret },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /interactive Render Shell/);
    assert.equal((result.stdout + result.stderr).includes(syntheticSecret), false);
  }
});
