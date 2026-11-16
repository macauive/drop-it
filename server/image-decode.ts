import { AppError } from "./errors.js";

export const imageDecodeOptions = {
  limitInputPixels: 25_000_000,
  sequentialRead: true,
  failOn: "warning" as const,
};

let active = 0;
const waiting: (() => void)[] = [];

// Shared by every decoder of user-controlled images. Thumbnails may queue one
// page of previews; uploads and AI drafts fail promptly under saturation.
export async function withImageDecode<T>(
  work: () => Promise<T>,
  queue = false,
) {
  if (active >= 2) {
    if (!queue || waiting.length >= 32)
      throw new AppError(
        429,
        queue ? "PREVIEW_BUSY" : "FILE_BUSY",
        "Image processing is busy. Try again shortly.",
      );
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else active++;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
