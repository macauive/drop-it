import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { stat, readdir } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import express, { type ErrorRequestHandler } from "express";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { migrate, type Database } from "../server/db.js";
import { AppError } from "../server/errors.js";
import { Library } from "../server/library.js";
import {
  addPortabilityRoutes,
  Portability,
  type PortabilityHttpPolicy,
} from "../server/portability.js";
import { maxArchiveBytes, type ImportPreview } from "../shared/portable.js";

let db: Database, archive: string, partialArchive: string, sourceOwner: string;
const owners = new Set<string>();
const newOwner = async () => {
  const id = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,'synthetic-unusable-hash')",
    [id],
  );
  owners.add(id);
  return id;
};
before(async () => {
  const raw = new PGlite();
  await raw.waitReady;
  db = {
    query: (sql, params) => raw.query(sql, params),
    transaction: (run) => raw.transaction(run),
    close: () => raw.close(),
  };
  await migrate(db);
  sourceOwner = await newOwner();
  const library = new Library(db);
  // The incompressible original exceeds a local socket's output buffer, so the
  // download test really interrupts an active stream rather than its final byte.
  const bytes = await sharp(randomBytes(1700 * 1700 * 3), {
    raw: { width: 1700, height: 1700, channels: 3 },
  })
    .png()
    .toBuffer();
  const uploaded = await library.upload(
    sourceOwner,
    bytes,
    "image/png",
    "synthetic-http.png",
  );
  await library.save(sourceOwner, {
    requestId: randomUUID(),
    title: "Synthetic HTTP original",
    source: {
      attachmentId: uploaded.attachmentId,
      originalText: "Synthetic text",
    },
  });
  const manager = new Portability(db);
  try {
    const lines: string[] = [];
    await manager.export(sourceOwner, async (line) => {
      lines.push(line);
    });
    archive = lines.join("");
    const firstChunk = lines.findIndex(
      (line) => JSON.parse(line).type === "chunk",
    );
    partialArchive = lines.slice(0, firstChunk + 1).join("");
  } finally {
    await manager.close();
  }
});
after(async () => {
  await db?.close();
});

