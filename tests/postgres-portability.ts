// Opt-in PostgreSQL 16 portability, contention and actual process-crash tests.
// Run: node --import tsx tests/postgres-portability.ts
// Only a newly created private /private/tmp cluster and synthetic fixtures are used.
import assert from "node:assert/strict";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  chmod,
  rm,
  writeFile,
  readdir,
  stat,
  utimes,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { Library } from "../server/library.js";
import { Portability } from "../server/portability.js";
import { archiveChunkBytes, previewLifetimeMs } from "../shared/portable.js";
import { AppError } from "../server/errors.js";

const run = promisify(execFile);
const root = await mkdtemp("/private/tmp/drop-it-pg-portability-");
await chmod(root, 0o700);
const cluster = join(root, "cluster"),
  socket = join(root, "socket"),
  staging = join(root, "parent-staging");
await Promise.all([
  mkdir(socket, { mode: 0o700 }),
  mkdir(staging, { mode: 0o700 }),
]);
const previousTmpdir = process.env.TMPDIR;
process.env.TMPDIR = staging;
const binary = (name: string) => `/opt/homebrew/bin/${name}`;
let db: Database | undefined, portability: Portability | undefined;
const children = new Set<ChildProcess>();
let checks = 0;
const pass = (label: string) => {
  checks++;
  console.log(`PASS: ${label}`);
};
const input = async function* (text: string) {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += 4093)
    yield bytes.subarray(offset, offset + 4093);
};
type Message = {
  type: string;
  previewId?: string;
  recoveredRequestId?: string;
  imported?: number;
  replayed?: boolean;
  [key: string]: unknown;
};
function worker(args: object, temporaryDirectory: string) {
  const child = fork(
    fileURLToPath(new URL("./postgres-portability-worker.ts", import.meta.url)),
    [],
    {
      execArgv: ["--import", "tsx"],
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      env: {
        PATH: process.env.PATH ?? "",
        TMPDIR: temporaryDirectory,
        NODE_ENV: "test",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  children.add(child);
  const messages: Message[] = [];
  let notify = () => {},
    ended = false,
    failure = "",
    stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-3000);
  });
  child.on("message", (message: Message) => {
    messages.push(message);
    notify();
  });
  child.on("error", () => {
    failure = "Worker process could not start";
    notify();
  });
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("exit", (code, signal) => {
      ended = true;
      children.delete(child);
      notify();
      resolve({ code, signal });
    });
  });
  child.send(args);
  return {
    child,
    exit,
    async wait(type: string, budget = 25000) {
      const deadline = Date.now() + budget;
      while (true) {
        const message = messages.find((message) => message.type === type);
        if (message) return message;
        assert.ok(
          !failure && !messages.some((message) => message.type === "failure"),
          failure || "Synthetic worker reported failure",
        );
        assert.ok(!ended, `Worker exited before ${type}; ${stderr}`);
        assert.ok(
          Date.now() < deadline,
          `Worker did not reach ${type} within its bounded budget`,
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
          notify = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    },
  };
}
async function owner() {
  const id = randomUUID();
  await db!.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,'synthetic-unusable-hash')",
    [id],
  );
  return id;
}
async function counts(id: string) {
  const result: number[] = [];
  for (const table of [
    "items",
    "sources",
    "attachments",
    "portability_imports",
  ] as const) {
    const row = await db!.query<{ count: string }>(
      `SELECT count(*) FROM ${table} WHERE owner=$1`,
      [id],
    );
    result.push(Number(row.rows[0].count));
  }
  return result;
}
async function archive(id: string, manager = portability!) {
  const lines: string[] = [];
  await manager.export(id, async (line) => {
    lines.push(line);
  });
  return lines.join("");
}
async function stop() {
  if (existsSync(join(cluster, "postmaster.pid")))
    await run(
      binary("pg_ctl"),
      ["-D", cluster, "stop", "-m", "fast", "-w", "-t", "20"],
      { timeout: 25000 },
    );
}
try {
  await run(
    binary("initdb"),
    [
      "-D",
      cluster,
      "--username=synthetic_portability",
      "--auth-local=trust",
      "--auth-host=reject",
      "--no-locale",
      "--encoding=UTF8",
    ],
    { timeout: 30000 },
  );
  await run(
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
      `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p 55434 -c max_connections=12 -c shared_buffers=16MB -c log_statement=none -c log_min_error_statement=panic -c log_error_verbosity=terse`,
    ],
    { timeout: 25000 },
  );
  const url = new URL(
    "postgresql://synthetic_portability@localhost:55434/postgres",
  );
  url.searchParams.set("host", socket);
  db = await openDatabase({ dataDir: root, databaseUrl: url.href });
  await migrate(db);
  const library = new Library(db);
  portability = new Portability(db);
  const from = await owner(),
    to = await owner();
  const bytes = Buffer.from("Synthetic original \n" + "漢字 ".repeat(10000));
  const upload = await library.upload(
    from,
    bytes,
    "text/plain",
    "synthetic.txt",
  );
  const first = await library.save(from, {
    requestId: randomUUID(),
    title: "Synthetic preserved source",
    tags: ["archive"],
    notes: "Synthetic note",
    source: {
      originalText: "Immutable original transcription",
      url: "https://example.com/guide#installation",
      attachmentId: upload.attachmentId,
    },
  });
  const reviewed = await library.update(from, {
    id: first.item.id,
    revision: first.item.revision,
    isSaved: true,
    reviewedTranscription: "Reviewed synthetic correction",
  });
  const second = await library.save(from, {
    requestId: randomUUID(),
    title: "Second drop sharing original",
    sourceId: first.source.id,
  });
  await library.delete(from, {
    id: second.item.id,
    revision: second.item.revision,
  });
  const encoded = await archive(from);
  const records = encoded
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.filter((record) => record.type === "file").length, 1);
  assert.ok(records.filter((record) => record.type === "chunk").length > 1);
  assert.ok(
    records
      .filter((record) => record.type === "chunk")
      .every(
        (record) =>
          Buffer.from(record.data, "base64").length <= archiveChunkBytes,
      ),
  );
  const preview = await portability.preview(to, input(encoded), "ndjson");
  assert.deepEqual(await counts(to), [0, 0, 0, 0]);
  assert.equal(
    (
      await portability.apply(to, {
        previewId: preview.previewId,
        requestId: preview.requestId,
        confirm: true,
      })
    ).imported,
    2,
  );
  assert.deepEqual(await counts(to), [2, 1, 1, 1]);
  const live = await library.search(to, { mode: "keyword" });
  const trash = await library.search(to, { mode: "keyword", view: "Trash" });
  assert.equal(live.total, 1);
  assert.equal(trash.total, 1);
  const restored = await library.get(to, live.items[0].id);
  assert.notEqual(restored.item.id, first.item.id);
  assert.notEqual(restored.source.id, first.source.id);
  assert.equal(restored.source.id, trash.items[0].sourceId);
  assert.equal(restored.source.url, first.source.url);
  assert.equal(restored.source.originalText, first.source.originalText);
  assert.equal(
    restored.item.reviewedTranscription,
    reviewed.item.reviewedTranscription,
  );
  assert.equal(restored.item.isSaved, true);
  assert.equal(restored.item.revision, reviewed.item.revision);
  assert.equal(
    new Date(restored.item.createdAt).toISOString(),
    new Date(reviewed.item.createdAt).toISOString(),
  );
  assert.equal(
    new Date(restored.item.transcriptionUpdatedAt!).toISOString(),
    new Date(reviewed.item.transcriptionUpdatedAt!).toISOString(),
  );
  assert.deepEqual((await library.file(to, restored.source.id)).bytes, bytes);
  await assert.rejects(
    library.get(from, restored.item.id),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  pass(
    "real PostgreSQL roundtrip preserves shared bytes, owner isolation, fragments, reviewed text, dates, revisions, bookmarks and Trash",
  );

  const smallOwner = await owner(),
    importOwner = await owner(),
    uploadOwner = await owner();
  const smallUpload = await library.upload(
    smallOwner,
    Buffer.from("sixsix"),
    "text/plain",
    "six.txt",
  );
  await library.save(smallOwner, {
    requestId: randomUUID(),
    title: "Capacity fixture",
    source: { originalText: "sixsix", attachmentId: smallUpload.attachmentId },
  });
  const smallArchive = await archive(smallOwner);
  const baseline = Number(
    (
      await db.query<{ bytes: string }>(
        "SELECT COALESCE(sum(octet_length(bytes)),0) AS bytes FROM attachments",
      )
    ).rows[0].bytes,
  );
  const serviceAttachmentBytes = baseline + 10;
  const bounded = new Portability(db, { serviceAttachmentBytes });
  const limited = new Library(db, undefined, { serviceAttachmentBytes });
  try {
    const p = await bounded.preview(importOwner, input(smallArchive), "ndjson");
    const results = await Promise.allSettled([
      bounded.apply(importOwner, {
        previewId: p.previewId,
        requestId: p.requestId,
        confirm: true,
      }),
      limited.upload(
        uploadOwner,
        Buffer.from("sixsix"),
        "text/plain",
        "six.txt",
      ),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejection = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    assert.ok(
      rejection.reason instanceof AppError &&
        ["IMPORT_LIMIT", "SERVICE_CAPACITY"].includes(rejection.reason.code),
    );
    assert.equal(
      Number(
        (
          await db.query<{ bytes: string }>(
            "SELECT sum(octet_length(bytes)) AS bytes FROM attachments",
          )
        ).rows[0].bytes,
      ),
      baseline + 6,
    );
    assert.deepEqual(
      await counts(importOwner),
      results[0].status === "fulfilled" ? [1, 1, 1, 1] : [0, 0, 0, 0],
    );
    assert.deepEqual(
      await counts(uploadOwner),
      results[1].status === "fulfilled" ? [0, 0, 1, 0] : [0, 0, 0, 0],
    );
  } finally {
    await bounded.close();
  }
  pass(
    "simultaneous real PostgreSQL import/upload serializes service capacity and leaves no partial failed import",
  );

  const archivePath = join(root, "synthetic-archive.ndjson");
  await writeFile(archivePath, smallArchive, { mode: 0o600 });
  const slowStaging = join(root, "slow-staging");
  await mkdir(slowStaging, { mode: 0o700 });
  const slow = worker(
    { mode: "slow-export", databaseUrl: url.href, owner: from, archivePath },
    slowStaging,
  );
  await slow.wait("paused");
  const slowResult = await slow.wait("result");
  assert.deepEqual(slowResult, {
    type: "result",
    rejected: true,
    noCompletionMarker: true,
    poolRecovered: true,
    exportSlotRecovered: true,
  });
  assert.equal((await slow.exit).code, 0);
  pass(
    "17-second export stall aborts without an end marker; actual application child survives and pool/export slot recover",
  );

  for (const mode of ["before-commit", "after-commit"] as const) {
    const crashOwner = await owner(),
      crashStaging = join(root, mode);
    await mkdir(crashStaging, { mode: 0o700 });
    const processArgs = {
      databaseUrl: url.href,
      owner: crashOwner,
      archivePath,
    };
    const crashed = worker({ ...processArgs, mode }, crashStaging);
    const p = await crashed.wait("preview");
    await crashed.wait("crash-point");
    crashed.child.kill("SIGKILL");
    assert.equal((await crashed.exit).signal, "SIGKILL");
    const committed = mode === "after-commit";
    assert.deepEqual(
      await counts(crashOwner),
      committed ? [1, 1, 1, 1] : [0, 0, 0, 0],
    );
    const entries = await readdir(crashStaging);
    const abandoned = entries.filter((name) =>
      /^drop-it-import-[A-Za-z0-9]{6}$/.test(name),
    );
    const unrelated = entries
      .filter((name) => !abandoned.includes(name))
      .sort();
    assert.equal(abandoned.length, 1);
    assert.match(abandoned[0], /^drop-it-import-[A-Za-z0-9]{6}$/);
    const directory = join(crashStaging, abandoned[0]);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    for (const file of files)
      assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
    // Advance only the abandoned synthetic directory's age; the process crash,
    // database commit boundaries and restart are real, without a 20-minute wait.
    const old = new Date(Date.now() - previewLifetimeMs - 5 * 60000 - 1000);
    await utimes(directory, old, old);
    const recovered = worker(
      { ...processArgs, mode: "recover", previewId: p.previewId, committed },
      crashStaging,
    );
    const result = await recovered.wait("result");
    assert.equal(result.imported, 1);
    assert.equal(result.replayed, committed);
    assert.equal((await recovered.exit).code, 0);
    assert.deepEqual(await counts(crashOwner), [1, 1, 1, 1]);
    assert.deepEqual(
      (await readdir(crashStaging)).sort(),
      unrelated,
      "cleanup removes only stale import staging and preserves unrelated runtime temporary files",
    );
    // A further independent process confirms the receipt after both recovery
    // paths, without the original manager, staged files or response in memory.
    const replay = worker(
      {
        ...processArgs,
        mode: "recover",
        previewId: result.recoveredRequestId,
        committed: true,
      },
      crashStaging,
    );
    assert.equal((await replay.wait("result")).replayed, true);
    assert.equal((await replay.exit).code, 0);
    assert.deepEqual(await counts(crashOwner), [1, 1, 1, 1]);
    pass(
      `SIGKILL ${mode}: correct atomic outcome, private stale staging removed and durable receipt prevents duplicate imports across process restarts`,
    );
  }
} finally {
  for (const child of children) child.kill("SIGKILL");
  try {
    await portability?.close();
    await db?.close();
    await stop();
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    if (!existsSync(join(cluster, "postmaster.pid")))
      await rm(root, { recursive: true, force: true });
  }
}
console.log(
  `PostgreSQL portability: ${checks}/5 passed; temporary cluster and synthetic staging stopped and removed.`,
);
