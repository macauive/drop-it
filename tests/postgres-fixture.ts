import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type Database } from "../server/db.js";

const run = promisify(execFile);
// No environment files, hosted connection strings, TCP listener or paid services.
export async function postgresFixture() {
  const bin =
    process.env.DROP_IT_PG_BIN ??
    (existsSync("/opt/homebrew/opt/postgresql@16/bin/postgres")
      ? "/opt/homebrew/opt/postgresql@16/bin"
      : (await run("pg_config", ["--bindir"])).stdout.trim());
  const binary = (name: string) => join(bin, name);
  if (
    !/^postgres \(PostgreSQL\) 16\./.test(
      (await run(binary("postgres"), ["--version"])).stdout,
    )
  )
    throw new Error(
      "The auth release checks require PostgreSQL 16. Set DROP_IT_PG_BIN to its bin directory.",
    );
  const root = await mkdtemp(join(tmpdir(), "drop-it-pg-auth-"));
  await chmod(root, 0o700);
  const cluster = join(root, "cluster"),
    socket = join(root, "socket");
  await mkdir(socket, { mode: 0o700 });
  const connections = new Set<Database>();
  const url = (database: string, admin = false) => {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(database))
      throw new Error("Invalid fixture database name");
    const value = new URL(
      `postgresql://${admin ? "synthetic_auth_admin" : "synthetic_auth_app"}@localhost:55437/${database}`,
    );
    value.searchParams.set("host", socket);
    return value.href;
  };
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
        `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p 55437 -c max_connections=32 -c shared_buffers=16MB -c log_statement=none -c log_min_error_statement=panic -c log_error_verbosity=terse`,
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
  async function connect(database: string) {
    const db = await openDatabase({
      dataDir: root,
      databaseUrl: url(database),
    });
    let closed = false;
    const wrapped: Database = {
      ...db,
      close: async () => {
        if (closed) return;
        closed = true;
        connections.delete(wrapped);
        await db.close();
      },
    };
    connections.add(wrapped);
    return wrapped;
  }
  async function create(database: string) {
    url(database); // Validate before using this fixture-only SQL identifier.
    const admin = await openDatabase({
      dataDir: root,
      databaseUrl: url("postgres", true),
    });
    try {
      await admin.query(
        `CREATE DATABASE "${database}" OWNER synthetic_auth_app`,
      );
    } finally {
      await admin.close();
    }
    return connect(database);
  }
  async function close() {
    await Promise.allSettled([...connections].map((db) => db.close()));
    await stop();
    await rm(root, { recursive: true, force: true });
  }
  try {
    await run(
      binary("initdb"),
      [
        "-D",
        cluster,
        "--username=synthetic_auth_admin",
        "--auth-local=trust",
        "--auth-host=reject",
        "--no-locale",
        "--encoding=UTF8",
      ],
      { timeout: 30000 },
    );
    await start();
    const admin = await openDatabase({
      dataDir: root,
      databaseUrl: url("postgres", true),
    });
    try {
      await admin.query(
        "CREATE ROLE synthetic_auth_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE",
      );
    } finally {
      await admin.close();
    }
    return { root, binary, url, start, stop, connect, create, close };
  } catch (error) {
    await close();
    throw error;
  }
}
