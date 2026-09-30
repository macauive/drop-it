import { Worker } from "node:worker_threads";
import { z } from "zod";
import sharp from "sharp";
import { fileMime, isImageMime, maxFileBytes } from "../shared/files.js";
import { AppError } from "./errors.js";

const filenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine(
    (name) =>
      !/[\\/]/.test(name) &&
      ![...name].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ) &&
      !name.startsWith("."),
  );
const invalid = () =>
  new AppError(
    400,
    "INVALID_FILE",
    "Choose a valid image, PDF, TXT, Markdown, CSV, or JSON file.",
  );
let activePdfChecks = 0;

async function validatePdf(bytes: Buffer) {
  if (!bytes.subarray(0, 8).toString("ascii").startsWith("%PDF-"))
    throw invalid();
  if (activePdfChecks >= 2)
    throw new AppError(
      429,
      "FILE_BUSY",
      "PDF processing is busy. Try again shortly.",
    );
  activePdfChecks++;
  let valid: boolean;
  try {
    valid = await new Promise<boolean>((resolve) => {
      const worker = new Worker(
        new URL("./pdf-validation.mjs", import.meta.url),
        {
          workerData: Uint8Array.from(bytes),
          resourceLimits: { maxOldGenerationSizeMb: 128 },
          stdout: true,
          stderr: true,
          execArgv: [],
        },
      );
      worker.stdout.resume();
      worker.stderr.resume();
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        void worker.terminate();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 10000);
      worker.once("message", (ok) => finish(ok === true));
      worker.once("error", () => finish(false));
      worker.once("exit", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  } finally {
    activePdfChecks--;
  }
  if (!valid)
    throw new AppError(
      400,
      "INVALID_PDF",
      "Choose an unencrypted, readable PDF with at most 30 pages.",
    );
}

export async function validateUpload(
  bytes: Buffer,
  declaredMime: string,
  name?: string,
) {
  if (!bytes.length || bytes.length > maxFileBytes)
    throw new AppError(413, "FILE_SIZE", "Choose a nonempty file under 10 MB.");
  const declared = declaredMime.split(";")[0].trim().toLowerCase();
  const fallback = {
    "image/png": "source.png",
    "image/jpeg": "source.jpg",
    "image/webp": "source.webp",
  }[declared];
  const parsed = filenameSchema.safeParse(name ?? fallback);
  if (!parsed.success) throw invalid();
  const filename = parsed.data;
  const mime = fileMime(filename);
  if (
    !mime ||
    (declared !== mime &&
      declared !== "application/octet-stream" &&
      !(mime === "text/markdown" && declared === "text/plain"))
  )
    throw invalid();
  let originalText = "";
  if (isImageMime(mime)) {
    try {
      const image = sharp(bytes, {
        limitInputPixels: 25_000_000,
        animated: true,
        failOn: "warning",
      });
      const metadata = await image.metadata();
      const actual = (
        { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as Record<
          string,
          string
        >
      )[metadata.format ?? ""];
      if (actual !== mime || (metadata.pages && metadata.pages > 1))
        throw invalid();
      await image.stats();
    } catch {
      throw new AppError(
        400,
        "INVALID_IMAGE",
        "Choose a valid, single-frame PNG, JPEG, or WebP image under 25 megapixels.",
      );
    }
  } else if (mime === "application/pdf") {
    await validatePdf(bytes);
  } else {
    try {
      originalText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw invalid();
    }
    if (originalText.length > 50000)
      throw new AppError(
        413,
        "TEXT_SIZE",
        "Text files must contain at most 50,000 characters.",
      );
    if (
      [...originalText].some((char) => {
        const code = char.charCodeAt(0);
        return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
      })
    )
      throw invalid();
    if (mime === "application/json") {
      try {
        JSON.parse(originalText);
      } catch {
        throw invalid();
      }
    }
  }
  return { filename, mime, originalText };
}
