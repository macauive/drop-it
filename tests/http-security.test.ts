import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import * as zlib from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import type { RequestHandler } from "express";
import { createApp } from "../server/app.js";
import { loadConfig, type Config } from "../server/config.js";
import { migrate, openDatabase } from "../server/db.js";

// A disconnected client stops waiting before the server finishes its cleanup.
// Observe the async route boundary so retries test completed cleanup reliably.
function nextExportCompletion(
  t: TestContext,
  app: ReturnType<typeof createApp>["app"],
) {
  const router = app.router as {
    stack: { route?: { path: string; stack: { handle: RequestHandler }[] } }[];
  };
  const route = router.stack.find(
    (entry) => entry.route?.path === "/api/export",
  )!.route!;
  const handler = route.stack.at(-1)!;
  const original = handler.handle;
  let entered = false;
  let finished!: () => void;
  const completion = new Promise<void>((resolve) => {
    finished = resolve;
  });
  t.mock.method(
    handler,
    "handle",
    async (...args: Parameters<RequestHandler>) => {
      const observed = !entered;
      entered = true;
      try {
        return await original(...args);
      } finally {
        if (observed) finished();
      }
    },
  );
  return completion;
}

async function fixture(publicOrigin?: string) {
  const dir = await mkdtemp(join(tmpdir(), "drop-it-http-security-"));
  const db = await openDatabase({ dataDir: dir });
  await migrate(db);
  const server: Server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const target = `http://127.0.0.1:${port}`;
  const origin = publicOrigin ?? target;
  const config: Config = {
    port,
    origin,
    local: !publicOrigin,
    production: Boolean(publicOrigin),
    redirectUris: [],
    dataDir: dir,
    databaseUrl: undefined,
    ai: undefined,
  };
  const built = createApp(
    db,
    config,
    '<!doctype html><title>Security fixture</title><script>document.title="Security fixture"</script>',
  );
  server.on("request", built.app);
  const password = randomBytes(24).toString("base64url");
  const session = await built.auth.setup(password);
  const cookie = `${publicOrigin ? "__Host-" : ""}drop_it_session=${session}`;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        target + path,
        {
          method,
          headers: {
            Host: new URL(origin).host,
            Origin: origin,
            Cookie: cookie,
            ...(body === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(
                    JSON.stringify(body),
                  ).toString(),
                }),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value !== undefined)
                for (const entry of Array.isArray(value) ? value : [value])
                  responseHeaders.append(name, entry);
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: responseHeaders,
              }),
            );
          });
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return {
    ...built,
    db,
    server,
    target,
    origin,
    password,
    cookie,
    session,
    request,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f?.close();
});

