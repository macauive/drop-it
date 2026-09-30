import { fileParamSchema } from "../shared/schema.js";
import { maxFileBytes } from "../shared/files.js";
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
  const controller = new AbortController();
  let bytes: Buffer;
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new AppError(
        400,
        "FILE_FETCH",
        "The file link expired or is unavailable. Please attach it again.",
      );
    }
    const length = Number(response.headers.get("content-length"));
    if (length > maxFileBytes) {
      await response.body.cancel();
      throw new AppError(413, "FILE_SIZE", "Choose a file under 10 MB.");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxFileBytes)
        throw new AppError(413, "FILE_SIZE", "Choose a file under 10 MB.");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      400,
      "FILE_FETCH",
      "The file could not be downloaded. Please attach it again.",
    );
  } finally {
    // Close the request on every path, including aborted and partial streams.
    controller.abort();
  }
  return library.upload(owner, bytes, file.mime_type, file.filename);
}
