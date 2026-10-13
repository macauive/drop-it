import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { stageLegacyExport } from "../server/export-file.js";
import type { Library } from "../server/library.js";

type ExportLibrary = Pick<Library, "export">;

// TMPDIR is process-wide, so these tests run serially and restore it even when
// an assertion fails. Cleanup can only see fixtures in this test's own root.
async function withTemporaryRoot(run: (root: string) => Promise<void>) {
  const previous = process.env.TMPDIR;
  const root = await mkdtemp(join(tmpdir(), "drop-it-export-test-"));
  process.env.TMPDIR = root;
  try {
    assert.equal(tmpdir(), root);
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function stagedPath(root: string) {
  const entries = await readdir(root);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^drop-it-legacy-export-[A-Za-z0-9]{6}$/);
  return join(root, entries[0], "library.json");
}

test("legacy export awaits each write, preserves exact UTF-8 bytes, and disposes private staging", async () => {
  await withTemporaryRoot(async (root) => {
    const signal = new AbortController().signal;
    const chunks = ['{"items":[', '{"title":"Café 🛰️ 東京","text":"line\\n', 'next"}]}\n'];
    let expected = "";
    let path = "";
    const library: ExportLibrary = {
      export: async (owner, write, receivedSignal) => {
        assert.equal(owner, "synthetic-owner");
        assert.equal(receivedSignal, signal);
        path = await stagedPath(root);
        for (const chunk of chunks) {
          await write(chunk);
          expected += chunk;
          // A resolved writer must make the whole chunk available before the
          // library advances to its next fragment.
          assert.deepEqual(await readFile(path), Buffer.from(expected));
        }
      },
    };

    const staged = await stageLegacyExport(library, "synthetic-owner", signal);
    assert.equal(staged.path, path);
    assert.deepEqual(await readFile(staged.path), Buffer.from(chunks.join("")));
    assert.equal((await lstat(dirname(staged.path))).mode & 0o777, 0o700);
    assert.equal((await lstat(staged.path)).mode & 0o777, 0o600);

    await staged.dispose();
    assert.deepEqual(await readdir(root), []);
    await staged.dispose();
  });
});

test("legacy export does not return staging until the exporter completes", async () => {
  await withTemporaryRoot(async (root) => {
    let release!: () => void;
    let reached!: () => void;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const library: ExportLibrary = {
      export: async (_owner, write) => {
        await write('{"items":[');
        reached();
        await completed;
        await write("]}");
      },
    };
    let settled = false;
    const pending = stageLegacyExport(
      library,
      "synthetic-owner",
      new AbortController().signal,
    ).then((result) => {
      settled = true;
      return result;
    });
    try {
      await writing;
      assert.equal(settled, false);
      assert.equal(await readFile(await stagedPath(root), "utf8"), '{"items":[');
      release();
      const staged = await pending;
      assert.equal(await readFile(staged.path, "utf8"), '{"items":[]}');
    } finally {
      release();
      const staged = await pending;
      await staged.dispose();
    }
    assert.deepEqual(await readdir(root), []);
  });
});

test("a rejected legacy export removes its partial file and directory", async () => {
  await withTemporaryRoot(async (root) => {
    const failure = new Error("synthetic exporter failure");
    const library: ExportLibrary = {
      export: async (_owner, write) => {
        await write('{"partial":"東京"');
        assert.equal(
          await readFile(await stagedPath(root), "utf8"),
          '{"partial":"東京"',
        );
        throw failure;
      },
    };
    await assert.rejects(
      stageLegacyExport(library, "synthetic-owner", new AbortController().signal),
      (error) => error === failure,
    );
    assert.deepEqual(await readdir(root), []);
  });
});

test("an abort during legacy export removes partial staging", async () => {
  await withTemporaryRoot(async (root) => {
    const controller = new AbortController();
    const failure = new Error("synthetic cancellation");
    const library: ExportLibrary = {
      export: async (_owner, write) => {
        await write('{"partial":');
        assert.equal(
          await readFile(await stagedPath(root), "utf8"),
          '{"partial":',
        );
        controller.abort(failure);
        await write("true}");
      },
    };
    await assert.rejects(
      stageLegacyExport(library, "synthetic-owner", controller.signal),
      (error) => error === failure,
    );
    assert.deepEqual(await readdir(root), []);
  });
});

test("an abort after the exporter finishes removes complete staging", async () => {
  await withTemporaryRoot(async (root) => {
    const controller = new AbortController();
    const failure = new Error("synthetic late cancellation");
    const library: ExportLibrary = {
      export: async (_owner, write) => {
        await write("{}");
        controller.abort(failure);
      },
    };
    await assert.rejects(
      stageLegacyExport(library, "synthetic-owner", controller.signal),
      (error) => error === failure,
    );
    assert.deepEqual(await readdir(root), []);
  });
});

test("a pre-aborted export creates no staging and never invokes the exporter", async () => {
  await withTemporaryRoot(async (root) => {
    const controller = new AbortController();
    const failure = new Error("synthetic early cancellation");
    controller.abort(failure);
    const library: ExportLibrary = {
      export: async () => {
        assert.fail("a pre-aborted export must not invoke the exporter");
      },
    };
    await assert.rejects(
      stageLegacyExport(library, "synthetic-owner", controller.signal),
      (error) => error === failure,
    );
    assert.deepEqual(await readdir(root), []);
  });
});

test("cleanup removes only old private matching export directories", async () => {
  await withTemporaryRoot(async (root) => {
    const old = new Date(Date.now() - 30 * 60_000);
    const oldName = "drop-it-legacy-export-OLD123";
    const freshName = "drop-it-legacy-export-NEW123";
    const unsafeName = "drop-it-legacy-export-PUB123";
    const nonmatchingName = "drop-it-legacy-export-long-name";
    const targetName = "symlink-target";
    const linkName = "drop-it-legacy-export-LNK123";
    const fileName = "drop-it-legacy-export-FIL123";
    for (const [name, mode, modified] of [
      [oldName, 0o700, old],
      [freshName, 0o700, new Date()],
      [unsafeName, 0o755, old],
      [nonmatchingName, 0o700, old],
      [targetName, 0o700, old],
    ] as const) {
      const path = join(root, name);
      await mkdir(path);
      await chmod(path, mode);
      await writeFile(join(path, "fixture.txt"), "synthetic fixture");
      await utimes(path, modified, modified);
    }
    await symlink(join(root, targetName), join(root, linkName));
    await writeFile(join(root, fileName), "synthetic file");
    await chmod(join(root, fileName), 0o600);
    await utimes(join(root, fileName), old, old);
    const library: ExportLibrary = {
      export: async (_owner, write) => {
        await write("{}");
      },
    };

    const staged = await stageLegacyExport(
      library,
      "synthetic-owner",
      new AbortController().signal,
    );
    await assert.rejects(lstat(join(root, oldName)), { code: "ENOENT" });
    for (const name of [freshName, unsafeName, nonmatchingName, targetName]) {
      assert.equal(
        await readFile(join(root, name, "fixture.txt"), "utf8"),
        "synthetic fixture",
      );
    }
    assert.equal((await lstat(join(root, freshName))).mode & 0o777, 0o700);
    assert.equal((await lstat(join(root, unsafeName))).mode & 0o777, 0o755);
    assert.equal((await lstat(join(root, linkName))).isSymbolicLink(), true);
    assert.equal(await readFile(join(root, fileName), "utf8"), "synthetic file");
    await staged.dispose();
    assert.deepEqual(
      (await readdir(root)).sort(),
      [freshName, unsafeName, nonmatchingName, targetName, linkName, fileName].sort(),
    );
  });
});
