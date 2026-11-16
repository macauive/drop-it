import sharp from "sharp";
import { imageDecodeOptions, withImageDecode } from "./image-decode.js";

export async function thumbnail(bytes: Buffer, size: "list" | "grid" = "list") {
  return withImageDecode(async () => {
    return await sharp(bytes, {
      ...imageDecodeOptions,
    })
      .rotate()
      .resize(size === "grid" ? 640 : 144, size === "grid" ? 480 : 112, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 78 })
      .timeout({ seconds: 5 })
      .toBuffer();
  }, true);
}
