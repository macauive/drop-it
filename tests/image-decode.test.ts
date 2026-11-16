import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { withImageDecode } from "../server/image-decode.js";
import { validateUpload } from "../server/uploads.js";
import { thumbnail } from "../server/thumbnails.js";

test("24MP image upload and thumbnail share decode capacity, recover after failure and preserve pixels", async (t) => {
  const bytes = await sharp({
    create: { width: 6000, height: 4000, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holds = [withImageDecode(() => gate), withImageDecode(() => gate)];
  try {
    await assert.rejects(validateUpload(bytes, "image/png"), {
      code: "FILE_BUSY",
    });
    let done = false;
    const queued = thumbnail(bytes).then((value) => {
      done = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(done, false);
    release();
    await Promise.all(holds);
    assert.equal((await sharp(await queued).metadata()).width, 144);
  } finally {
    release();
    await Promise.all(holds);
  }
  // A decoder timeout/failure must map to a bounded user error and free its slot.
  const stats = t.mock.method(sharp.prototype, "stats", async () => {
    throw new Error("Synthetic decode timeout");
  });
  await assert.rejects(validateUpload(bytes, "image/png"), {
    code: "INVALID_IMAGE",
  });
  stats.mock.restore();
  assert.equal((await validateUpload(bytes, "image/png")).mime, "image/png");
  assert.equal((await sharp(bytes).metadata()).width, 6000);
  assert.equal((await sharp(bytes).metadata()).height, 4000);
});
