import { fileParamSchema } from "../shared/schema.js";
import { fileTypes, maxFileBytes } from "../shared/files.js";
import { AppError } from "./errors.js";
import type { Library } from "./library.js";

// Exact hosts observed in ChatGPT file delivery. Never allow all Azure Blob
// accounts or arbitrary URLs supplied by a model or an uploaded document.
const chatGPTFileHosts = new Set([
  "files.oaiusercontent.com",
  "oaisdmntprcentralus.blob.core.windows.net",
]);

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
    !chatGPTFileHosts.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new AppError(
      400,
      "FILE_HOST",
      `Unsupported file host (${url.hostname.slice(0, 253) || "no hostname"}). Upload the file through Drop It instead.`,
    );
  }
  const controller = new AbortController();
  let bytes: Buffer;
  let responseMime = "";
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
    responseMime = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
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
  // Missing ChatGPT metadata is normal. Byte signatures only select a candidate
  // type; library.upload still fully decodes/validates the content before saving.
  const signatureMime = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      ? "image/jpeg"
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
          bytes.subarray(8, 12).toString("ascii") === "WEBP"
        ? "image/webp"
        : bytes.subarray(0, 5).toString("ascii") === "%PDF-"
          ? "application/pdf"
          : undefined;
  const supportedMime = Object.values(fileTypes).find(
    (mime) => mime === responseMime,
  );
  const mime =
    file.mime_type ??
    signatureMime ??
    supportedMime ??
    "application/octet-stream";
  const extension = Object.entries(fileTypes).find(
    ([, value]) =>
      value === (mime === "application/octet-stream" ? signatureMime : mime),
  )?.[0];
  const name =
    file.file_name ??
    file.filename ??
    (extension ? `source.${extension}` : undefined);
  return library.upload(owner, bytes, mime, name);
}
