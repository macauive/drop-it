// Opt-in real PostgreSQL ChatGPT token concurrency verification; never loads .env or existing data.
// Run: node --import tsx tests/postgres-chatgpt.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { Auth } from "../server/auth.js";
import { ChatGPT } from "../server/chatgpt.js";
import { AppError } from "../server/errors.js";
import { chatgptFixture } from "./chatgpt-fixture.js";
import { setTimeout as delay } from "node:timers/promises";

const run = promisify(execFile);
const root = await mkdtemp("/private/tmp/drop-it-pg-chatgpt-");
await chmod(root, 0o700);
const cluster = join(root, "cluster"),
  socket = join(root, "socket");
await mkdir(socket, { mode: 0o700 });
const binary = (name: string) => `/opt/homebrew/bin/${name}`;
let db: Database | undefined, peer: Database | undefined;
let fixture: Awaited<ReturnType<typeof chatgptFixture>> | undefined;
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
      `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p 55435 -c max_connections=16 -c shared_buffers=16MB -c log_statement=none -c log_min_error_statement=panic -c log_error_verbosity=terse`,
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
  const url = new URL("postgresql://synthetic_audit@localhost:55435/postgres");
  url.searchParams.set("host", socket);
  db = await openDatabase({ dataDir: root, databaseUrl: url.href });
  await migrate(db);
  peer = await openDatabase({ dataDir: root, databaseUrl: url.href });
  const f = (fixture = await chatgptFixture(undefined, 0, db));
  let other = new ChatGPT(
    peer,
    new Auth(peer, f.config),
    f.config,
    f.transport,
  );
  const context = {
    text: "Synthetic PostgreSQL test",
    url: "",
    categories: [],
  };
  const draft = async (client = other) =>
    (await client.provider(f.owner, f.fallback))!.draft(context);
  const link = async () => {
    const begin = await f.begin();
    const response = await f.request(
      begin.callback,
      "GET",
      undefined,
      `${f.cookie}; ${begin.browserCookie}`,
    );
    assert.equal(response.headers.get("location"), "/?chatgpt=connected");
  };
  const expire = () =>
    db!.query(
      "UPDATE chatgpt_connections SET expires_at=now()-interval '1 second' WHERE owner=$1",
      [f.owner],
    );
  const rejectsConnect = (error: unknown) =>
    error instanceof AppError && error.code === "AI_CHATGPT_CONNECT";
  await link();
  await expire();
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => draft(i % 2 ? f.chatgpt : other)),
  );
  assert.equal(f.state.refreshCalls, 1);
  assert.equal(f.state.siteCalls, 0);
  console.log(
    "PASS 1: eight simultaneous drafts across two pools rotate the refresh token once",
  );

  await peer.close();
  peer = await openDatabase({ dataDir: root, databaseUrl: url.href });
  other = new ChatGPT(peer, new Auth(peer, f.config), f.config, f.transport);
  await expire();
  await draft();
  assert.equal(f.state.refreshCalls, 2);
  console.log(
    "PASS 2: reopening the database and provider preserves the rotated encrypted token",
  );

  // Pause refresh after the owner lock, then verify a separate connection really
  // waits for that lock before releasing the provider response.
  async function duringRefresh(action: () => Promise<unknown>) {
    await expire();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.state.beforeRefresh = async () => {
      entered();
      await gate;
    };
    const inFlight = draft(f.chatgpt);
    let mutation: Promise<unknown> | undefined;
    try {
      await reached;
      mutation = action();
      // Attach a rejection handler immediately while inspecting the lock wait.
      void mutation.catch(() => {});
      let locked = false;
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const result = await db!.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS waiting",
        );
        if (result.rows[0].waiting) {
          locked = true;
          break;
        }
        await delay(20);
      }
      assert.ok(
        locked,
        "The competing credential mutation must wait on a real PostgreSQL lock",
      );
    } finally {
      release();
      f.state.beforeRefresh = undefined;
      await Promise.all([inFlight, mutation]);
    }
  }
  await duringRefresh(() => other.disconnect(f.owner, f.session, f.password));
  assert.equal(f.state.revokedCurrentRefresh, true);
  assert.equal((await other.status(f.owner)).connected, false);
  await assert.rejects(draft(), rejectsConnect);
  assert.equal(f.state.siteCalls, 0);
  console.log(
    "PASS 3: disconnect waits for refresh, revokes the rotated token, and blocks later drafts without site fallback",
  );

  await link();
  await expire();
  f.state.refreshStatus = 400;
  const invalid = await Promise.allSettled([draft(), draft(f.chatgpt)]);
  assert.ok(
    invalid.every(
      (result) => result.status === "rejected" && rejectsConnect(result.reason),
    ),
  );
  assert.equal((await other.status(f.owner)).planConnected, false);
  assert.equal(f.state.siteCalls, 0);
  f.state.refreshStatus = 200;
  console.log(
    "PASS 4: invalid refresh clears credentials across connections without using the site key",
  );

  await link();
  await duringRefresh(() =>
    new Auth(peer!, f.config).logoutEverywhere(f.owner, f.session, f.password),
  );
  assert.equal((await other.status(f.owner)).connected, false);
  assert.equal(await f.auth.sessionOwner(f.session), undefined);
  await assert.rejects(draft(), rejectsConnect);
  assert.equal(f.state.siteCalls, 0);
  console.log(
    "PASS 5: sign out everywhere wins after refresh and removes sessions and ChatGPT credentials",
  );
} finally {
  try {
    await fixture?.close();
    await peer?.close();
    await db?.close();
    await stop();
  } finally {
    if (!existsSync(join(cluster, "postmaster.pid")))
      await rm(root, { recursive: true, force: true });
  }
}
console.log(
  "PostgreSQL ChatGPT: 5/5 passed; temporary cluster stopped and removed.",
);
