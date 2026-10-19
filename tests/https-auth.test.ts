import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer, request as httpRequest } from "node:http";
import {
  createServer as httpsServer,
  request as httpsRequest,
} from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/app.js";
import { digest } from "../server/library.js";
import type { Config } from "../server/config.js";
const run = promisify(execFile),
  password = () => randomBytes(24).toString("base64url");

test("HTTPS proxy preserves legacy and email auth, host-only cookies, CSRF, MCP and shared login throttling", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "drop-it-https-"));
  const db = await openDatabase({ dataDir });
  await migrate(db);
  const backend = httpServer((req, res) => built.app(req, res));
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const backendPort = (backend.address() as { port: number }).port;
  const keyFile = join(dataDir, "key.pem"),
    certFile = join(dataDir, "cert.pem");
  await run(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { timeout: 10000 },
  );
  const key = await readFile(keyFile),
    cert = await readFile(certFile);
  const proxy = httpsServer({ key, cert }, (req, res) => {
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: backendPort,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          // A trusted ingress replaces, rather than appends, untrusted forwarding headers.
          "x-forwarded-for": req.socket.remoteAddress!,
          "x-forwarded-proto": "https",
        },
      },
      (response) => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const port = (proxy.address() as { port: number }).port,
    origin = `https://127.0.0.1:${port}`;
  const config: Config = {
    port,
    origin,
    local: false,
    production: true,
    dataDir,
    databaseUrl: undefined,
    ai: undefined,
    redirectUris: [],
    publicAccounts: true,
    signupEnabled: true,
    trustProxy: 1,
    emailAuth: {
      secret: password(),
      from: "sender@example.test",
      apiKey: "re_" + password(),
      deliveryKey: randomBytes(32).toString("hex"),
    },
  };
  const mail: { code: string; purpose: string }[] = [];
  const built = createApp(
    db,
    config,
    "<!doctype html><title>HTTPS auth fixture</title>",
    undefined,
    fetch,
    async (_email, code, purpose) => {
      mail.push({ code, purpose });
    },
  );
  const request = (
    path: string,
    body?: unknown,
    cookie = "",
    headers: Record<string, string> = {},
  ) =>
    new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      body: Record<string, unknown>;
    }>((resolve, reject) => {
      const req = httpsRequest(
        origin + path,
        {
          ca: cert,
          servername: "localhost",
          rejectUnauthorized: true,
          method: body === undefined ? "GET" : "POST",
          headers: {
            Origin: origin,
            Cookie: cookie,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            ...headers,
          },
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on("data", (chunk) => parts.push(Buffer.from(chunk)));
          res.on("end", () => {
            const value = Buffer.concat(parts).toString();
            void built.emailAuth.delivery!.processPending().then(
              () =>
                resolve({
                  status: res.statusCode!,
                  headers: res.headers,
                  body: value ? JSON.parse(value) : {},
                }),
              reject,
            );
          });
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  try {
    // Explicitly trust only this generated fixture certificate, never weaken
    // browser/system certificate checks or install a certificate authority.
    await assert.rejects(fetch(origin + "/ready"));
    assert.equal((await request("/ready")).status, 200);
    const pass = password(),
      legacy = await built.auth.register("https_legacy", pass),
      owner = (await built.auth.sessionOwner(legacy))!;
    const bearer = randomBytes(32).toString("base64url");
    await db.query(
      "INSERT INTO oauth_tokens(hash,family,owner,client_id,kind,scopes,resource,expires_at) VALUES($1,$2,$3,$4,'access',$5,$6,now()+interval '1 hour')",
      [
        digest(bearer),
        randomUUID(),
        owner,
        randomUUID(),
        ["library:read"],
        origin + "/mcp",
      ],
    );
    const login = await request("/api/login", {
      username: "https_legacy",
      password: pass,
    });
    assert.equal(login.status, 200);
    const cookie = login.headers["set-cookie"]![0].split(";")[0];
    assert.match(login.headers["set-cookie"]![0], /^__Host-drop_it_session=/);
    assert.match(login.headers["set-cookie"]![0], /Secure/);
    assert.match(login.headers["set-cookie"]![0], /HttpOnly/);
    assert.match(login.headers["set-cookie"]![0], /SameSite=Lax/);
    assert.doesNotMatch(login.headers["set-cookie"]![0], /Domain=/);
    assert.equal(
      (await request("/api/session", undefined, cookie)).body.authenticated,
      true,
    );
    assert.equal(
      (
        await request(
          "/api/email/link",
          { email: "https-legacy@example.test", currentPassword: pass },
          cookie,
          { Origin: "https://attacker.invalid" },
        )
      ).status,
      403,
    );
    const link = await request(
      "/api/email/link",
      { email: "https-legacy@example.test", currentPassword: pass },
      cookie,
    );
    assert.equal(
      (
        await request(
          "/api/email/verify-link",
          {
            requestId: link.body.requestId,
            code: mail.at(-1)!.code,
            currentPassword: pass,
          },
          cookie,
        )
      ).status,
      200,
    );
    assert.ok(await built.auth.sessionOwner(legacy));
    assert.equal(
      (await built.auth.verifyAccessToken(bearer)).extra?.owner,
      owner,
    );
    assert.equal(
      (
        await request("/api/login", {
          email: "https-legacy@example.test",
          password: pass,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/session", undefined, "", {
          Host: "attacker.invalid",
        })
      ).status,
      400,
    );
    const signup = await request("/api/register", {
      email: "https-signup@example.test",
      password: pass,
    });
    assert.equal(signup.status, 200);
    assert.equal(signup.headers["set-cookie"], undefined);
    assert.equal(
      (
        await request("/api/email/verify-signup", {
          requestId: signup.body.requestId,
          code: mail.at(-1)!.code,
          password: pass,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/login", {
          email: "https-signup@example.test",
          password: pass,
        })
      ).status,
      200,
    );
    // Browser cookies alone cannot authorize MCP, even on HTTPS.
    const rpc = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_profile", arguments: {} },
    };
    const cookieOnly = await request("/mcp", rpc, cookie, {
      Accept: "application/json, text/event-stream",
    });
    assert.equal(cookieOnly.status, 200);
    assert.equal(
      (cookieOnly.body.result as { isError: boolean }).isError,
      true,
    );
    const connected = await request("/mcp", rpc, "", {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
    });
    assert.equal(connected.status, 200);
    assert.notEqual(
      (connected.body.result as { isError?: boolean }).isError,
      true,
    );
    // Requests with rotating spoofed IPs still consume the same ingress budget.
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const result = await request(
        "/api/login",
        { email: "unknown@example.test", password: pass },
        "",
        { "x-forwarded-for": `192.0.2.${i + 1}` },
      );
      if (result.status === 429) {
        limited = true;
        break;
      }
    }
    assert.equal(limited, true);
  } finally {
    proxy.closeAllConnections();
    backend.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => backend.close(() => resolve())),
    ]);
    await built.close();
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
