// Opt-in bounded resource smoke test: run only in a disposable Linux container.
// No environment files, real accounts, external providers or hosted databases.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { postgresFixture } from "./postgres-fixture.js";
import { migrate, openDatabase } from "../server/db.js";
import { Library } from "../server/library.js";
import { Portability } from "../server/portability.js";
import { stageLegacyExport } from "../server/export-file.js";
import { thumbnail } from "../server/thumbnails.js";

assert.equal(
  process.platform,
  "linux",
  "Use the isolated Linux release container",
);
const memoryLimit = Number(await readFile("/sys/fs/cgroup/memory.max", "utf8"));
assert.ok(
  memoryLimit > 0 && memoryLimit <= 2 * 1024 ** 3,
  "Cap this smoke container at 2 GiB",
);
// An internal-only Docker DB can be separated from the app's memory/CPU cgroup
// to match Render's separately provisioned application and PostgreSQL plans.
// Never accept DATABASE_URL or an arbitrary hosted destination in this runner.
let fixture: Pick<
  Awaited<ReturnType<typeof postgresFixture>>,
  "create" | "close"
>;
const fixtureUrl = process.env.DROP_IT_RELEASE_DATABASE_URL;
if (fixtureUrl) {
  const url = new URL(fixtureUrl);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "drop-it-resource-db");
  assert.equal(url.username, "synthetic_resource_app");
  assert.equal(url.pathname, "/drop_it_resource_fixture");
  assert.equal(url.port, "");
  assert.equal(url.password + url.search + url.hash, "");
  const db = await openDatabase({ dataDir: tmpdir(), databaseUrl: fixtureUrl });
  fixture = { create: async () => db, close: () => db.close() };
} else fixture = await postgresFixture();
let manager: Portability | undefined;
let staged: Awaited<ReturnType<typeof stageLegacyExport>> | undefined;
let release = () => {};
const controller = new AbortController();
let held: Promise<void> | undefined;
const stagedDirectories = async () =>
  (await readdir(tmpdir())).filter((name) =>
    /^drop-it-legacy-export-[A-Za-z0-9]{6}$/.test(name),
  );
const before = await stagedDirectories();
try {
  const db = await fixture.create("resources");
  await migrate(db);
  const [a, b] = [randomUUID(), randomUUID()];
  for (const owner of [a, b])
    await db.query(
      "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,'synthetic-unusable-hash')",
      [owner],
    );
  const library = new Library(db, {
    async draft() {
      return {
        title: "Synthetic resource draft",
        summary: "Synthetic",
        category: "Testing",
        tags: [],
        extractedText: "",
        sourceUrl: "",
      };
    },
    async embed() {
      return [];
    },
  });
  manager = new Portability(db);
  const large = await sharp({
    create: { width: 6000, height: 4000, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const [uploadA, uploadB] = await Promise.all(
    [a, b].map((owner) =>
      library.upload(owner, large, "image/png", "synthetic-24mp.png"),
    ),
  );
  // Concurrent drafts and queued thumbnails all traverse the shared decode gate.
  const mixed = await Promise.allSettled([
    library.draft(a, { source: { attachmentId: uploadA.attachmentId } }),
    library.draft(b, { source: { attachmentId: uploadB.attachmentId } }),
    ...Array.from({ length: 8 }, () => thumbnail(large)),
  ]);
  for (const result of mixed)
    if (result.status === "rejected")
      assert.equal((result.reason as { code?: string }).code, "FILE_BUSY");
  // A draft may be rejected while thumbnail jobs own the two shared slots.
  // Both owners must be able to retry once the bounded batch drains.
  for (const [owner, upload] of [
    [a, uploadA],
    [b, uploadB],
  ] as const)
    assert.equal(
      (
        await library.draft(owner, {
          source: { attachmentId: upload.attachmentId },
        })
      ).draft.title,
      "Synthetic resource draft",
    );
  console.log(
    "PASS: concurrent 24MP uploads/drafts and eight thumbnails within the shared decode gate",
  );

  const original = await sharp(randomBytes(1700 * 1700 * 3), {
    raw: { width: 1700, height: 1700, channels: 3 },
  })
    .png()
    .toBuffer();
  const attachmentA = await library.upload(
    a,
    original,
    "image/png",
    "synthetic-noise.png",
  );
  const attachmentB = await library.upload(
    b,
    original,
    "image/png",
    "synthetic-noise.png",
  );
  for (let i = 0; i < 3; i++)
    await library.save(a, {
      requestId: randomUUID(),
      title: `Synthetic archive source ${i}`,
      allowDuplicate: true,
      source: {
        originalText: `Synthetic ${i}`,
        attachmentId: attachmentA.attachmentId,
      },
    });
  await library.save(b, {
    requestId: randomUUID(),
    title: "Synthetic B archive",
    source: {
      originalText: "Synthetic B",
      attachmentId: attachmentB.attachmentId,
    },
  });

  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  held = manager.export(
    a,
    async () => {
      started();
      await gate;
    },
    controller.signal,
  );
  const rejected = assert.rejects(held, { name: "AbortError" });
  await ready;
  await assert.rejects(
    manager.export(a, async () => {}),
    { code: "EXPORT_BUSY" },
  );
  staged = await stageLegacyExport(library, a, AbortSignal.timeout(60000));
  let stagingBytes = 0;
  for (const directory of await stagedDirectories()) {
    assert.equal((await stat(join(tmpdir(), directory))).mode & 0o777, 0o700);
    const file = await stat(join(tmpdir(), directory, "library.json"));
    assert.equal(file.mode & 0o777, 0o600);
    stagingBytes += file.size;
  }
  const hash = createHash("sha256");
  let records = 0;
  const startedB = performance.now();
  await manager.export(b, async (line) => {
    const row = JSON.parse(line);
    if (row.type === "end") {
      assert.equal(row.sha256, hash.digest("hex"));
      assert.equal(row.items, 1);
      assert.equal(row.files, 1);
    } else hash.update(line);
    records++;
  });
  const ownerBMs = Math.round(performance.now() - startedB);
  controller.abort();
  release();
  await rejected;
  await staged.dispose();
  staged = undefined;
  assert.deepEqual(await stagedDirectories(), before);
  assert.equal((await library.search(a, {})).total, 3);
  assert.equal((await library.search(b, {})).total, 1);
  const events = await readFile("/sys/fs/cgroup/memory.events", "utf8");
  assert.match(events, /^oom_kill 0$/m);
  const peak = Number(await readFile("/sys/fs/cgroup/memory.peak", "utf8"));
  assert.ok(peak < memoryLimit);
  console.log(
    JSON.stringify({
      result: "PASS",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      memoryLimitMiB: memoryLimit / 1024 ** 2,
      peakContainerMiB: Math.round(peak / 1024 ** 2),
      maxNodeRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
      stagingMiB: Math.round(stagingBytes / 1024 ** 2),
      ownerBMs,
      records,
      stagingCleaned: true,
      oomKills: 0,
    }),
  );
} finally {
  controller.abort();
  release();
  await held?.catch(() => {});
  await staged?.dispose();
  await manager?.close();
  await fixture.close();
}
