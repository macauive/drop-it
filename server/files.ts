import { fileParamSchema } from "../shared/schema.js";
import { AppError } from "./errors.js";
import type { Library } from "./library.js";

export async function importChatGPTFile(
  library: Library,
  owner: string,
  input: unknown,
) {
  const file = fileParamSchema.parse(input);
  const url = new URL(file.download_url);
  // Never fetch arbitrary user URLs or follow redirects with signed file credentials.
  if (
    url.protocol !== "https:" ||
    url.hostname !== "files.oaiusercontent.com" ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new AppError(
      400,
      "FILE_HOST",
      "Unsupported file host. Upload the file through Drop It instead.",
    );
  }
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  }).catch(() => {
    throw new AppError(
      400,
      "FILE_FETCH",
      "The file could not be downloaded. Please attach it again.",
    );
  });
  if (!response.ok || !response.body)
    throw new AppError(
      400,
      "FILE_FETCH",
      "The file link expired or is unavailable. Please attach it again.",
    );
  const length = Number(response.headers.get("content-length"));
  if (length > 10 * 1024 * 1024) {
    await response.body.cancel();
    throw new AppError(413, "FILE_SIZE", "Choose a file under 10 MB.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024)
      throw new AppError(413, "FILE_SIZE", "Choose a file under 10 MB.");
    chunks.push(chunk);
  }
  return library.upload(
    owner,
    Buffer.concat(chunks),
    file.mime_type,
    file.filename,
  );
}