test("all private HTTP routes reject anonymous and forged sessions", async () => {
  const id = randomUUID();
  const routes: [string, string, unknown?][] = [
    ["/api/settings", "GET"],
    ["/api/export", "GET"],
    ["/api/search", "POST", {}],
    ["/api/items", "POST", {}],
    [`/api/items/${id}`, "GET"],
    [`/api/items/${id}`, "PATCH", {}],
    [`/api/items/${id}`, "DELETE", { revision: 1 }],
    [`/api/items/${id}/restore`, "POST", { revision: 1 }],
    [`/api/sources/${id}/file`, "GET"],
    [`/api/sources/${id}/image`, "GET"],
    ["/api/attachments", "POST"],
    ["/api/draft", "POST", {}],
    ["/api/logout", "POST"],
    ["/api/revoke-connections", "POST"],
    [`/api/authorize/${"x".repeat(43)}`, "GET"],
    [`/api/authorize/${"x".repeat(43)}`, "POST", { approved: true }],
  ];
  for (const [path, method, body] of routes) {
    for (const Cookie of [
      "",
      `drop_it_session=${randomBytes(32).toString("base64url")}`,
    ]) {
      const response = await f.request(path, method, body, { Cookie });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
});

test("host, origin and HTTP security headers resist rebinding and CSRF", async () => {
  assert.equal(
    (
      await f.request("/api/settings", "GET", undefined, {
        Host: "attacker.invalid",
      })
    ).status,
    400,
  );
  for (const Origin of [
    "",
    "null",
    "https://attacker.invalid",
    `${f.origin}.attacker.invalid`,
  ]) {
    const response = await f.request(
      "/api/revoke-connections",
      "POST",
      undefined,
      {
        Origin,
        "X-Forwarded-Host": new URL(f.origin).host,
        "X-Forwarded-Proto": "https",
      },
    );
    assert.equal(response.status, 403);
  }
  const response = await f.request("/");
  const csp = response.headers.get("content-security-policy")!;
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-(?:inline|eval)'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("invalid JSON, oversized and compressed bodies fail without source disclosure", async () => {
  const cases = [
    { body: '{"privateSentinel":', type: "application/json", status: 400 },
    {
      body: JSON.stringify({ query: "x".repeat(530000) }),
      type: "application/json",
      status: 413,
    },
    {
      body: gzipSync(
        Buffer.from(JSON.stringify({ query: "x".repeat(530000) })),
      ),
      type: "application/json",
      status: 413,
      encoding: "gzip",
    },
  ];
  for (const input of cases) {
    const response = await fetch(f.target + "/api/search", {
      method: "POST",
      headers: {
        Origin: f.origin,
        Cookie: f.cookie,
        "Content-Type": input.type,
        ...(input.encoding ? { "Content-Encoding": input.encoding } : {}),
      },
      body: input.body,
    });
    assert.equal(response.status, input.status);
    const body = await response.text();
    assert.doesNotMatch(
      body,
      /privateSentinel|SyntaxError|node_modules|server\//,
    );
  }
  for (const body of [
    { query: {}, owner: randomUUID() },
    { query: "ok", __unexpected: true },
    { limit: 1e100 },
    { offset: -1 },
  ]) {
    assert.equal((await f.request("/api/search", "POST", body)).status, 400);
  }
  const upload = await fetch(f.target + "/api/attachments", {
    method: "POST",
    headers: {
      Origin: f.origin,
      Cookie: f.cookie,
      "Content-Type": "text/plain",
      "X-File-Name": "oversized.txt",
    },
    body: Buffer.alloc(10 * 1024 * 1024 + 1, 65),
  });
  assert.equal(upload.status, 413);
});

test("public compressed requests remain usable and trailing corrupt frames cannot terminate the server", async (t) => {
  const isolated = await fixture();
  try {
    const post = (
      path: string,
      type: string,
      encoding: string,
      frame: Buffer,
      trailing = false,
      delayed = false,
    ) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          isolated.target + path,
          {
            method: "POST",
            headers: {
              "Content-Type": type,
              "Content-Encoding": encoding,
              Accept: "application/json, text/event-stream",
            },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode!));
            response.once("error", reject);
          },
        );
        request.setTimeout(5000, () =>
          request.destroy(new Error("Compressed request stalled")),
        );
        request.once("error", reject);
        const junk = Buffer.alloc(64 * 1024, 0xff);
        if (!delayed)
          request.end(trailing ? Buffer.concat([frame, junk]) : frame);
        else {
          request.write(frame);
          void delay(20)
            .then(() => request.end(junk))
            .catch(reject);
        }
      });
    const codecs: [string, (bytes: Buffer) => Buffer][] = [
      ["gzip", gzipSync],
      ["deflate", deflateSync],
      ["br", brotliCompressSync],
    ];
    if (typeof zlib.zstdCompressSync === "function")
      codecs.push(["zstd", zlib.zstdCompressSync]);
    else
      t.diagnostic(
        "Zstd is unavailable on this older Node runtime; gzip/deflate/Brotli remain covered.",
      );
    for (const [encoding, compress] of codecs) {
      for (const [path, type, input, expected] of [
        [
          "/mcp",
          "application/json",
          '{"jsonrpc":"2.0","id":1,"method":"ping"}',
          200,
        ],
        [
          "/share",
          "application/x-www-form-urlencoded",
          "text=Synthetic+compressed+source",
          200,
        ],
        ["/register", "application/json", "{}", 400],
        [
          "/token",
          "application/x-www-form-urlencoded",
          "grant_type=synthetic_invalid_grant",
          400,
        ],
      ] as const) {
        const frame = compress(Buffer.from(input));
        assert.equal(await post(path, type, encoding, frame), expected);
        for (const delayed of [false, true]) {
          const status = await post(path, type, encoding, frame, true, delayed);
          // A decoder may reject trailing bytes or finish the valid first frame.
          // Neither outcome may emit an unhandled stream error or kill the app.
          assert.ok(
            [200, 400].includes(status),
            `${encoding} ${path}: ${status}`,
          );
          const health = await fetch(isolated.target + "/health");
          assert.equal(health.status, 200);
          await health.arrayBuffer();
        }
        assert.equal(await post(path, type, encoding, frame), expected);
      }
    }
  } finally {
    await isolated.close();
  }
});

