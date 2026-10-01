import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
  AccountProvisioningError,
  provisionAccount,
} from "../server/account-provisioning.js";
import { loadConfig } from "../server/config.js";
import { openDatabase } from "../server/db.js";

async function main() {
  if (
    process.argv.length !== 2 ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  )
    throw new AccountProvisioningError(
      "Run npm run account:create in an interactive Render Shell, without arguments or piped input.",
    );
  const config = loadConfig();
  if (!config.databaseUrl || !config.publicAccounts || config.local)
    throw new AccountProvisioningError(
      "This command requires a hosted PUBLIC_URL, DATABASE_URL and ACCOUNT_MODE=public.",
    );

  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: true,
    historySize: 0,
  });
  const abort = new AbortController();
  rl.on("SIGINT", () => abort.abort());
  rl.on("close", () => abort.abort());
  const ask = async (prompt: string, hidden = false) => {
    if (abort.signal.aborted)
      throw new AccountProvisioningError("Cancelled; nothing changed.");
    process.stdout.write(prompt);
    muted = hidden;
    try {
      return await rl.question("", { signal: abort.signal });
    } catch (error) {
      if (abort.signal.aborted)
        throw new AccountProvisioningError("Cancelled; nothing changed.");
      throw error;
    } finally {
      muted = false;
      if (hidden) process.stdout.write("\n");
    }
  };
  let username: string;
  let password: string;
  try {
    process.stdout.write(
      `Create an empty account for ${config.origin}. Existing accounts and signup settings stay unchanged.\n`,
    );
    if ((await ask("Type the full site origin to confirm: ")) !== config.origin)
      throw new AccountProvisioningError(
        "Site confirmation did not match; nothing changed.",
      );
    username = await ask("New username: ");
    password = await ask("New password (15–128 characters; hidden): ", true);
    if (password !== (await ask("Repeat password (hidden): ", true)))
      throw new AccountProvisioningError(
        "Passwords did not match; nothing changed.",
      );
  } finally {
    rl.close();
    output.end();
  }

  const db = await openDatabase(config);
  try {
    // The service must already have migrated its database. No migrations here.
    await provisionAccount(db, username, password);
    process.stdout.write(
      "Account created. Sign in on the site and generate a recovery code in Settings.\n",
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  // Never print parser errors, database connection details or credential values.
  process.stderr.write(
    `${error instanceof AccountProvisioningError ? error.message : "Account setup did not complete cleanly. Check service health and try signing in before retrying."}\n`,
  );
  process.exitCode = 1;
});
