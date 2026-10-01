import { loadEnvironment } from "../server/environment.js";
import { loadConfig } from "../server/config.js";
loadEnvironment();
try {
  const c = loadConfig();
  const checks: Array<[string, boolean]> = [
    ["Production mode", c.production],
    ["Public HTTPS origin", !c.local],
    ["Hosted PostgreSQL configured", Boolean(c.databaseUrl)],
    ["Public accounts configured", Boolean(c.publicAccounts)],
    ["OAuth callback allowlist configured", c.redirectUris.length > 0],
    ["AI key configured (not verified)", Boolean(c.ai)],
    [
      "Publisher, support and backup retention configured",
      Boolean(c.publicSite),
    ],
  ];
  for (const [label, ok] of checks)
    console.log(`${ok ? "PASS" : "MISSING"}: ${label}`);
  console.log(
    "Preflight does not connect to providers, verify credentials, run migrations or prove live ChatGPT compatibility.",
  );
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
} catch {
  console.error(
    "Invalid deployment configuration. Check documented environment settings; values are not printed.",
  );
  process.exitCode = 1;
}
