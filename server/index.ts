import "node:process";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { openDatabase, migrate } from "./db.js";
import { createApp } from "./app.js";
import { cleanupExpired } from "./maintenance.js";
import { loadEnvironment } from "./environment.js";

loadEnvironment();
const config = loadConfig();
const db = await openDatabase(config);
await migrate(db);
await cleanupExpired(db);
const maintenance = setInterval(() => {
  void cleanupExpired(db).catch(() =>
    console.error("Maintenance failed", { code: "MAINTENANCE_ERROR" }),
  );
}, 3600000);
maintenance.unref();
const html = await readFile(
  new URL("../dist/web/index.html", import.meta.url),
  "utf8",
);
const { app, close } = createApp(db, config, html);
const closeResources = async () => {
  try {
    await close();
  } finally {
    await db.close();
  }
};
const server = app.listen(
  config.port,
  config.local ? "127.0.0.1" : "0.0.0.0",
  () => console.log(`Drop It is ready at ${config.origin}`),
);
server.on("error", () => {
  console.error("Could not start Drop It. Check the configured port.");
  void closeResources().finally(() => process.exit(1));
});
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(maintenance);
    // Never keep a draining deployment alive indefinitely on a stalled socket
    // or database. In-flight transactions are rolled back on disconnection.
    const deadline = setTimeout(() => process.exit(1), 20000);
    deadline.unref();
    server.close(() => {
      void closeResources().then(
        () => {
          clearTimeout(deadline);
          process.exit(0);
        },
        () => {
          clearTimeout(deadline);
          process.exit(1);
        },
      );
    });
    server.closeIdleConnections();
  });
