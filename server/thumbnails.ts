import sharp from "sharp";
import { AppError } from "./errors.js";

let active = 0;
const waiting: (() => void)[] = [];

export async function thumbnail(bytes: Buffer, size: "list" | "grid" = "list") {
  // Bound native image decoding while allowing a page of previews to queue.
  if (active >= 2) {
    if (waiting.length >= 32)
      throw new AppError(
        429,
        "PREVIEW_BUSY",
        "Preview unavailable. Try again.",
      );
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else active++;
  try {
    return await sharp(bytes, {
      limitInputPixels: 25_000_000,
      failOn: "warning",
    })
      .rotate()
      .resize(size === "grid" ? 640 : 144, size === "grid" ? 480 : 112, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 78 })
      .timeout({ seconds: 5 })
      .toBuffer();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
