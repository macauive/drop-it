import { resolve } from "node:path";

export function loadEnvironment(workspace = process.cwd()) {
  try {
    process.loadEnvFile(resolve(workspace, "private/.env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      // Never include a secret-bearing parser error in startup logs.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        "Could not load private/.env. Check its format and permissions.",
      );
  }
}
