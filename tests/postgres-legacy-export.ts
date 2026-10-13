// Opt-in verification against a disposable PostgreSQL 16 cluster. No hosted
// database, environment files, or existing library data are used.
// Run: node --import tsx tests/postgres-legacy-export.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { migrate } from "../server/db.js";
import { stageLegacyExport } from "../server/export-file.js";
import { Library } from "../server/library.js";
import { postgresFixture } from "./postgres-fixture.js";

const fixture = await postgresFixture();
let staged: Awaited<ReturnType<typeof stageLegacyExport>> | undefined;
try {
  const db = await fixture.create("legacy_export");
  await migrate(db);
  const owner = randomUUID();
  const other = randomUUID();
  for (const id of [owner, other])
    await db.query(
      "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$2)",
      [id, "synthetic-unusable-export-password-hash"],
    );
  const library = new Library(db);
  const bytes = Buffer.from("漢".repeat(44000) + "x");
  const uploaded = await library.upload(
    owner,
    bytes,
    "text/plain",
    "original.txt",
  );
  for (let index = 0; index < 215; index++)
    await library.save(owner, {
      requestId: randomUUID(),
      title: `Synthetic page item ${index}`,
      source:
        index === 0
          ? { attachmentId: uploaded.attachmentId }
          : { originalText: `Original ${index}` },
    });
  await library.save(other, {
    requestId: randomUUID(),
    title: "Private other owner item",
    source: { originalText: "Synthetic other owner text" },
  });
  await db.query("UPDATE items SET created_at=$2::timestamptz WHERE owner=$1", [
    owner,
    "2026-10-13T01:02:03.123456Z",
  ]);
  const expected = await db.query<{ id: string }>(
    "SELECT id FROM items WHERE owner=$1 ORDER BY created_at,id",
    [owner],
  );
  staged = await stageLegacyExport(
    library,
    owner,
    new AbortController().signal,
  );
  assert.equal((await stat(staged.path)).mode & 0o777, 0o600);
  assert.equal((await db.query<{ n: number }>("SELECT 1 AS n")).rows[0].n, 1);
  // Holding the completed file models a download stalled longer than the
  // adapter's 15-second idle transaction timeout. No snapshot remains open.
  await delay(17000);
  assert.equal((await db.query<{ n: number }>("SELECT 1 AS n")).rows[0].n, 1);
  const archive = JSON.parse(await readFile(staged.path, "utf8")) as {
    version: number;
    items: { id: string; title: string }[];
    sources: { fileBase64: string | null }[];
  };
  assert.equal(archive.version, 2);
  assert.deepEqual(
    archive.items.map((item) => item.id),
    expected.rows.map((item) => item.id),
  );
  assert.equal(archive.items.length, 215);
  assert.equal(archive.sources.length, 215);
  assert.ok(
    archive.items.every((item) => item.title !== "Private other owner item"),
  );
  assert.deepEqual(
    Buffer.from(
      archive.sources.find((source) => source.fileBase64)!.fileBase64!,
      "base64",
    ),
    bytes,
  );
  const path = staged.path;
  await staged.dispose();
  staged = undefined;
  await assert.rejects(stat(path), { code: "ENOENT" });
  console.log(
    "PASS: PostgreSQL legacy export preserves pagination, exact original bytes and owner isolation after a 17-second download stall; temporary output removed.",
  );
} finally {
  try {
    await staged?.dispose();
  } finally {
    await fixture.close();
  }
}