test("oversized invalid tag collections return bounded errors without persistence and permit a valid retry", async () => {
  const isolated = await fixture();
  try {
    const input = {
      requestId: randomUUID(),
      title: "Synthetic bounded collection",
      source: { originalText: "Synthetic source" },
    };
    const rejected = await isolated.request("/api/items", "POST", {
      ...input,
      tags: Array(24000).fill({}),
    });
    assert.equal(rejected.status, 400);
    assert.ok((await rejected.text()).length < 1024);
    const owner = (await isolated.auth.sessionOwner(isolated.session))!;
    assert.equal((await isolated.library.search(owner, {})).total, 0);
    const accepted = await isolated.request("/api/items", "POST", {
      ...input,
      tags: ["synthetic"],
    });
    assert.equal(accepted.status, 201);
    assert.equal((await isolated.library.search(owner, {})).total, 1);
  } finally {
    await isolated.close();
  }
});

test("executable content stays literal and update mass assignment is rejected", async () => {
  const literal =
    '<img src=x onerror="globalThis.__dropItXss=true"><script>alert(1)</script>';
  const saved = await f.request("/api/items", "POST", {
    requestId: randomUUID(),
    title: literal,
    summary: literal,
    notes: literal,
    source: { originalText: literal },
  });
  assert.equal(saved.status, 201);
  const detail = await saved.json();
  assert.equal(detail.source.originalText, literal);
  for (const field of [
    "owner",
    "source_id",
    "sourceId",
    "createdAt",
    "trashedAt",
    "id",
    "password_hash",
  ]) {
    assert.equal(
      (
        await f.request(`/api/items/${detail.item.id}`, "PATCH", {
          revision: 1,
          [field]: randomUUID(),
        })
      ).status,
      400,
      field,
    );
  }
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///etc/passwd",
    "https://name:secret@example.invalid/",
  ]) {
    assert.equal(
      (
        await f.request("/api/items", "POST", {
          requestId: randomUUID(),
          title: "Rejected source",
          source: { url },
        })
      ).status,
      400,
    );
  }
  const read = await f.request(`/api/items/${detail.item.id}`);
  assert.match(read.headers.get("content-type")!, /^application\/json/);
  assert.equal((await read.json()).item.revision, 1);
});

test("expired sessions and malformed MCP bearer tokens cannot gain access", async () => {
  const expired = await f.auth.login(f.password);
  await f.db.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE hash=$1",
    [(await import("../server/library.js")).digest(expired)],
  );
  assert.equal(
    (
      await f.request("/api/settings", "GET", undefined, {
        Cookie: `drop_it_session=${expired}`,
      })
    ).status,
    401,
  );
  for (const Authorization of [
    "Basic irrelevant",
    "Bearer short",
    `Bearer ${randomBytes(32).toString("base64url")}`,
  ]) {
    const response = await f.request(
      "/mcp",
      "POST",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { Authorization },
    );
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate")!, /invalid_token/);
  }
  assert.equal(
    (
      await f.request(
        "/mcp",
        "POST",
        {},
        { Origin: "https://attacker.invalid" },
      )
    ).status,
    403,
  );
});

