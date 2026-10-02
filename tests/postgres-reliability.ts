// Opt-in real PostgreSQL interruption test; never loads .env or existing data.
// Run: node --import tsx tests/postgres-reliability.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { Library } from "../server/library.js";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);
const root = await mkdtemp("/private/tmp/drop-it-pg-reliability-");
await chmod(root, 0o700);
const cluster = join(root, "cluster"),
  socket = join(root, "socket");
await mkdir(socket, { mode: 0o700 });
const binary = (name: string) => `/opt/homebrew/bin/${name}`;
let db: Database | undefined;
async function start() {
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
      `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p 55433 -c max_connections=8 -c shared_buffers=16MB -c log_statement=none -c log_min_error_statement=panic -c log_error_verbosity=terse`,
    ],
    { timeout: 25000 },
  );
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
      "--username=synthetic_audit",
      "--auth-local=trust",
      "--auth-host=reject",
      "--no-locale",
      "--encoding=UTF8",
    ],
    { timeout: 30000 },
  );
  await start();
  const url = new URL("postgresql://synthetic_audit@localhost:55433/postgres");
  url.searchParams.set("host", socket);
  db = await openDatabase({ dataDir: root, databaseUrl: url.href });
  await migrate(db);
  const owner = randomUUID(),
    lib = new Library(db);
  await db.query(
    "INSERT INTO users(id,password_hash) VALUES($1,'synthetic-unusable-hash')",
    [owner],
  );
  const item = await lib.save(owner, {
    requestId: randomUUID(),
    title: "Interruption fixture",
    source: { originalText: "Synthetic recovery data" },
  });
  await db.query("SELECT 1");
  await stop();
  const before = Date.now();
  await assert.rejects(db.query("SELECT 1"));
  assert.ok(
    Date.now() - before < 6000,
    "Acquisition failure must remain bounded",
  );
  console.log(
    "PASS: idle database disconnect was handled; work failed within acquisition budget",
  );
  await start();
  assert.equal(
    (await lib.get(owner, item.item.id)).source.originalText,
    "Synthetic recovery data",
  );
  console.log(
    "PASS: the same application pool reconnected and read preserved synthetic data",
  );
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const locked = new Promise<void>((r) => {
    entered = r;
  });
  const transaction = db.transaction(async (tx) => {
    await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
    entered();
    await hold;
  });
  await locked;
  const lockStart = Date.now();
  try {
    await assert.rejects(
      db.transaction(async (tx) =>
        tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]),
      ),
      (error: unknown) => (error as { code?: string }).code === "55P03",
    );
    assert.ok(Date.now() - lockStart < 7000, "Lock wait must remain bounded");
  } finally {
    release();
    await transaction;
  }
  await db.query("SELECT 1");
  console.log(
    "PASS: lock timeout rolled back and returned a usable pool connection",
  );
} finally {
  try {
    await db?.close();
    await stop();
  } finally {
    if (!existsSync(join(cluster, "postmaster.pid")))
      await rm(root, { recursive: true, force: true });
  }
}
console.log(
  "PostgreSQL reliability: 3/3 passed; temporary cluster stopped and removed.",
);
