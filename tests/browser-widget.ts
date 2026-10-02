// Loopback-only synthetic host for the actual built React widget. No app server,
// environment files, credentials, database, or external providers are loaded.
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

if (process.env.DROP_IT_BROWSER_TEST !== "1")
  throw new Error("Opt-in required");

const fixtures = new URL("./widget-fixture/", import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "drop-it-widget-browser-"));
const seedPath = join(directory, "widget-file-b.txt");
await writeFile(seedPath, "Immutable synthetic source B.\n");
const widgetPath = new URL("../dist/web/index.html", import.meta.url);
const host = await readFile(new URL("index.html", fixtures), "utf8");
const bundled = await build({
  configFile: false,
  logLevel: "error",
  build: {
    write: false,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL("host.ts", fixtures)),
      formats: ["iife"],
      name: "SyntheticWidgetHost",
    },
  },
});
const bundle = Array.isArray(bundled) ? bundled[0] : bundled;
if (!bundle || !("output" in bundle))
  throw new Error("Unexpected host build result");
const script = bundle.output.find((entry) => entry.type === "chunk");
if (!script || script.type !== "chunk") throw new Error("Host bundle missing");
const shim = `<script>window.openai={uploadFile:file=>window.parent.syntheticWidgetUpload(file),getFileDownloadUrl:async({fileId})=>({downloadUrl:location.origin+"/synthetic-file/"+encodeURIComponent(fileId)}),setWidgetState:state=>window.parent.syntheticWidgetState(state)};</script>`;
const server = createServer((req, res) => {
  if (req.headers.host !== new URL(origin).host || req.method !== "GET") {
    res.writeHead(403);
    res.end();
    return;
  }
  const path = new URL(req.url ?? "/", origin).pathname;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'",
  );
  if (path === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end(host);
  } else if (path === "/host.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(script.code);
  } else if (path === "/widget") {
    res.setHeader("Content-Type", "text/html");
    void readFile(widgetPath, "utf8").then(
      (widget) => res.end(widget.replace("</head>", `${shim}</head>`)),
      () => {
        res.writeHead(503);
        res.end("Build the web widget before loading this fixture.");
      },
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});
let origin = "";
server.listen(0, "127.0.0.1");
await once(server, "listening");
origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const stop = async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
console.log(
  JSON.stringify({
    origin,
    seedPath,
    controls: "tests/widget-fixture/index.html",
    builtWidget: "dist/web/index.html",
  }),
);