test("HTTPS configuration sets host-only secure cookies and disables owner setup", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const remote = await fixture("https://drop-it.example");
  try {
    const setup = await remote.request(
      "/api/setup",
      "POST",
      { password: remote.password },
      { "X-Forwarded-For": "127.0.0.1" },
    );
    assert.equal(setup.status, 403);
    const login = await remote.request("/api/login", "POST", {
      password: remote.password,
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /^__Host-drop_it_session=/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, /; Path=\//);
    assert.doesNotMatch(cookie, /Domain=/);
    assert.match(login.headers.get("strict-transport-security")!, /max-age=/);
  } finally {
    await remote.close();
  }
});

test("login rate limits cannot be reset by a spoofed proxy address", async () => {
  const limited = await fixture();
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal(
        (
          await limited.request("/api/login", "POST", {
            password: randomBytes(24).toString("base64url"),
          })
        ).status,
        401,
      );
    }
    const denied = await limited.request(
      "/api/login",
      "POST",
      { password: limited.password },
      { "X-Forwarded-For": "203.0.113.99" },
    );
    assert.equal(denied.status, 429);
    assert.ok(denied.headers.get("retry-after"));
  } finally {
    await limited.close();
  }
});

test("export slot remains held during aborted builds and releases after completion", async (t) => {
  const isolated = await fixture();
  try {
    const finished = nextExportCompletion(t, isolated.app);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = isolated.library.export.bind(isolated.library);
    const owner = await isolated.auth.sessionOwner(isolated.session);
    const otherOwner = randomUUID();
    await isolated.db.query(
      "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,'synthetic-unusable-hash')",
      [otherOwner],
    );
    const otherSession = await isolated.auth.session(otherOwner);
    const mock = t.mock.method(
      isolated.library,
      "export",
      async (...args: Parameters<typeof original>) => {
        if (args[0] === owner) {
          started();
          await hold;
        }
        return original(...args);
      },
    );
    const controller = new AbortController();
    const first = fetch(isolated.target + "/api/export", {
      headers: { Cookie: isolated.cookie },
      signal: controller.signal,
    });
    await entered;
    const otherExport = await isolated.request(
      "/api/export",
      "GET",
      undefined,
      { Cookie: `drop_it_session=${otherSession}` },
    );
    assert.equal(otherExport.status, 200);
    assert.equal((await otherExport.json()).items.length, 0);
    assert.equal((await isolated.request("/api/export")).status, 429);
    controller.abort();
    await assert.rejects(first);
    assert.equal((await isolated.request("/api/export")).status, 429);
    release();
    const inFlight = mock.mock.calls[0].result;
    assert.ok(inFlight);
    await assert.rejects(inFlight, { name: "AbortError" });
    await finished;
    const completed = await isolated.request("/api/export");
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).items.length, 0);
    assert.equal((await isolated.request("/api/export")).status, 200);
    assert.equal((await isolated.request("/api/export")).status, 429);
  } finally {
    await isolated.close();
  }
});

test("failed export releases capacity for a successful retry", async (t) => {
  const isolated = await fixture();
  try {
    const { AppError } = await import("../server/errors.js");
    const mock = t.mock.method(isolated.library, "export", async () => {
      throw new AppError(413, "EXPORT_SIZE", "The export is too large.");
    });
    assert.equal((await isolated.request("/api/export")).status, 413);
    mock.mock.restore();
    assert.equal((await isolated.request("/api/export")).status, 200);
  } finally {
    await isolated.close();
  }
});

