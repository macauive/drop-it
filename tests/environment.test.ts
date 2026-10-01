import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvironment } from "../server/environment.js";

test("loads private env only and preserves process configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drop-it-env-"));
  const variable = "DROP_IT_ENV_TEST_VALUE";
  const original = process.env[variable];
  delete process.env[variable];
  try {
    await writeFile(join(dir, ".env"), `${variable}=root-test-value\n`);
    loadEnvironment(dir);
    assert.equal(process.env[variable], undefined);
    await mkdir(join(dir, "private"), { mode: 0o700 });
    await writeFile(
      join(dir, "private/.env"),
      `${variable}=private-test-value\n`,
      { mode: 0o600 },
    );
    loadEnvironment(dir);
    assert.equal(process.env[variable], "private-test-value");
    process.env[variable] = "process-test-value";
    loadEnvironment(dir);
    assert.equal(process.env[variable], "process-test-value");
  } finally {
    if (original === undefined) delete process.env[variable];
    else process.env[variable] = original;
    await rm(dir, { recursive: true, force: true });
  }
});
