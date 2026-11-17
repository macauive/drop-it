// Disposable loopback fixture. Never reads environment files or real accounts.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/app.js";

const dir = await mkdtemp(join(tmpdir(), "drop-it-onboarding-browser-"));
const db = await openDatabase({ dataDir: dir });
await migrate(db);
const origin = "http://127.0.0.1:4331";
const extensionRedirect =
  "https://aiaflcebjdegligolapfpgdplbofplbo.chromiumapp.org/drop-it";
const chatgptRedirect =
  "https://chatgpt.com/connector/oauth/synthetic-onboarding";
const built = createApp(
  db,
  {
    origin,
    port: 4331,
    local: true,
    production: false,
    databaseUrl: undefined,
    ai: undefined,
    dataDir: dir,
    publicAccounts: true,
    signupEnabled: false,
    redirectUris: [extensionRedirect, chatgptRedirect],
    publicSite: {
      publisher: "Synthetic fixture",
      supportEmail: "support@example.test",
      backupRetentionDays: 3,
    },
  },
  await readFile(new URL("../dist/web/index.html", import.meta.url), "utf8"),
);
const owners = [randomUUID(), randomUUID()];
const sessions: string[] = [];
for (const [index, owner] of owners.entries()) {
  await db.query(
    "INSERT INTO users(id,singleton,password_hash,username) VALUES($1,NULL,'synthetic-unusable-hash',$2)",
    [owner, `synthetic-setup-${index}`],
  );
  sessions.push(await built.auth.session(owner));
}
await built.library.save(owners[1], {
  requestId: randomUUID(),
  title: "Second account private cactus",
  tags: [],
  source: { originalText: "Synthetic account isolation evidence." },
});
const server = createServer((req, res) => {
  const account =
    req.url === "/synthetic-new" ? 0 : req.url === "/synthetic-other" ? 1 : -1;
  if (account !== -1) {
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": `drop_it_session=${sessions[account]}; HttpOnly; SameSite=Lax; Path=/`,
    });
    res.end();
  } else built.app(req, res);
}).listen(4331, "127.0.0.1", () => console.log(`${origin}/synthetic-new`));
// Optional synthetic grant, without touching a provider or a real connection.
process.stdin.on("data", (chunk) => {
  if (chunk.toString().trim() !== "connect") return;
  void (async () => {
    const client = randomUUID();
    await db.query("INSERT INTO oauth_clients(id,data) VALUES($1,$2)", [
      client,
      JSON.stringify({ redirect_uris: [chatgptRedirect] }),
    ]);
    await db.query(
      `INSERT INTO oauth_tokens(hash,family,owner,client_id,kind,scopes,resource,expires_at)
      VALUES($1,$2,$3,$4,'refresh',$5,$6,clock_timestamp()+interval '1 hour')`,
      [
        randomUUID(),
        randomUUID(),
        owners[0],
        client,
        ["library:read"],
        `${origin}/mcp`,
      ],
    );
    console.log("Synthetic connection ready");
  })();
});
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    server.closeAllConnections();
    server.close(
      () =>
        void built
          .close()
          .then(() => db.close())
          .then(() => rm(dir, { recursive: true, force: true }))
          .finally(() => process.exit(0)),
    );
  });
