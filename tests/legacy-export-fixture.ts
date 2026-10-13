import type { Library } from "../server/library.js";
import type { Item, Source } from "../shared/schema.js";

type LegacyExport = {
  version: 2;
  exportedAt: string;
  items: Item[];
  sources: Array<
    Pick<
      Source,
      "id" | "originalText" | "url" | "createdAt" | "filename" | "mime"
    > & {
      imageBase64: string | null;
      fileBase64: string | null;
    }
  >;
};

// Only small synthetic test exports may be collected into memory.
export async function exportLibrary(
  library: Library,
  owner: string,
): Promise<LegacyExport> {
  const chunks: string[] = [];
  let bytes = 0;
  await library.export(owner, async (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024 * 1024)
      throw new Error(
        "Synthetic legacy export exceeds the 16 MiB fixture limit.",
      );
    chunks.push(chunk);
  });
  return JSON.parse(chunks.join("")) as LegacyExport;
}
