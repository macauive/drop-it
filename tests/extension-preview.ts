// Loopback-only verification fixture. Uses temporary synthetic accounts/data.
// Never included in either extension or plugin packages.
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { createApp } from "../server/app.js";
import { openDatabase, migrate } from "../server/db.js";

const { createController } = await import(
  new URL("../extension/controller.js", import.meta.url).href
);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "drop-it-extension-preview-"));
const db = await openDatabase({ dataDir: directory });
await migrate(db);
const server = createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as { port: number }).port,
  origin = `http://127.0.0.1:${port}`;
const extensionId = "a".repeat(32),
  redirect = `https://${extensionId}.chromiumapp.org/drop-it`;
const html = await readFile(resolve(root, "dist/web/index.html"), "utf8");
const built = createApp(
  db,
  {
    origin,
    port,
    local: true,
    production: false,
    dataDir: directory,
    databaseUrl: undefined,
    ai: undefined,
    redirectUris: [redirect, `${origin}/callback`],
  },
  html,
);
const firstSession = await built.auth.setup(
  randomBytes(24).toString("base64url"),
);
const firstOwner = (await built.auth.sessionOwner(firstSession))!;
const secondOwner = randomUUID();
await db.query("UPDATE users SET username=$1 WHERE id=$2", [
  "capture-a",
  firstOwner,
]);
await db.query(
  "INSERT INTO users(id,singleton,username,password_hash) VALUES($1,NULL,$2,$3)",
  [secondOwner, "capture-b", "synthetic-unusable-hash"],
);
const secondSession = await db.transaction((tx) =>
  built.auth.issueSession(tx, secondOwner),
);
for (const [owner, pool, tag] of [
  [firstOwner, "Reading", "ideas"],
  [firstOwner, "Gardening", "herbs"],
  [secondOwner, "Private B", "only-b"],
])
  await built.library.save(owner, {
    requestId: randomUUID(),
    title: "Synthetic suggestion source",
    category: pool,
    tags: [tag],
    source: { url: `https://example.org/${randomUUID()}` },
  });
const sessionState: Record<string, unknown> = {};
const clients = new Set<ServerResponse>();
let account = "a",
  selection = "",
  offline = false,
  loseResponse = false,
  lastReview = "";
