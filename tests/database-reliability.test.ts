import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { openDatabase } from "../server/db.js";

test("Postgres pool handles background disconnects without secret logs and bounds waits", async (t) => {
  const observedPools: pg.Pool[] = [];
  const originalOn = pg.Pool.prototype.on;
  t.mock.method(
    pg.Pool.prototype,
    "on",
    function (
      this: pg.Pool,
      event: "error" | "release" | "connect" | "acquire" | "remove",
      listener: (...args: unknown[]) => void,
    ) {
      if (event === "error") observedPools.push(this);
      return originalOn.call(this, event, listener);
    },
  );
  const errorLog = t.mock.method(console, "error", () => {});
  // Pool construction is lazy; this check never opens a socket or authenticates.
  const db = await openDatabase({
    dataDir: "unused",
    databaseUrl: "postgresql://localhost/synthetic_disposable",
  });
  const captured = observedPools[0];
  try {
    assert.ok(captured);
    assert.equal(captured.totalCount, 0);
    assert.ok(
      captured.options.connectionTimeoutMillis &&
        captured.options.connectionTimeoutMillis <= 5000,
    );
    assert.ok(
      captured.options.query_timeout && captured.options.query_timeout <= 15000,
    );
    assert.ok(
      captured.options.statement_timeout &&
        captured.options.statement_timeout <= 15000,
    );
    assert.ok(
      captured.options.lock_timeout && captured.options.lock_timeout <= 5000,
    );
    assert.doesNotThrow(() =>
      captured!.emit(
        "error",
        new Error("SYNTHETIC sensitive connection details"),
      ),
    );
    assert.deepEqual(errorLog.mock.calls[0].arguments, [
      "Database connection interrupted",
      { code: "DATABASE_CONNECTION_ERROR" },
    ]);
  } finally {
    await db.close();
  }
});
