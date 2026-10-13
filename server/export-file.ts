import { chmod, lstat, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Library } from "./library.js";
import { AppError } from "./errors.js";

const prefix = "drop-it-legacy-export-";
const maximumBytes = 384 * 1024 * 1024;

async function cleanupAbandonedExports() {
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !/^drop-it-legacy-export-[A-Za-z0-9]{6}$/.test(entry.name)
    )
      continue;
    const path = join(tmpdir(), entry.name);
    try {
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" &&
          info.uid !== process.getuid()) ||
        info.mtimeMs > Date.now() - 20 * 60000
      )
        continue;
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

// The authenticated route holds its single export slot through staging and
// delivery. Downloads never keep either database adapter's transaction open.
export async function stageLegacyExport(
  library: Pick<Library, "export">,
  owner: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await cleanupAbandonedExports();
  const directory = await mkdtemp(join(tmpdir(), prefix));
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let complete = false;
  try {
    await chmod(directory, 0o700);
    const path = join(directory, "library.json");
    file = await open(path, "wx", 0o600);
    let bytes = 0;
    await library.export(
      owner,
      async (chunk) => {
        signal.throwIfAborted();
        bytes += Buffer.byteLength(chunk);
        if (bytes > maximumBytes)
          throw new AppError(
            413,
            "EXPORT_SIZE",
            "This library exceeds the size limit for a single JSON export.",
          );
        await file!.writeFile(chunk, { signal });
      },
      signal,
    );
    await file.close();
    file = undefined;
    signal.throwIfAborted();
    complete = true;
    return {
      path,
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } finally {
    if (!complete) {
      try {
        await file?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
