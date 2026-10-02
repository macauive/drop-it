// Child process for postgres-portability.ts. Synthetic inputs arrive over IPC;
// no environment/configuration files or application startup are loaded here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase, type Database } from "../server/db.js";
import { Portability } from "../server/portability.js";
import { AppError } from "../server/errors.js";

type Input = {
  mode: "slow-export" | "before-commit" | "after-commit" | "recover";
  databaseUrl: string;
  owner: string;
  archivePath: string;
  previewId?: string;
  committed?: boolean;
};
const send = (message: object) => process.send?.(message);
const bytes = async function* (archivePath: string) {
  yield await readFile(archivePath);
};

process.once("message", (input: Input) => {
  void run(input).catch(() => {
    send({ type: "failure", message: "Synthetic portability worker failed" });
    process.exitCode = 1;
    process.disconnect?.();
  });
});

async function run(input: Input) {
  const db = await openDatabase({
    dataDir: "unused-for-postgresql",
    databaseUrl: input.databaseUrl,
  });
  let manager: Portability | undefined;
  try {
    if (input.mode === "slow-export") {
      manager = new Portability(db);
      const lines: string[] = [];
      let first = true,
        rejected = false;
      try {
        await manager.export(input.owner, async (line) => {
          lines.push(line);
          if (first) {
            first = false;
            send({ type: "paused" });
            // Real wall-clock pause exceeds the pool's 15-second PostgreSQL
            // idle-transaction budget and models a blocked client download.
            await delay(17000);
          }
        });
      } catch {
        rejected = true;
      }
      assert.equal(
        rejected,
        true,
        "stalled export must fail after its database snapshot is lost",
      );
      assert.equal(
        lines.some((line) => JSON.parse(line).type === "end"),
        false,
      );
      assert.equal(
        (await db.query<{ ready: number }>("SELECT 1 AS ready")).rows[0].ready,
        1,
      );
      const retry: string[] = [];
      await manager.export(input.owner, async (line) => {
        retry.push(line);
      });
      assert.equal(JSON.parse(retry.at(-1)!).type, "end");
      send({
        type: "result",
        rejected,
        noCompletionMarker: true,
        poolRecovered: true,
        exportSlotRecovered: true,
      });
    } else if (
      input.mode === "before-commit" ||
      input.mode === "after-commit"
    ) {
      const block = () => new Promise<never>(() => {});
      const wrapped: Database = {
        ...db,
        transaction: async (run) => {
          if (input.mode === "before-commit")
            return db.transaction(async (tx) => {
              const value = await run(tx);
              send({ type: "crash-point", boundary: "before-commit" });
              await block();
              return value;
            });
          const value = await db.transaction(run);
          send({ type: "crash-point", boundary: "after-commit" });
          await block();
          return value;
        },
      };
      manager = new Portability(wrapped);
      const preview = await manager.preview(
        input.owner,
        bytes(input.archivePath),
        "ndjson",
      );
      send({ type: "preview", previewId: preview.previewId });
      await manager.apply(input.owner, {
        previewId: preview.previewId,
        requestId: preview.requestId,
        confirm: true,
      });
      throw new Error(
        "Parent should kill this process at the reported boundary",
      );
    } else {
      assert.ok(input.previewId);
      manager = new Portability(db);
      await manager.expire();
      const oldRequest = {
        previewId: input.previewId,
        requestId: input.previewId,
        confirm: true,
      };
      if (input.committed) {
        const result = await manager.apply(input.owner, oldRequest);
        assert.equal(result.replayed, true);
        send({
          type: "result",
          ...result,
          recoveredRequestId: input.previewId,
        });
      } else {
        await assert.rejects(
          manager.apply(input.owner, oldRequest),
          (error: unknown) =>
            error instanceof AppError && error.code === "IMPORT_EXPIRED",
        );
        const preview = await manager.preview(
          input.owner,
          bytes(input.archivePath),
          "ndjson",
        );
        const request = {
          previewId: preview.previewId,
          requestId: preview.requestId,
          confirm: true,
        };
        const result = await manager.apply(input.owner, request);
        assert.equal(result.replayed, false);
        assert.equal(
          (await manager.apply(input.owner, request)).replayed,
          true,
        );
        send({
          type: "result",
          ...result,
          expiredRequestRejected: true,
          recoveredRequestId: preview.requestId,
        });
      }
    }
  } finally {
    await manager?.close();
    await db.close();
  }
  process.disconnect?.();
}