test("legacy download backpressure leaves the database usable and disconnect releases its slot", async (t) => {
  const isolated = await fixture();
  let response: ServerResponse | undefined;
  try {
    const owner = (await isolated.auth.sessionOwner(isolated.session))!;
    const bytes = Buffer.from("漢".repeat(33000));
    const upload = await isolated.library.upload(
      owner,
      bytes,
      "text/plain",
      "slow.txt",
    );
    await isolated.library.save(owner, {
      requestId: randomUUID(),
      title: "Synthetic slow original",
      source: { attachmentId: upload.attachmentId },
    });
    let wrote!: () => void;
    let writes = 0;
    const blocked = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    isolated.server.prependListener("request", (req, res) => {
      if (req.url !== "/api/export") return;
      response = res;
      res.cork();
      const original = res.write.bind(res);
      t.mock.method(res, "write", (chunk: Buffer) => {
        writes++;
        const accepted = original(chunk);
        wrote();
        return accepted;
      });
    });
    const first = fetch(isolated.target + "/api/export", {
      headers: { Cookie: isolated.cookie },
    });
    await blocked;
    assert.equal(writes, 1);
    assert.equal(response!.writableFinished, false);
    const session = await Promise.race([
      isolated.request("/api/session"),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("download retained the database transaction")),
          3000,
        );
        timer.unref();
      }),
    ]);
    assert.equal((await session.json()).authenticated, true);
    response!.uncork();
    const downloaded = await first;
    assert.equal(downloaded.status, 200);
    assert.match(
      downloaded.headers.get("content-disposition") ?? "",
      /drop-it-library\.json/,
    );
    assert.equal(downloaded.headers.get("content-security-policy"), "sandbox");
    const archive = await downloaded.json();
    assert.equal(archive.version, 2);
    assert.deepEqual(
      Buffer.from(archive.sources[0].fileBase64, "base64"),
      bytes,
    );

    const blockedAgain = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    const finished = nextExportCompletion(t, isolated.app);
    const controller = new AbortController();
    const second = fetch(isolated.target + "/api/export", {
      headers: { Cookie: isolated.cookie },
      signal: controller.signal,
    }).then((res) => res.text());
    await blockedAgain;
    controller.abort();
    await assert.rejects(second);
    await finished;
    isolated.server.removeAllListeners("request");
    isolated.server.on("request", isolated.app);
    assert.equal((await isolated.request("/api/export")).status, 200);
  } finally {
    response?.uncork();
    await isolated.close();
  }
});

test("legacy download deadline stays active until response finish", async (t) => {
  const isolated = await fixture();
  try {
    let response!: ServerResponse;
    let reachedEnd!: () => void;
    const ending = new Promise<void>((resolve) => {
      reachedEnd = resolve;
    });
    isolated.server.prependListener("request", (req, res) => {
      if (req.url !== "/api/export") return;
      response = res;
      // Model a final socket write whose finish has not been delivered yet.
      t.mock.method(res, "end", () => {
        reachedEnd();
        return res;
      });
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const download = new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        isolated.target + "/api/export",
        { headers: { Cookie: isolated.cookie } },
        (res) => {
          res.resume();
          res.once("end", resolve);
          res.once("error", reject);
        },
      );
      req.once("error", reject);
      req.end();
    });
    const rejected = assert.rejects(download);
    await ending;
    assert.equal(response.writableFinished, false);
    t.mock.timers.tick(5 * 60000);
    assert.equal(response.destroyed, true);
    await rejected;
    t.mock.timers.reset();
    isolated.server.removeAllListeners("request");
    isolated.server.on("request", isolated.app);
    assert.equal((await isolated.request("/api/export")).status, 200);
  } finally {
    t.mock.timers.reset();
    await isolated.close();
  }
});

test("configuration only accepts HTTP loopback and HTTPS public origins and callbacks", () => {
  const names = [
    "PUBLIC_URL",
    "OAUTH_REDIRECT_URIS",
    "OPENAI_API_KEY",
  ] as const;
  const previous = Object.fromEntries(
    names.map((key) => [key, process.env[key]]),
  );
  try {
    delete process.env.OPENAI_API_KEY;
    process.env.OAUTH_REDIRECT_URIS = "";
    for (const origin of [
      "ftp://localhost",
      "ws://localhost",
      "http://public.example",
      "https://user:pass@example.com",
      "https://example.com/path",
    ]) {
      process.env.PUBLIC_URL = origin;
      assert.throws(loadConfig, Error, origin);
    }
    process.env.PUBLIC_URL = "http://localhost:4317";
    for (const redirect of [
      "ftp://localhost/callback",
      "ws://localhost/callback",
      "http://public.example/callback",
      "https://user:pass@example.com/callback",
      "https://example.com/callback#fragment",
    ]) {
      process.env.OAUTH_REDIRECT_URIS = redirect;
      assert.throws(loadConfig, Error, redirect);
    }
    process.env.OAUTH_REDIRECT_URIS =
      "http://localhost:1234/callback,https://example.com/callback";
    assert.equal(loadConfig().redirectUris.length, 2);
  } finally {
    for (const key of names) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
