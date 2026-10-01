import { test } from "node:test";
import assert from "node:assert/strict";
import { validateUpload } from "../server/uploads.js";
import { AppError } from "../server/errors.js";
import { pdfFixture } from "./pdf-fixture.js";
import { readFile } from "node:fs/promises";

test("file validation accepts supported UTF-8 text formats and valid PDFs", async () => {
  for (const [name, mime, content] of [
    ["notes.txt", "text/plain", "A note\nSecond line"],
    ["notes.MD", "text/markdown", "# A note"],
    ["rows.csv", "text/csv", "name,value\nbasil,3"],
    ["data.json", "application/json", '{"name":"basil"}'],
  ]) {
    const result = await validateUpload(
      Buffer.from(content),
      "application/octet-stream",
      name,
    );
    assert.equal(result.mime, mime);
    assert.equal(result.originalText, content);
  }
  const pdf = await validateUpload(
    pdfFixture(),
    "application/pdf",
    "notes.pdf",
  );
  assert.equal(pdf.mime, "application/pdf");
  assert.equal(pdf.originalText, "");
});

test("PDF validation rejects both password-protected and owner-encrypted files", async () => {
  for (const name of ["password-protected.pdf", "owner-encrypted.pdf"]) {
    const bytes = await readFile(
      new URL(`./fixtures/${name}`, import.meta.url),
    );
    await assert.rejects(
      validateUpload(bytes, "application/pdf", name),
      (error: unknown) =>
        error instanceof AppError && error.code === "INVALID_PDF",
    );
  }
});

test("PDF validation accepts image-only scans", async () => {
  const bytes = await readFile(
    new URL("./fixtures/scanned.pdf", import.meta.url),
  );
  assert.equal(
    (await validateUpload(bytes, "application/pdf", "scanned.pdf")).mime,
    "application/pdf",
  );
});

test("a PDF parser timeout terminates the worker and releases capacity for retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = validateUpload(
      pdfFixture(),
      "application/pdf",
      "timeout.pdf",
    );
    const rejected = assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof AppError && error.code === "INVALID_PDF",
    );
    t.mock.timers.tick(10001);
    await rejected;
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(
    (await validateUpload(pdfFixture(), "application/pdf", "retry.pdf")).mime,
    "application/pdf",
  );
});

test("PDF concurrency and exact text/page boundaries remain usable after saturation", async () => {
  await validateUpload(pdfFixture(30), "application/pdf", "boundary.pdf");
  const text = "界".repeat(50000);
  assert.equal(
    (await validateUpload(Buffer.from(text), "text/plain", "boundary.txt"))
      .originalText,
    text,
  );
  const results = await Promise.allSettled(
    [1, 2, 3].map(() =>
      validateUpload(pdfFixture(), "application/pdf", "parallel.pdf"),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    2,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof AppError &&
        result.reason.code === "FILE_BUSY",
    ).length,
    1,
  );
  await validateUpload(pdfFixture(), "application/pdf", "recovery.pdf");
});

test("file validation rejects unsupported, forged, malformed, oversized and traversal uploads", async () => {
  for (const [bytes, mime, name] of [
    [Buffer.from("hello"), "application/octet-stream", "script.exe"],
    [Buffer.from("<svg/>"), "application/octet-stream", "vector.svg"],
    [Buffer.from("<html/>"), "application/octet-stream", "page.html"],
    [Buffer.from("hello"), "text/plain", "../notes.txt"],
    [Buffer.from("hello"), "text/plain", "notes\r\n.txt"],
    [Buffer.from("hello"), "application/pdf", "notes.txt"],
    [Buffer.from([0xff, 0xff]), "text/plain", "notes.txt"],
    [Buffer.from("hello\0"), "text/plain", "notes.txt"],
    [Buffer.from("not JSON"), "application/json", "data.json"],
    [Buffer.from("%PDF-1.4\ninvalid\n%%EOF"), "application/pdf", "notes.pdf"],
    [pdfFixture(31), "application/pdf", "long.pdf"],
    [Buffer.from("x".repeat(50001)), "text/plain", "long.txt"],
    [Buffer.alloc(10 * 1024 * 1024 + 1), "application/pdf", "large.pdf"],
  ] as const) {
    await assert.rejects(
      validateUpload(bytes, mime, name),
      (error: unknown) => error instanceof AppError,
    );
  }
});