async function eventually(
  check: () => boolean | Promise<boolean>,
  message: string,
) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(10);
  }
}
const absent = async (path: string) => {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
};
async function fixture(
  t: TestContext,
  policy: Partial<PortabilityHttpPolicy> = {},
) {
  const app = express();
  app.use((req, res, next) => {
    const owner = req.get("X-Synthetic-Owner");
    if (!owner || !owners.has(owner)) return res.sendStatus(401);
    res.locals.owner = owner;
    next();
  });
  app.use((req, res, next) => {
    if (req.path === "/api/portability/preview") next();
    else express.json({ limit: "20kb" })(req, res, next);
  });
  const manager = addPortabilityRoutes(
    app,
    db,
    {},
    {
      uploadIdleTimeoutMs: 5000,
      uploadDeadlineMs: 10000,
      exportDeadlineMs: 10000,
      ...policy,
    },
  );
  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.destroyed) return;
    if (res.headersSent) return next(error);
    res.status(error instanceof AppError ? error.status : 500).json({
      code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
    });
  };
  app.use(errors);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await eventually(
      () => [...stages().values()].every((stage) => !stage.busy),
      "request cleanup must finish before closing the manager",
    );
    await manager.close();
  });
  // Observe only this fixture's private staging paths to verify permissions and
  // physical removal. No unrelated temporary directory is enumerated or read.
  const stages = () =>
    (
      manager as unknown as {
        stages: Map<
          string,
          { owner: string; directory: string; busy: boolean }
        >;
      }
    ).stages;
  const stagePath = async (owner: string) => {
    let directory = "";
    await eventually(async () => {
      directory =
        [...stages().values()].find((stage) => stage.owner === owner)
          ?.directory ?? "";
      return !!directory && (await readdir(directory)).length > 0;
    }, "a partial original must reach private staging");
    return directory;
  };
  const request = (
    owner: string,
    path: string,
    method = "GET",
    body?: string,
    extraHeaders = {},
  ) =>
    fetch(origin + path, {
      method,
      headers: {
        "X-Synthetic-Owner": owner,
        "Content-Type": "application/x-ndjson",
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body }),
    });
  const preview = async (owner: string) => {
    const response = await request(
      owner,
      "/api/portability/preview",
      "POST",
      archive,
    );
    assert.equal(response.status, 200);
    return (await response.json()) as ImportPreview;
  };
  const discard = async (owner: string, preview: ImportPreview) => {
    assert.equal(
      (
        await request(
          owner,
          `/api/portability/preview/${preview.previewId}`,
          "DELETE",
        )
      ).status,
      200,
    );
  };
  const upload = (owner: string, headers = {}) => {
    let result!: (value: {
      status: number;
      body: string;
      error?: Error;
    }) => void;
    const finished = new Promise<{
      status: number;
      body: string;
      error?: Error;
    }>((resolve) => {
      result = resolve;
    });
    const req = httpRequest(
      origin + "/api/portability/preview",
      {
        method: "POST",
        headers: {
          "X-Synthetic-Owner": owner,
          "Content-Type": "application/x-ndjson",
          ...headers,
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.once("end", () =>
          result({ status: response.statusCode ?? 0, body }),
        );
        response.once("error", (error) =>
          result({ status: response.statusCode ?? 0, body, error }),
        );
      },
    );
    req.once("error", (error) => result({ status: 0, body: "", error }));
    req.flushHeaders();
    return { req, finished };
  };
  return {
    origin,
    manager,
    stages,
    stagePath,
    request,
    preview,
    discard,
    upload,
  };
}

test("HTTP mid-original upload abort removes private files and releases the owner slot", async (t) => {
  const f = await fixture(t),
    owner = await newOwner();
  const pending = f.upload(owner);
  pending.req.write(partialArchive);
  const directory = await f.stagePath(owner);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const file of await readdir(directory))
    assert.equal((await stat(`${directory}/${file}`)).mode & 0o777, 0o600);
  pending.req.destroy();
  await pending.finished;
  await eventually(
    () => absent(directory),
    "aborted original must be removed from disk",
  );
  const retry = await f.preview(owner);
  await f.discard(owner, retry);
  const rows = await db.query<{ count: string }>(
    "SELECT count(*) FROM items WHERE owner=$1",
    [owner],
  );
  assert.equal(Number(rows.rows[0].count), 0);
});

test("HTTP oversized records and declared archives reject promptly, clean staging, and allow retry", async (t) => {
  const f = await fixture(t),
    owner = await newOwner();
  const pending = f.upload(owner);
  pending.req.write(partialArchive);
  const directory = await f.stagePath(owner);
  pending.req.end("{" + " ".repeat(512 * 1024) + "}\n");
  const rejected = await pending.finished;
  assert.equal(rejected.status, 413);
  assert.equal(JSON.parse(rejected.body).code, "IMPORT_LIMIT");
  await eventually(
    () => absent(directory),
    "oversized record must remove staged originals",
  );
  const tooLarge = f.upload(owner, {
    "Content-Length": String(maxArchiveBytes + 1),
  });
  tooLarge.req.end();
  assert.equal((await tooLarge.finished).status, 413);
  assert.equal(f.stages().size, 0);
  const retry = await f.preview(owner);
  await f.discard(owner, retry);
});

