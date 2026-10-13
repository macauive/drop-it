// Opt-in production-shaped PostgreSQL/HTTP memory regression, excluded from
// tests/*.test.ts. Run with Node 24: node --import tsx
// tests/legacy-export-http-memory.ts. No .env, live services or personal data.
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, stat } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { migrate } from "../server/db.js";
import { Library } from "../server/library.js";
import type { Item, Source } from "../shared/schema.js";
import sharp from "sharp";
import { postgresFixture } from "./postgres-fixture.js";

const MiB = 1024 * 1024;
const serverCeiling = 384 * MiB;
const productionBudget = 512 * MiB;
const origin = "https://legacy-export.synthetic.invalid";
const database = "legacy_export_http_memory";
const references = 90;
type ExportMetadata = Pick<
  Source,
  "id" | "originalText" | "url" | "createdAt" | "filename" | "mime"
>;
const sourceMetadata = (source: Source): ExportMetadata => ({
  id: source.id,
  originalText: source.originalText,
  url: source.url,
  createdAt: source.createdAt,
  filename: source.filename,
  mime: source.mime,
});
const wireObject = <T>(value: T): T => JSON.parse(JSON.stringify(value));
type Memory = {
  rssBytes: number;
  sampledPeakBytes: number;
  maximumRssBytes: number;
  samples: number;
};
type Ready = Memory & { port: number; builtHtml: boolean };

// The client retains at most metadata plus one HTTP chunk. Each large base64
// body is checked incrementally, without decoding or parsing the full archive.
class ArchiveVerifier {
  bytes = 0;
  tail = "";
  private pending = "";
  private state: "header" | "metadata" | "body" | "suffix" | "done" = "header";
  private sourceIndex = 0;
  private bodyBytes = 0;
  private bodyHash = createHash("sha256");
  constructor(
    private readonly items: Item[],
    private readonly sources: ExportMetadata[],
    private readonly expectedBase64Bytes: number,
    private readonly expectedBase64Hash: string,
    readonly expectedBytes: number,
  ) {}
  push(chunk: Buffer) {
    assert.ok(chunk.length <= 65536, "bounded client verifier fragments");
    this.bytes += chunk.length;
    assert.ok(this.bytes <= this.expectedBytes, "bounded archive byte count");
    let input = this.pending + chunk.toString("utf8");
    this.pending = "";
    this.tail = (this.tail + input.slice(-64)).slice(-64);
    for (;;) {
      if (this.state === "header") {
        const marker = ',"sources":[';
        const end = input.indexOf(marker);
        if (end < 0) {
          assert.ok(input.length <= 256 * 1024, "bounded item metadata");
          this.pending = input;
          return;
        }
        const header = input.slice(0, end + marker.length);
        const parsed = JSON.parse(header + "]}") as {
          version: number;
          exportedAt: string;
          items: Item[];
          sources: unknown[];
        };
        assert.equal(parsed.version, 2);
        assert.match(parsed.exportedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]{12}Z$/);
        assert.deepEqual(parsed.items, wireObject(this.items));
        assert.deepEqual(parsed.sources, []);
        assert.equal(
          header,
          JSON.stringify({
            version: 2,
            exportedAt: parsed.exportedAt,
            items: this.items,
          }).slice(0, -1) + marker,
        );
        input = input.slice(header.length);
        this.state = "metadata";
      } else if (this.state === "metadata") {
        const marker = ',"imageBase64":"';
        const end = input.indexOf(marker);
        if (end < 0) {
          assert.ok(input.length <= 16 * 1024, "bounded source metadata");
          this.pending = input;
          return;
        }
        assert.ok(this.sourceIndex < this.sources.length);
        assert.equal(
          input.slice(0, end),
          (this.sourceIndex ? "," : "") +
            JSON.stringify(this.sources[this.sourceIndex]).slice(0, -1),
        );
        input = input.slice(end + marker.length);
        this.bodyBytes = 0;
        this.bodyHash = createHash("sha256");
        this.state = "body";
      } else if (this.state === "body") {
        const end = input.indexOf('"');
        const fragment = end < 0 ? input : input.slice(0, end);
        this.bodyBytes += fragment.length;
        assert.ok(this.bodyBytes <= this.expectedBase64Bytes);
        this.bodyHash.update(fragment, "ascii");
        if (end < 0) return;
        assert.equal(this.bodyBytes, this.expectedBase64Bytes);
        assert.equal(this.bodyHash.digest("hex"), this.expectedBase64Hash);
        input = input.slice(end + 1);
        this.state = "suffix";
      } else if (this.state === "suffix") {
        const suffix = ',"fileBase64":null}';
        if (input.length < suffix.length) {
          this.pending = input;
          return;
        }
        assert.equal(input.slice(0, suffix.length), suffix);
        input = input.slice(suffix.length);
        this.sourceIndex++;
        this.state =
          this.sourceIndex === this.sources.length ? "done" : "metadata";
      } else {
        assert.ok(input.length <= 2, "no bytes after the archive");
        this.pending = input;
        return;
      }
    }
  }
  finish() {
    assert.equal(this.state, "done");
    assert.equal(this.pending, "]}");
    assert.equal(this.sourceIndex, this.sources.length);
    assert.equal(this.bytes, this.expectedBytes);
    assert.ok(this.tail.endsWith("]}"));
  }
}

