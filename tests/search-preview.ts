// Local-only in-app-browser fixture, with synthetic content and mocked AI.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/app.js";
import { embeddingVersion } from "../server/semantic.js";
import { searchProvider, seedSearchLibrary } from "./search-fixture.js";

const dir = await mkdtemp(join(tmpdir(), "drop-it-search-browser-"));
const db = await openDatabase({ dataDir: dir });
await migrate(db);
const { owner } = await seedSearchLibrary(db);
const html = await readFile(
  new URL("../dist/web/index.html", import.meta.url),
  "utf8",
);
const port = 4329,
  origin = `http://127.0.0.1:${port}`;
const built = createApp(
  db,
  {
    port,
    origin,
    local: true,
    production: false,
    redirectUris: [],
    dataDir: dir,
    ai: undefined,
    databaseUrl: undefined,
  },
  html,
  searchProvider(),
);
await built.library.setPreferences(owner, { aiSearchEnabled: true });
await db.query(
  `INSERT INTO item_embeddings(owner,item_id,model,fingerprint,vector,embedding,indexed_revision)
  SELECT i.owner,i.id,$2,'synthetic-preview',v.a,v.a::vector(512),i.revision
  FROM items i JOIN sources s ON s.owner=i.owner AND s.id=i.source_id
  CROSS JOIN LATERAL (SELECT ARRAY(SELECT CASE WHEN n=substring(s.original_text from 7 for 1)::integer THEN 1.0 ELSE 0.0 END
    FROM generate_series(0,511) AS n) AS a) v WHERE i.owner=$1`,
  [owner, embeddingVersion],
);
await db.query(
  "DELETE FROM item_embeddings WHERE owner=$1 AND item_id IN (SELECT id FROM items WHERE owner=$1 ORDER BY id LIMIT 64)",
  [owner],
);
const session = await built.auth.session(owner);
// This fixture route is absent from the production application and listens only
// on loopback. It establishes a synthetic session without displaying a token.
const server = createServer((req, res) => {
  if (req.url === "/synthetic-search-signin") {
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": `drop_it_session=${session}; HttpOnly; SameSite=Lax; Path=/`,
    });
    res.end();
  } else built.app(req, res);
}).listen(port, "127.0.0.1", () =>
  console.log(`${origin}/synthetic-search-signin`),
);
process.stdin.on("data", (chunk) => {
  if (chunk.toString().includes("index")) built.library.searchIndexer.start();
});
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    server.closeAllConnections();
    server.close(() => {
      void built
        .close()
        .then(() => db.close())
        .then(() => rm(dir, { recursive: true, force: true }))
        .finally(() => process.exit(0));
    });
  });