test("HTTP in-flight previews enforce owner and process limits, then release both slots after abort", async (t) => {
  const f = await fixture(t);
  const [first, second, third] = await Promise.all([
    newOwner(),
    newOwner(),
    newOwner(),
  ]);
  const one = f.upload(first);
  one.req.write(partialArchive);
  const directories = [await f.stagePath(first)];
  assert.equal(f.stages().size, 1);
  const rejectedPreview = async (owner: string) => {
    const rejected = await f.request(
      owner,
      "/api/portability/preview",
      "POST",
      archive.slice(0, archive.indexOf("\n") + 1),
    );
    assert.equal(rejected.status, 429);
    assert.equal((await rejected.json()).code, "IMPORT_BUSY");
  };
  // Check the owner limit while a global slot is still available.
  await rejectedPreview(first);
  const two = f.upload(second);
  two.req.write(partialArchive);
  directories.push(await f.stagePath(second));
  assert.equal(f.stages().size, 2);
  await rejectedPreview(third);
  one.req.destroy();
  two.req.destroy();
  await Promise.all([one.finished, two.finished]);
  for (const directory of directories)
    await eventually(
      () => absent(directory),
      "cancelled slot must remove private files",
    );
  const retry = await f.preview(third);
  await f.discard(third, retry);
});

test("HTTP mid-download abort yields an incomplete archive and releases the export slot", async (t) => {
  const f = await fixture(t);
  let received = "",
    ended = false;
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      f.origin + "/api/portability/export",
      { headers: { "X-Synthetic-Owner": sourceOwner } },
      (response) => {
        assert.equal(response.statusCode, 200);
        assert.match(
          response.headers["content-disposition"] ?? "",
          /attachment;/,
        );
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          received += chunk;
          if (received.includes('"type":"chunk"')) response.destroy();
        });
        response.once("end", () => {
          ended = true;
        });
        response.once("close", resolve);
        response.once("error", reject);
      },
    );
    req.once("error", reject);
    req.end();
  });
  assert.equal(ended, false);
  assert.equal(received.includes('"type":"end"'), false);
  assert.ok(received.length < archive.length);
  // Wait for the route's asynchronous rollback before requesting a new export.
  await eventually(
    () => !(f.manager as unknown as { exporting: boolean }).exporting,
    "aborted export must release its slot",
  );
  const retry = await f.request(sourceOwner, "/api/portability/export");
  assert.equal(retry.status, 200);
  const text = await retry.text();
  assert.equal(JSON.parse(text.trimEnd().split("\n").at(-1)!).type, "end");
});

test("HTTP slow trickle reaches an overall upload deadline despite continuous activity", async (t) => {
  const f = await fixture(t, {
    uploadIdleTimeoutMs: 300,
    uploadDeadlineMs: 500,
  });
  const owner = await newOwner();
  const pending = f.upload(owner);
  pending.req.write(partialArchive);
  const directory = await f.stagePath(owner);
  const began = Date.now();
  let writes = 0;
  const trickle = setInterval(() => {
    pending.req.write(" ");
    writes++;
  }, 30);
  const watchdog = setTimeout(
    () => pending.req.destroy(new Error("Synthetic test deadline exceeded")),
    1800,
  );
  try {
    const result = await pending.finished;
    assert.ok(
      writes >= 3,
      "data must continue flowing during the timeout test",
    );
    assert.ok(
      Date.now() - began < 1300,
      "an active upload must stop at its absolute deadline, before the test watchdog",
    );
    assert.notEqual(result.error?.message, "Synthetic test deadline exceeded");
  } finally {
    clearInterval(trickle);
    clearTimeout(watchdog);
    pending.req.destroy();
  }
  await eventually(
    () => absent(directory),
    "timed-out upload must remove staged originals",
  );
  assert.equal(f.stages().size, 0);
  // A small archive proves the timed-out owner can immediately start over.
  const emptyOwner = await newOwner();
  const empty = await f.request(emptyOwner, "/api/portability/export");
  const retry = await f.request(
    owner,
    "/api/portability/preview",
    "POST",
    await empty.text(),
  );
  assert.equal(retry.status, 200);
  await f.discard(owner, (await retry.json()) as ImportPreview);
});