async function waitUntil(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message);
}

async function run() {
  assert.equal(process.versions.node.split(".")[0], "24");
  const fixture = await postgresFixture();
  let child: ChildProcess | undefined;
  let lastMemory: Memory | undefined;
  let baseline: Ready | undefined;
  let cleanupFailures = 0;
  let workerOutputBytes = 0;
  let siblingRequests = 0;
  let maximumSiblingMs = 0;
  let maximumClientChunkBytes = 0;
  let phase = "fixture-seeding";
  const stagingRoot = join(fixture.root, "http-export-staging");
  const stagedDirectories = async () =>
    (await readdir(stagingRoot)).filter((name) =>
      /^drop-it-legacy-export-[A-Za-z0-9]{6}$/.test(name),
    );
  const assertClean = async () => {
    try {
      await waitUntil(
        async () => (await stagedDirectories()).length === 0,
        "private staging cleanup did not complete",
      );
    } catch (error) {
      cleanupFailures++;
      throw error;
    }
  };
  let exitPromise: Promise<number | null> | undefined;
  try {
    await mkdir(stagingRoot, { mode: 0o700 });
    const db = await fixture.create(database);
    await migrate(db);
    const library = new Library(db);
    const owner = randomUUID();
    const controlOwner = randomUUID();
    const otherOwner = randomUUID();
    const cookies = new Map<string, string>();
    for (const id of [owner, controlOwner, otherOwner]) {
      await db.query(
        "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$2)",
        [id, "synthetic-unusable-http-memory-password-hash"],
      );
      const token = randomBytes(32).toString("base64url");
      await db.query(
        "INSERT INTO sessions(hash,owner,label,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
        [
          createHash("sha256").update(token).digest("hex"),
          id,
          "Synthetic memory regression session",
        ],
      );
      cookies.set(id, `__Host-drop_it_session=${token}`);
    }
    const original = await sharp(randomBytes(3 * MiB), {
      raw: { width: 1024, height: 1024, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    assert.ok(original.length > 3 * MiB);
    const uploaded = await library.upload(
      owner,
      original,
      "image/png",
      "synthetic-noise.png",
    );
    const items: Item[] = [];
    const sources: ExportMetadata[] = [];
    const saveAmplified = async (index: number) =>
      library.save(owner, {
        requestId: randomUUID(),
        title: `Synthetic amplified source ${index}`,
        allowDuplicate: true,
        source: {
          originalText: `Synthetic original ${index}`,
          attachmentId: uploaded.attachmentId,
        },
      });
    for (let index = 0; index < references; index++) {
      const saved = await saveAmplified(index);
      items.push(saved.item);
      sources.push(sourceMetadata(saved.source));
    }
    // PostgreSQL sorts timestamps at sub-millisecond precision, which pg's JS
    // Date conversion loses. Obtain the expected wire order from the fixture
    // database rather than sorting the rounded dates in the HTTP client.
    const expectedOrder = await db.query<{ id: string }>(
      "SELECT id FROM items WHERE owner=$1 ORDER BY created_at,id",
      [owner],
    );
    const itemsById = new Map(items.map((item) => [item.id, item]));
    items.splice(
      0,
      items.length,
      ...expectedOrder.rows.map((row) => itemsById.get(row.id)!),
    );
    sources.sort((a, b) => a.id.localeCompare(b.id));
    const base64Bytes = 4 * Math.ceil(original.length / 3);
    const expectedBase64 = createHash("sha256");
    for (let offset = 0; offset < original.length; offset += 65535)
      expectedBase64.update(
        original.subarray(offset, offset + 65535).toString("base64"),
        "ascii",
      );
    const base64Hash = expectedBase64.digest("hex");
    const expectedBytes =
      Buffer.byteLength(
        JSON.stringify({
          version: 2,
          exportedAt: "2000-01-01T00:00:00.000Z",
          items,
        }).slice(0, -1) + ',"sources":[',
      ) +
      sources.reduce(
        (sum, source, index) =>
          sum +
          Buffer.byteLength(JSON.stringify(source).slice(0, -1)) +
          Buffer.byteLength(',"imageBase64":"","fileBase64":null}') +
          base64Bytes +
          (index ? 1 : 0),
        0,
      ) +
      2;
    assert.ok(expectedBytes > 350 * MiB && expectedBytes < 384 * MiB);

    const controlBytes = Buffer.from('Synthetic control 漢🧪 "quoted"\\\n');
    const controlUpload = await library.upload(
      controlOwner,
      controlBytes,
      "text/plain",
      'control "quoted".txt',
    );
    const control = await library.save(controlOwner, {
      requestId: randomUUID(),
      title: 'Synthetic control "quoted" title',
      source: {
        originalText: "Synthetic control original",
        attachmentId: controlUpload.attachmentId,
      },
    });
    await library.save(otherOwner, {
      requestId: randomUUID(),
      title: "Other owner private sentinel",
      source: { originalText: "Other owner original sentinel" },
    });

    phase = "worker-startup";
    child = fork(
      fileURLToPath(
        new URL("./legacy-export-http-memory-worker.ts", import.meta.url),
      ),
      [],
      {
        execPath: process.execPath,
        execArgv: ["--import", "tsx"],
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          TMPDIR: stagingRoot,
          NODE_ENV: "production",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const worker = child;
    exitPromise = new Promise((resolve) => worker.once("exit", resolve));
    worker.stdout?.on("data", (chunk: Buffer) => {
      workerOutputBytes += chunk.length;
    });
    worker.stderr?.on("data", (chunk: Buffer) => {
      workerOutputBytes += chunk.length;
    });
    let failureCode: string | undefined;
    const ready = new Promise<Ready>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Isolated HTTP server startup timed out")),
        30000,
      );
      worker.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Isolated HTTP server exited before readiness"));
      });
      worker.on("message", (raw) => {
        const message = raw as Memory & Ready & { type: string; code?: string };
        if (typeof message.rssBytes === "number") lastMemory = message;
        if (message.type === "ready") {
          clearTimeout(timeout);
          resolve(message);
        } else if (
          message.type === "budget-exceeded" ||
          message.type === "failure"
        ) {
          failureCode = message.code ?? "SERVER_RSS_BUDGET_EXCEEDED";
          clearTimeout(timeout);
          reject(new Error(failureCode));
        }
      });
    });
    worker.send({
      type: "start",
      databaseUrl: fixture.url(database),
      dataDir: fixture.root,
    });
    baseline = await ready;
    assert.ok(baseline.builtHtml, "production built HTML is present");
    const openResponse = (path: string, requestOwner = owner) =>
      new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          `http://127.0.0.1:${baseline!.port}${path}`,
          {
            headers: {
              Host: new URL(origin).host,
              Origin: origin,
              Cookie: cookies.get(requestOwner)!,
              "X-Forwarded-Proto": "https",
            },
            agent: false,
          },
          resolve,
        );
        req.setTimeout(120000, () =>
          req.destroy(new Error("Synthetic HTTP request timed out")),
        );
        req.once("error", reject);
        req.end();
      });
    const smallResponse = async (path: string, requestOwner = controlOwner) => {
      const response = await openResponse(path, requestOwner);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response) {
        const buffer = chunk as Buffer;
        bytes += buffer.length;
        assert.ok(bytes <= MiB, "only small control responses are buffered");
        chunks.push(buffer);
      }
      return {
        status: response.statusCode,
        headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
    };
    const checkControl = async () => {
      const response = await smallResponse("/api/export");
      assert.equal(response.status, 200);
      const { exportedAt, ...archive } = response.body;
      assert.equal(new Date(exportedAt).toISOString(), exportedAt);
      assert.deepEqual(
        archive,
        wireObject({
          version: 2,
          items: [control.item],
          sources: [
            {
              ...sourceMetadata(control.source),
              imageBase64: null,
              fileBase64: controlBytes.toString("base64"),
            },
          ],
        }),
      );
      await assertClean();
    };
    const checkSibling = async () => {
      const started = performance.now();
      const response = await smallResponse("/api/session");
      const elapsed = performance.now() - started;
      maximumSiblingMs = Math.max(maximumSiblingMs, elapsed);
      siblingRequests++;
      assert.equal(response.status, 200);
      assert.equal(response.body.authenticated, true);
      assert.ok(elapsed < 1000, "sibling session request remains responsive");
    };
    const checkBusy = async () => {
      const response = await smallResponse("/api/export");
      assert.equal(response.status, 429);
      assert.equal(response.body.code, "EXPORT_BUSY");
    };

    phase = "small-control";
    await checkControl();
    phase = "near-cap-staging";
    const downloadPromise = openResponse("/api/export");
    await waitUntil(
      async () => (await stagedDirectories()).length === 1,
      "near-cap export did not create its private staging file",
    );
    await checkSibling();
    await checkBusy();
    const download = await downloadPromise;
    assert.equal(download.statusCode, 200);
    assert.match(String(download.headers["content-disposition"]), /attachment/);
    assert.match(String(download.headers["content-type"]), /application\/json/);
    assert.equal(download.headers["cache-control"], "no-store");
    const [directory] = await stagedDirectories();
    assert.ok(directory);
    const stagingDirectory = join(stagingRoot, directory);
    assert.equal((await lstat(stagingDirectory)).mode & 0o777, 0o700);
    const outputInfo = await stat(join(stagingDirectory, "library.json"));
    assert.equal(outputInfo.mode & 0o777, 0o600);
    assert.equal(outputInfo.size, expectedBytes);
    phase = "stalled-download";
    download.pause();
    // Real HTTP backpressure lasts longer than PG's 15-second idle transaction
    // timeout; completed staging must leave no snapshot transaction open.
    await delay(17000);
    await checkSibling();
    await checkBusy();
    const activity = await db.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_stat_activity WHERE datname=$1 AND state='idle in transaction'",
      [database],
    );
    assert.equal(Number(activity.rows[0].count), 0);
    const verifier = new ArchiveVerifier(
      items,
      sources,
      base64Bytes,
      base64Hash,
      expectedBytes,
    );
    phase = "near-cap-download";
    for await (const raw of download) {
      const chunk = raw as Buffer;
      maximumClientChunkBytes = Math.max(maximumClientChunkBytes, chunk.length);
      // IncomingMessage may coalesce native reads after a paused download.
      // Check bounded slices independently of Node's internal read grouping.
      for (let offset = 0; offset < chunk.length; offset += 65536)
        verifier.push(chunk.subarray(offset, offset + 65536));
    }
    verifier.finish();
    await assertClean();

    phase = "over-limit-preflight";
    const extraItems: string[] = [];
    for (let index = references; index < 100; index++)
      extraItems.push((await saveAmplified(index)).item.id);
    const rejected = await smallResponse("/api/export", owner);
    assert.equal(rejected.status, 413);
    assert.equal(rejected.body.code, "EXPORT_SIZE");
    assert.equal(rejected.headers["content-disposition"], undefined);
    await assertClean();
    await checkControl(); // slot recovers after preflight rejection
    await db.query("DELETE FROM items WHERE owner=$1 AND id=ANY($2::uuid[])", [
      owner,
      extraItems,
    ]);

    phase = "disconnected-download";
    const disconnected = await openResponse("/api/export");
    assert.equal(disconnected.statusCode, 200);
    assert.equal((await stagedDirectories()).length, 1);
    disconnected.destroy();
    await assertClean();
    await checkControl(); // slot recovers after disconnect during delivery
    await checkSibling();
    assert.equal(failureCode, undefined);
    phase = "worker-shutdown";
    worker.send({ type: "shutdown" });
    assert.equal(await exitPromise, 0);
    child = undefined;
    assert.ok(lastMemory);
    const peak = Math.max(
      lastMemory.sampledPeakBytes,
      lastMemory.maximumRssBytes,
    );
    assert.ok(lastMemory.samples > 100, "frequent server-only RSS sampling");
    assert.ok(peak < serverCeiling);
    assert.equal(workerOutputBytes, 0, "server reported no unexpected errors");
    console.log(
      JSON.stringify({
        status: "PASS",
        node: process.versions.node,
        postgresMajor: 16,
        references,
        originalBytes: original.length,
        outputBytes: verifier.bytes,
        serverBaselineRssBytes: baseline.rssBytes,
        serverSampledPeakRssBytes: lastMemory.sampledPeakBytes,
        serverResourceMaximumRssBytes: lastMemory.maximumRssBytes,
        serverRssSamples: lastMemory.samples,
        serverRssCeilingBytes: serverCeiling,
        productionBudgetBytes: productionBudget,
        siblingRequests,
        maximumSiblingMs: Math.round(maximumSiblingMs),
      maximumClientChunkBytes,
        stalledDownloadMs: 17000,
        cleanupFailures,
        smallControlExact: true,
        allBase64CopiesVerified: true,
        overLimitRejectedBeforeDownload: true,
        disconnectCleanupAndSlotRecovery: true,
        hardContainerMemoryLimitApplied: false,
        hostPlatform: process.platform,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "FAIL",
        phase,
        errorKind: error instanceof Error ? error.name : "UNKNOWN",
        location:
          error instanceof Error
            ? error.stack?.match(/legacy-export-http-memory\.ts:\d+:\d+/)?.[0]
            : undefined,
        serverBaselineRssBytes: baseline?.rssBytes,
        serverSampledPeakRssBytes: lastMemory?.sampledPeakBytes,
        serverResourceMaximumRssBytes: lastMemory?.maximumRssBytes,
        cleanupFailures,
      }),
    );
    throw error;
  } finally {
    if (child) {
      child.kill("SIGKILL");
      await exitPromise;
    }
    await fixture.close();
  }
}

await run().catch((error) => {
  const failure = error as NodeJS.ErrnoException & { stderr?: string };
  console.error(
    JSON.stringify({
      status: "FAIL",
      code: typeof failure.code === "string" ? failure.code : undefined,
      subprocessExitCode:
        typeof failure.code === "number" ? failure.code : undefined,
      permissionDenied: /EPERM|Operation not permitted|Permission denied/.test(
        failure.stderr ?? "",
      ),
    }),
  );
  process.exitCode = 1;
});