let tab = {
  id: 7,
  title: "A calmer place for your ideas",
  url: "https://example.org/article#source",
};
const currentSession = () => (account === "a" ? firstSession : secondSession);
const api = {
  storage: {
    session: {
      async get(input: string | string[]) {
        return structuredClone(
          Object.fromEntries(
            (Array.isArray(input) ? input : [input]).map((key) => [
              key,
              sessionState[key],
            ]),
          ),
        );
      },
      async set(input: Record<string, unknown>) {
        Object.assign(sessionState, structuredClone(input));
      },
      async remove(key: string) {
        delete sessionState[key];
      },
    },
  },
  identity: {
    getRedirectURL: () => redirect,
    async launchWebAuthFlow({ url }: { url: string }) {
      const auth = await fetch(url, { redirect: "manual" });
      const pending = new URL(auth.headers.get("location")!).searchParams.get(
        "authorize",
      );
      const consent = await fetch(`${origin}/api/authorize/${pending}`, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: `drop_it_session=${currentSession()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ approved: true }),
      });
      return (await consent.json()).redirect;
    },
  },
  runtime: {
    getURL: (path: string) => `${origin}/${path}`,
    async sendMessage(message: unknown) {
      for (const client of clients)
        client.write(`data: ${JSON.stringify(message)}\n\n`);
    },
  },
  tabs: {
    async query() {
      return [tab];
    },
    async get(id: number) {
      if (id !== tab.id) throw new Error("Source tab closed");
      return tab;
    },
    async create() {},
  },
  scripting: {
    async executeScript() {
      if (!tab.url.startsWith("http")) throw new Error("Restricted page");
      return [{ result: selection }];
    },
  },
  commands: {
    async getAll() {
      return [{ name: "_execute_action", shortcut: "Command+Shift+Y" }];
    },
  },
  windows: {
    async create(value: { url: string }) {
      lastReview = value.url;
    },
  },
};
const transport = async (url: string, init: RequestInit) => {
  if (offline && new URL(url).pathname.startsWith("/extension/"))
    throw new Error("Synthetic offline fixture");
  const response = await fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      ...(new URL(url).pathname.startsWith("/extension/")
        ? { Origin: `chrome-extension://${extensionId}` }
        : {}),
    },
  });
  if (loseResponse && new URL(url).pathname.endsWith("/capture")) {
    loseResponse = false;
    await response.arrayBuffer();
    throw new Error("Synthetic response loss");
  }
  return response;
};
let controller = createController(api, origin, transport);
const scenario = z.discriminatedUnion("type", [
  z.object({ type: z.literal("account"), value: z.enum(["a", "b"]) }).strict(),
  z
    .object({ type: z.literal("selection"), text: z.string().max(50000) })
    .strict(),
  z.object({ type: z.literal("offline"), value: z.boolean() }).strict(),
  z
    .object({
      type: z.enum([
        "worker-restart",
        "revoke",
        "lose-response",
        "restricted",
        "page",
        "frame",
        "link",
      ]),
    })
    .strict(),
]);
const assets = new Set([
  "popup.html",
  "popup.js",
  "popup.css",
  "icons/16.png",
  "icons/32.png",
  "icons/48.png",
  "icons/128.png",
]);
server.on("request", async (req, res) => {
  try {
    const path = new URL(req.url!, origin).pathname;
    if (path.startsWith("/preview/") || assets.has(path.slice(1))) {
      res.setHeader("Cache-Control", "no-store");
      if (path === "/preview/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": ready\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (path === "/preview/browser-api.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.end(
          `const handlers=[];globalThis.chrome={runtime:{id:${JSON.stringify(extensionId)},onMessage:{addListener(fn){handlers.push(fn)}},async sendMessage(message){const response=await fetch('/preview/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)});return response.json()}}};const events=new EventSource('/preview/events');events.onmessage=event=>{for(const handler of handlers)handler(JSON.parse(event.data),{id:chrome.runtime.id})};`,
        );
        return;
      }
      if (
        (path === "/preview/message" || path === "/preview/scenario") &&
        req.method === "POST"
      ) {
        if (req.headers.origin !== origin) {
          res.writeHead(403);
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 350000) throw new Error("Preview input too large");
          chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        try {
          let data;
          if (path === "/preview/message")
            data = await controller.handle(input);
          else {
            const action = scenario.parse(input);
            switch (action.type) {
              case "account":
                account = action.value;
                data = await controller.handle({ type: "connect" });
                break;
              case "selection":
                selection = action.text;
                break;
              case "offline":
                offline = action.value;
                break;
              case "worker-restart":
                controller = createController(api, origin, transport);
                break;
              case "revoke":
                await db.query("DELETE FROM oauth_tokens WHERE owner=$1", [
                  account === "a" ? firstOwner : secondOwner,
                ]);
                break;
              case "lose-response":
                loseResponse = true;
                break;
              case "restricted":
                tab = { ...tab, url: "chrome://settings" };
                break;
              case "page":
                tab = { ...tab, url: "https://example.org/article#source" };
                selection = "";
                break;
              case "frame":
                await controller.context(
                  {
                    menuItemId: "drop-selection",
                    pageUrl: tab.url,
                    frameUrl: "https://example.org/frame#section",
                    selectionText: "Selected within a frame — 漢字 🌱",
                  },
                  tab,
                );
                data = { url: lastReview };
                break;
              case "link":
                await controller.context(
                  {
                    menuItemId: "drop-link",
                    pageUrl: tab.url,
                    linkUrl: "https://example.org/linked-idea#reading",
                  },
                  tab,
                );
                data = { url: lastReview };
                break;
            }
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, data }));
        } catch (error) {
          const e = error as {
            message: string;
            code?: string;
            items?: unknown;
          };
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              ok: false,
              error: e.message,
              code: e.code,
              items: e.items,
            }),
          );
        }
        return;
      }
      if (path === "/preview/library") {
        res.setHeader(
          "Set-Cookie",
          `drop_it_session=${currentSession()}; HttpOnly; SameSite=Lax; Path=/`,
        );
        res.writeHead(303, { Location: "/" });
        res.end();
        return;
      }
      const file = path.slice(1);
      if (!assets.has(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const input = await readFile(
        resolve(
          root,
          path.startsWith("/icons/")
            ? `dist/chrome-extension/${file}`
            : `extension/${file}`,
        ),
      );
      res.setHeader(
        "Content-Type",
        file.endsWith(".html")
          ? "text/html"
          : file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "image/png",
      );
      res.end(
        file === "popup.html"
          ? input
              .toString()
              .replace(
                '<script type="module" src="popup.js">',
                '<script src="/preview/browser-api.js"></script><script type="module" src="popup.js">',
              )
          : input,
      );
      return;
    }
    built.app(req, res);
  } catch {
    res.writeHead(500);
    res.end("Preview fixture failed");
  }
});
console.log(`Extension preview: ${origin}/popup.html`);
async function close() {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await built.close();
  await db.close();
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
