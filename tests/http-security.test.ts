import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { createApp } from "../server/app.js";
import { loadConfig, type Config } from "../server/config.js";
import { migrate, openDatabase } from "../server/db.js";

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
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = isolated.library.export.bind(isolated.library);
    const mock = t.mock.method(
      isolated.library,
      "export",
      async (owner: string) => {
        started();
        await hold;
        return original(owner);
      },
    );
    const controller = new AbortController();
    const first = fetch(isolated.target + "/api/export", {
      headers: { Cookie: isolated.cookie },
      signal: controller.signal,
    });
    await entered;
    assert.equal((await isolated.request("/api/export")).status, 429);
    controller.abort();
    await assert.rejects(first);
    assert.equal((await isolated.request("/api/export")).status, 429);
    release();
    await mock.mock.calls[0].result;
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
