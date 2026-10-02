import { createHash, randomUUID, type Hash } from "node:crypto";
import {
  mkdtemp,
  open,
  readFile,
  rm,
  chmod,
  readdir,
  lstat,
  utimes,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Express } from "express";
import { z } from "zod";
import type { Database, Queryable } from "./db.js";
import { AppError } from "./errors.js";
import { validateUpload } from "./uploads.js";
import {
  defaultLibraryLimits,
  normalizeSourceUrl,
  type LibraryLimits,
} from "./library.js";
import { idSchema } from "../shared/schema.js";
import {
  archiveFormat,
  archiveChunkBytes,
  maxArchiveBytes,
  previewLifetimeMs,
  portableItemSchema,
  portableSourceSchema,
  portableFileSchema,
  manifestSchema,
  chunkSchema,
  endSchema,
  applyImportSchema,
  portableDate,
  type PortableItem,
  type PortableSource,
  type PortableFile,
  type ImportPreview,
  type ImportResult,
} from "../shared/portable.js";

const day = 86400000;
const invalid = (
  message = "This archive is incomplete, damaged, or not a supported Drop It export.",
) => new AppError(400, "IMPORT_INVALID", message);
const limit = () =>
  new AppError(
    413,
    "IMPORT_LIMIT",
    "This archive exceeds the import or library capacity limit.",
  );
const validDate = (value: string) => {
  if (
    !Number.isFinite(Date.parse(value)) ||
    Date.parse(value) < 0 ||
    Date.parse(value) > Date.now() + 300000
  )
    throw invalid("The archive contains an invalid or future timestamp.");
};
const textBytes = (values: (string | null)[]) =>
  values.reduce((sum, value) => sum + Buffer.byteLength(value ?? ""), 0);
const itemBytes = (item: PortableItem) =>
  textBytes([
    item.title,
    item.summary,
    item.category,
    ...item.tags,
    item.notes,
    item.reviewedTranscription,
  ]);
const sourceBytes = (source: PortableSource) =>
  textBytes([source.originalText, source.url]);
const alive = (item: PortableItem, now = Date.now()) =>
  !item.trashedAt || Date.parse(item.trashedAt) > now - 7 * day;
const canonicalBase64 = (value: string, max: number) => {
  if (!value || value.length % 4 !== 0 || value.length > 4 * Math.ceil(max / 3))
    throw invalid("An original file has invalid encoding.");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > max || bytes.toString("base64") !== value)
    throw invalid();
  return bytes;
};

type ByteInput = AsyncIterable<Uint8Array>;
// This cursor bounds each JSON value, never retaining the complete archive.
// Legacy v2 carries one base64 original per source; that individual value is
// bounded by the existing 10 MiB file limit. v3 records are much smaller.
class TextCursor {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private offset = 0;
  private done = false;
  private received = 0;
  readonly hash = createHash("sha256");
  constructor(input: ByteInput) {
    this.iterator = input[Symbol.asyncIterator]();
  }
  private async available() {
    while (this.offset >= this.buffer.length && !this.done) {
      const next = await this.iterator.next();
      this.offset = 0;
      if (next.done) {
        this.done = true;
        this.buffer = this.decoder.decode();
      } else {
        this.received += next.value.byteLength;
        if (this.received > maxArchiveBytes) throw limit();
        this.hash.update(next.value);
        this.buffer = this.decoder.decode(next.value, { stream: true });
      }
    }
    return this.offset < this.buffer.length;
  }
  async peek(): Promise<string> {
    return (await this.available()) ? this.buffer[this.offset] : "";
  }
  async whitespace() {
    while (await this.available()) {
      while (
        this.offset < this.buffer.length &&
        /\s/.test(this.buffer[this.offset])
      )
        this.offset++;
      if (this.offset < this.buffer.length) return;
    }
  }
  async expect(value: string) {
    await this.whitespace();
    if ((await this.peek()) !== value) throw invalid();
    this.offset++;
  }
  async value(maxCharacters: number): Promise<unknown> {
    await this.whitespace();
    const first = await this.peek();
    if (!first) throw invalid();
    const composite = first === "{" || first === "[";
    const quoted = first === '"';
    let depth = 0,
      inString = false,
      escape = false,
      length = 0,
      started = false;
    const parts: string[] = [];
    for (;;) {
      if (!(await this.available())) {
        if (composite || quoted || !started) throw invalid();
        break;
      }
      const start = this.offset;
      let complete = false;
      while (this.offset < this.buffer.length) {
        const char = this.buffer[this.offset];
        if (!composite && !quoted && /[\s,\]}]/.test(char)) {
          complete = true;
          break;
        }
        this.offset++;
        length++;
        started = true;
        if (length > maxCharacters) throw limit();
        if (inString) {
          if (escape) escape = false;
          else if (char === "\\") escape = true;
          else if (char === '"') {
            inString = false;
            if (quoted) {
              complete = true;
              break;
            }
          }
        } else if (char === '"') inString = true;
        else if (char === "{" || char === "[") depth++;
        else if (char === "}" || char === "]") {
          depth--;
          if (composite && depth === 0) {
            complete = true;
            break;
          }
          if (depth < 0) throw invalid();
        }
      }
      parts.push(this.buffer.slice(start, this.offset));
      if (complete) break;
    }
    return JSON.parse(parts.join(""));
  }
  async line(maxCharacters: number): Promise<string | null> {
    const parts: string[] = [];
    let size = 0;
    while (await this.available()) {
      const end = this.buffer.indexOf("\n", this.offset);
      const part = this.buffer.slice(this.offset, end < 0 ? undefined : end);
      size += part.length;
      if (size > maxCharacters) throw limit();
      parts.push(part);
      this.offset = end < 0 ? this.buffer.length : end + 1;
      if (end >= 0) return parts.join("");
    }
    return parts.length ? parts.join("") : null;
  }
  async end() {
    await this.whitespace();
    if (await this.peek()) throw invalid();
  }
}

type StagedFile = PortableFile & { path: string; originalText: string };
type Stage = {
  id: string;
  owner: string;
  directory: string;
  expires: number;
  items: Map<string, PortableItem>;
  sources: Map<string, PortableSource>;
  files: Map<string, StagedFile>;
  fileBytes: number;
  textBytes: number;
  version: 2 | 3;
  digest: string;
  busy: boolean;
  ready: boolean;
};
const v2ItemSchema = portableItemSchema
  .extend({
    sourceUrl: z.string().max(2048).optional(),
    hasImage: z.boolean().optional(),
    deleteAfter: portableDate.nullable().optional(),
    transcriptionProvenance: z.enum(["original", "reviewed"]).optional(),
  })
  .strict();
const v2SourceSchema = portableSourceSchema
  .omit({ attachmentId: true })
  .extend({
    filename: z.string().max(180).nullable(),
    mime: z.string().max(100).nullable(),
    imageBase64: z
      .string()
      .max(14 * 1024 * 1024)
      .nullable(),
    fileBase64: z
      .string()
      .max(14 * 1024 * 1024)
      .nullable(),
  })
  .strict();

export class Portability {
  private readonly stages = new Map<string, Stage>();
  private readonly limits: LibraryLimits;
  private readonly timer: ReturnType<typeof setInterval>;
  private exporting = false;
  constructor(
    private readonly db: Database,
    options: Partial<LibraryLimits> = {},
  ) {
    this.limits = { ...defaultLibraryLimits, ...options };
    this.timer = setInterval(() => {
      void this.expire().catch(() => console.error("IMPORT_CLEANUP_ERROR"));
    }, 60000);
    this.timer.unref();
    void this.cleanupStaleDirectories().catch(() =>
      console.error("IMPORT_CLEANUP_ERROR"),
    );
  }
  async close() {
    clearInterval(this.timer);
    await Promise.all(
      [...this.stages.values()].map((stage) => this.remove(stage)),
    );
  }
  private async remove(stage: Stage) {
    this.stages.delete(stage.id);
    await rm(stage.directory, { recursive: true, force: true });
  }
  async expire(now = Date.now()) {
    for (const stage of this.stages.values())
      if (!stage.busy && stage.expires <= now) await this.remove(stage);
    await this.cleanupStaleDirectories();
  }
  private async cleanupStaleDirectories() {
    // A crash loses the in-memory preview registry. Only inspect our exact
    // generated prefix, owned directories and age; never follow symlinks or
    // inspect other temporary-file contents. Active imports refresh mtime.
    const active = new Set(
      [...this.stages.values()].map((stage) => stage.directory),
    );
    const entries = await readdir(tmpdir(), { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !/^drop-it-import-[A-Za-z0-9]{6}$/.test(entry.name)
      )
        continue;
      const path = join(tmpdir(), entry.name);
      if (active.has(path)) continue;
      try {
        const info = await lstat(path);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (info.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" &&
            info.uid !== process.getuid()) ||
          info.mtimeMs > Date.now() - previewLifetimeMs - 5 * 60000
        )
          continue;
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  async discard(owner: string, id: string) {
    idSchema.parse(id);
    const stage = this.stages.get(id);
    if (!stage || stage.owner !== owner) return;
    if (stage.busy)
      throw new AppError(
        409,
        "IMPORT_BUSY",
        "This import is still processing.",
      );
    await this.remove(stage);
  }
  private addItem(stage: Stage, input: unknown) {
    const item = portableItemSchema.parse(input);
    if (stage.items.has(item.id))
      throw invalid("The archive repeats a drop identifier.");
    if (stage.items.size >= this.limits.ownerDropCount) throw limit();
    for (const value of [
      item.createdAt,
      item.updatedAt,
      item.trashedAt,
      item.transcriptionUpdatedAt,
    ])
      if (value) validDate(value);
    if (
      Date.parse(item.updatedAt) < Date.parse(item.createdAt) ||
      (item.trashedAt &&
        Date.parse(item.trashedAt) < Date.parse(item.createdAt)) ||
      (item.reviewedTranscription === null) !==
        (item.transcriptionUpdatedAt === null)
    )
      throw invalid();
    stage.textBytes += itemBytes(item);
    if (stage.textBytes > this.limits.ownerTextBytes) throw limit();
    stage.items.set(item.id, item);
  }
  private addSource(stage: Stage, input: unknown) {
    const source = portableSourceSchema.parse(input);
    if (stage.sources.has(source.id))
      throw invalid("The archive repeats a source identifier.");
    if (stage.sources.size >= this.limits.ownerDropCount) throw limit();
    validDate(source.createdAt);
    stage.textBytes += sourceBytes(source);
    if (stage.textBytes > this.limits.ownerTextBytes) throw limit();
    stage.sources.set(source.id, source);
  }
  private async finishFile(stage: Stage, file: PortableFile, path: string) {
    if (stage.files.has(file.id))
      throw invalid("The archive repeats a file identifier.");
    validDate(file.createdAt);
    const bytes = await readFile(path);
    if (
      bytes.length !== file.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      throw invalid(
        "An original file failed its size or SHA-256 integrity check.",
      );
    const validated = await validateUpload(bytes, file.mime, file.filename);
    stage.textBytes += Buffer.byteLength(validated.originalText);
    if (stage.textBytes > this.limits.ownerTextBytes) throw limit();
    stage.files.set(file.id, {
      ...file,
      path,
      originalText: validated.originalText,
    });
  }
  private async parseV3(stage: Stage, cursor: TextCursor) {
    let manifest = false,
      ended = false;
    const integrity = createHash("sha256");
    let active: {
      file: PortableFile;
      handle: FileHandle;
      path: string;
      size: number;
      index: number;
      hash: Hash;
    } | null = null;
    try {
      for (;;) {
        const line = await cursor.line(512 * 1024);
        if (line === null) break;
        if (!line || ended) throw invalid();
        const record = JSON.parse(line) as { type?: unknown; value?: unknown };
        if (!manifest) {
          const head = manifestSchema.parse(record);
          validDate(head.exportedAt);
          manifest = true;
        } else if (record.type === "chunk") {
          const chunk = chunkSchema.parse(record);
          if (
            !active ||
            chunk.id !== active.file.id ||
            chunk.index !== active.index
          )
            throw invalid();
          const bytes = canonicalBase64(chunk.data, archiveChunkBytes);
          active.size += bytes.length;
          if (active.size > active.file.bytes) throw invalid();
          await active.handle.writeFile(bytes);
          active.hash.update(bytes);
          active.index++;
          if (active.size === active.file.bytes) {
            await active.handle.close();
            if (active.hash.digest("hex") !== active.file.sha256)
              throw invalid(
                "An original file failed its SHA-256 integrity check.",
              );
            await this.finishFile(stage, active.file, active.path);
            active = null;
          }
        } else {
          if (active) throw invalid("An original file is incomplete.");
          if (record.type === "item") {
            const row = z
              .object({ type: z.literal("item"), value: portableItemSchema })
              .strict()
              .parse(record);
            this.addItem(stage, row.value);
          } else if (record.type === "source") {
            const row = z
              .object({
                type: z.literal("source"),
                value: portableSourceSchema,
              })
              .strict()
              .parse(record);
            this.addSource(stage, row.value);
          } else if (record.type === "file") {
            const row = z
              .object({ type: z.literal("file"), value: portableFileSchema })
              .strict()
              .parse(record);
            if (
              stage.files.has(row.value.id) ||
              stage.files.size >= this.limits.ownerDropCount
            )
              throw invalid();
            stage.fileBytes += row.value.bytes;
            if (stage.fileBytes > this.limits.ownerAttachmentBytes)
              throw limit();
            const path = join(stage.directory, randomUUID());
            active = {
              file: row.value,
              path,
              handle: await open(path, "wx", 0o600),
              size: 0,
              index: 0,
              hash: createHash("sha256"),
            };
          } else if (record.type === "end") {
            const end = endSchema.parse(record);
            if (
              end.items !== stage.items.size ||
              end.sources !== stage.sources.size ||
              end.files !== stage.files.size ||
              end.fileBytes !== stage.fileBytes ||
              end.sha256 !== integrity.digest("hex")
            )
              throw invalid();
            ended = true;
            continue;
          } else throw invalid();
        }
        integrity.update(line + "\n");
      }
      if (!manifest || !ended || active) throw invalid();
    } finally {
      await active?.handle.close().catch(() => undefined);
    }
  }
  private async parseV2(stage: Stage, cursor: TextCursor) {
    const keys = new Set<string>();
    const filesByHash = new Map<string, StagedFile>();
    await cursor.expect("{");
    while (true) {
      const key = z
        .enum(["version", "exportedAt", "items", "sources"])
        .parse(await cursor.value(64));
      if (keys.has(key)) throw invalid();
      keys.add(key);
      await cursor.expect(":");
      if (key === "version") {
        if ((await cursor.value(10)) !== 2) throw invalid();
      } else if (key === "exportedAt")
        validDate(portableDate.parse(await cursor.value(100)));
      else {
        await cursor.expect("[");
        await cursor.whitespace();
        if ((await cursor.peek()) !== "]")
          while (true) {
            const value = await cursor.value(
              key === "items" ? 512 * 1024 : 16 * 1024 * 1024,
            );
            if (key === "items") {
              const parsed = v2ItemSchema.parse(value);
              const { deleteAfter } = parsed;
              const item = portableItemSchema.parse(
                Object.fromEntries(
                  Object.entries(parsed).filter(
                    ([key]) =>
                      ![
                        "sourceUrl",
                        "hasImage",
                        "deleteAfter",
                        "transcriptionProvenance",
                      ].includes(key),
                  ),
                ),
              );
              if (
                deleteAfter !== undefined &&
                ((deleteAfter === null) !== (item.trashedAt === null) ||
                  (deleteAfter &&
                    Date.parse(deleteAfter) !==
                      Date.parse(item.trashedAt!) + 7 * day))
              )
                throw invalid();
              this.addItem(stage, item);
            } else {
              const { imageBase64, fileBase64, filename, mime, ...source } =
                v2SourceSchema.parse(value);
              if (imageBase64 && fileBase64) throw invalid();
              const encoded = imageBase64 ?? fileBase64;
              let attachmentId: string | null = null;
              if (encoded !== null) {
                if (!mime || !filename) throw invalid();
                const bytes = canonicalBase64(encoded, 10 * 1024 * 1024);
                const sha256 = createHash("sha256").update(bytes).digest("hex");
                const file = portableFileSchema.parse({
                  id: randomUUID(),
                  filename,
                  mime,
                  bytes: bytes.length,
                  sha256,
                  createdAt: source.createdAt,
                });
                const matching = filesByHash.get(
                  `${sha256}:${mime}:${filename}`,
                );
                if (matching) attachmentId = matching.id;
                else {
                  stage.fileBytes += bytes.length;
                  if (
                    stage.fileBytes > this.limits.ownerAttachmentBytes ||
                    stage.files.size >= this.limits.ownerDropCount
                  )
                    throw limit();
                  const path = join(stage.directory, randomUUID());
                  const handle = await open(path, "wx", 0o600);
                  try {
                    await handle.writeFile(bytes);
                  } finally {
                    await handle.close();
                  }
                  await this.finishFile(stage, file, path);
                  attachmentId = file.id;
                  filesByHash.set(
                    `${sha256}:${mime}:${filename}`,
                    stage.files.get(file.id)!,
                  );
                }
              } else if (mime !== null || filename !== null) throw invalid();
              this.addSource(stage, { ...source, attachmentId });
            }
            await cursor.whitespace();
            if ((await cursor.peek()) === "]") break;
            await cursor.expect(",");
          }
        await cursor.expect("]");
      }
      await cursor.whitespace();
      if ((await cursor.peek()) === "}") break;
      await cursor.expect(",");
    }
    await cursor.expect("}");
    await cursor.end();
    if (keys.size !== 4) throw invalid();
  }
  private included(stage: Stage) {
    const items = [...stage.items.values()].filter((item) => alive(item));
    const sourceIds = new Set(items.map((item) => item.sourceId));
    const sources = [...stage.sources.values()].filter((source) =>
      sourceIds.has(source.id),
    );
    const fileIds = new Set(
      sources.flatMap((source) =>
        source.attachmentId ? [source.attachmentId] : [],
      ),
    );
    const files = [...stage.files.values()].filter((file) =>
      fileIds.has(file.id),
    );
    return {
      items,
      sources,
      files,
      fileBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      textBytes:
        items.reduce((sum, item) => sum + itemBytes(item), 0) +
        sources.reduce((sum, source) => sum + sourceBytes(source), 0) +
        files.reduce(
          (sum, file) => sum + Buffer.byteLength(file.originalText),
          0,
        ),
    };
  }
  private fingerprint(stage: Stage, source: PortableSource) {
    const fileHash = source.attachmentId
      ? stage.files.get(source.attachmentId)!.sha256
      : "";
    const title =
      [...stage.items.values()].find((item) => item.sourceId === source.id)
        ?.title ?? "";
    return createHash("sha256")
      .update(
        JSON.stringify([
          source.originalText.trim(),
          normalizeSourceUrl(source.url),
          fileHash,
          !source.originalText.trim() && !source.url && !fileHash ? title : "",
        ]),
      )
      .digest("hex");
  }
  private async usage(tx: Queryable, owner: string) {
    const result = await tx.query<{
      count: string;
      text: string;
      files: string;
      service: string;
    }>(
      `SELECT (SELECT count(*) FROM items WHERE owner=$1) AS count,
       ((SELECT coalesce(sum(octet_length(title)::bigint+octet_length(summary)+octet_length(category)+octet_length(array_to_string(tags,''))+octet_length(notes)+octet_length(coalesce(reviewed_transcription,''))),0) FROM items WHERE owner=$1)
       +(SELECT coalesce(sum(octet_length(original_text)::bigint+octet_length(url)),0) FROM sources WHERE owner=$1)
       +(SELECT coalesce(sum(octet_length(original_text)::bigint),0) FROM attachments WHERE owner=$1)) AS text,
       (SELECT coalesce(sum(octet_length(bytes)::bigint),0) FROM attachments WHERE owner=$1) AS files,
       (SELECT coalesce(sum(octet_length(bytes)::bigint),0) FROM attachments) AS service`,
      [owner],
    );
    return result.rows[0];
  }
  private checkCapacity(
    usage: { count: string; text: string; files: string; service: string },
    included: ReturnType<Portability["included"]>,
  ) {
    if (
      Number(usage.count) + included.items.length >
        this.limits.ownerDropCount ||
      Number(usage.text) + included.textBytes > this.limits.ownerTextBytes ||
      Number(usage.files) + included.fileBytes >
        this.limits.ownerAttachmentBytes ||
      Number(usage.service) + included.fileBytes >
        this.limits.serviceAttachmentBytes
    )
      throw limit();
  }
  async preview(
    owner: string,
    input: ByteInput,
    format: "json" | "ndjson",
  ): Promise<ImportPreview> {
    idSchema.parse(owner);
    await this.expire();
    if (
      this.stages.size >= 2 ||
      [...this.stages.values()].some((stage) => stage.owner === owner)
    )
      throw new AppError(
        429,
        "IMPORT_BUSY",
        "Discard your current preview or wait for it to expire before uploading another archive.",
      );
    // Reserve a slot before the first asynchronous filesystem operation.
    const id = randomUUID();
    const stage: Stage = {
      id,
      owner,
      directory: "",
      expires: Date.now() + previewLifetimeMs,
      items: new Map(),
      sources: new Map(),
      files: new Map(),
      fileBytes: 0,
      textBytes: 0,
      version: format === "json" ? 2 : 3,
      digest: "",
      busy: true,
      ready: false,
    };
    this.stages.set(id, stage);
    try {
      stage.directory = await mkdtemp(join(tmpdir(), "drop-it-import-"));
      await chmod(stage.directory, 0o700);
      const cursor = new TextCursor(input);
      if (format === "json") await this.parseV2(stage, cursor);
      else await this.parseV3(stage, cursor);
      stage.digest = cursor.hash.digest("hex");
      const referencedSources = new Set<string>(),
        referencedFiles = new Set<string>();
      for (const item of stage.items.values()) {
        if (!stage.sources.has(item.sourceId))
          throw invalid("A drop references a missing source.");
        referencedSources.add(item.sourceId);
      }
      for (const source of stage.sources.values()) {
        if (!referencedSources.has(source.id))
          throw invalid("The archive contains an unreferenced source.");
        if (source.attachmentId) {
          if (!stage.files.has(source.attachmentId))
            throw invalid("A source references a missing original file.");
          referencedFiles.add(source.attachmentId);
        }
      }
      if (referencedFiles.size !== stage.files.size)
        throw invalid("The archive contains an unreferenced original file.");
      const included = this.included(stage);
      this.checkCapacity(await this.usage(this.db, owner), included);
      let duplicateItems = 0;
      for (const source of included.sources) {
        const result = await this.db.query(
          `SELECT 1 FROM sources s WHERE s.owner=$1 AND (s.fingerprint=$2 OR ($3<>'' AND s.normalized_url=$3))
          AND EXISTS(SELECT 1 FROM items i WHERE i.owner=s.owner AND i.source_id=s.id AND (i.trashed_at IS NULL OR i.trashed_at>now()-interval '7 days')) LIMIT 1`,
          [
            owner,
            this.fingerprint(stage, source),
            normalizeSourceUrl(source.url),
          ],
        );
        if (result.rows.length)
          duplicateItems += included.items.filter(
            (item) => item.sourceId === source.id,
          ).length;
      }
      stage.busy = false;
      stage.ready = true;
      stage.expires = Date.now() + previewLifetimeMs;
      const expiredItems = stage.items.size - included.items.length;
      return {
        previewId: id,
        requestId: id,
        expiresAt: new Date(stage.expires).toISOString(),
        version: stage.version,
        items: included.items.length,
        sources: included.sources.length,
        files: included.files.length,
        fileBytes: included.fileBytes,
        expiredItems,
        duplicateItems,
        warnings: [
          "Import adds private copies to this account. Existing drops are not overwritten.",
          ...(duplicateItems
            ? [
                `${duplicateItems} drops may duplicate existing sources and will be added as copies.`,
              ]
            : []),
          ...(expiredItems
            ? [`${expiredItems} expired Trash drops will be skipped.`]
            : []),
          "Unexpired Trash keeps its original deletion deadline. A drop that expires before import will be skipped.",
          ...(stage.version === 2
            ? [
                "Legacy v2 exports have no stored integrity checksum. Original files were validated and new SHA-256 checksums calculated.",
              ]
            : []),
        ],
      };
    } catch (error) {
      this.stages.delete(stage.id);
      if (stage.directory)
        await rm(stage.directory, { recursive: true, force: true });
      if (error instanceof AppError) throw error;
      throw invalid();
    }
  }
  async apply(owner: string, input: unknown): Promise<ImportResult> {
    const { previewId, requestId } = applyImportSchema.parse(input);
    idSchema.parse(owner);
    const receipt = await this.receipt(this.db, owner, requestId);
    if (receipt) return { ...receipt, replayed: true };
    const stage = this.stages.get(previewId);
    if (
      !stage ||
      stage.owner !== owner ||
      !stage.ready ||
      stage.expires <= Date.now()
    )
      throw new AppError(
        404,
        "IMPORT_EXPIRED",
        "This import preview is unavailable or expired. Upload the archive again.",
      );
    if (stage.busy)
      throw new AppError(
        409,
        "IMPORT_BUSY",
        "This import is already processing. Retry shortly to confirm the result.",
      );
    stage.busy = true;
    try {
      const started = new Date();
      await utimes(stage.directory, started, started);
      const deadline = Date.now() + 5 * 60000;
      const timeRemaining = () => {
        if (Date.now() > deadline)
          throw new AppError(
            503,
            "IMPORT_TIMEOUT",
            "Import took too long and was rolled back. Retry the same preview.",
          );
      };
      const result = await this.db.transaction(async (tx) => {
        await tx.query("SELECT id FROM capacity_lock WHERE id=1 FOR UPDATE");
        const user = await tx.query(
          "SELECT id FROM users WHERE id=$1 FOR UPDATE",
          [owner],
        );
        if (!user.rows.length)
          throw new AppError(
            401,
            "UNAUTHENTICATED",
            "Sign in to import your library.",
          );
        const replay = await this.receipt(tx, owner, requestId);
        if (replay) return { ...replay, replayed: true };
        const included = this.included(stage);
        this.checkCapacity(await this.usage(tx, owner), included);
        const files = new Map<string, string>(),
          sources = new Map<string, string>();
        for (const file of included.files) {
          timeRemaining();
          const bytes = await readFile(file.path);
          if (
            bytes.length !== file.bytes ||
            createHash("sha256").update(bytes).digest("hex") !== file.sha256
          )
            throw invalid("An original file failed its integrity check.");
          const id = randomUUID();
          files.set(file.id, id);
          await tx.query(
            "INSERT INTO attachments(id,owner,bytes,mime,digest,filename,original_text,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              id,
              owner,
              bytes,
              file.mime,
              file.sha256,
              file.filename,
              file.originalText,
              file.createdAt,
            ],
          );
        }
        for (const source of included.sources) {
          timeRemaining();
          const id = randomUUID();
          sources.set(source.id, id);
          await tx.query(
            "INSERT INTO sources(id,owner,original_text,url,normalized_url,attachment_id,fingerprint,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              id,
              owner,
              source.originalText,
              source.url,
              normalizeSourceUrl(source.url),
              source.attachmentId ? files.get(source.attachmentId) : null,
              this.fingerprint(stage, source),
              source.createdAt,
            ],
          );
        }
        for (const item of included.items) {
          timeRemaining();
          await tx.query(
            `INSERT INTO items(id,owner,source_id,title,summary,category,tags,notes,is_saved,trashed_at,revision,created_at,updated_at,reviewed_transcription,transcription_updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              randomUUID(),
              owner,
              sources.get(item.sourceId),
              item.title,
              item.summary,
              item.category,
              item.tags,
              item.notes,
              item.isSaved,
              item.trashedAt,
              item.revision,
              item.createdAt,
              item.updatedAt,
              item.reviewedTranscription,
              item.transcriptionUpdatedAt,
            ],
          );
        }
        await tx.query(
          "INSERT INTO portability_imports(owner,request_id,archive_digest,item_count,source_count,file_count) VALUES($1,$2,$3,$4,$5,$6)",
          [
            owner,
            requestId,
            stage.digest,
            included.items.length,
            included.sources.length,
            included.files.length,
          ],
        );
        return {
          imported: included.items.length,
          sources: included.sources.length,
          files: included.files.length,
          replayed: false,
        };
      });
      await this.remove(stage);
      return result;
    } finally {
      stage.busy = false;
    }
  }
  private async receipt(tx: Queryable, owner: string, requestId: string) {
    const result = await tx.query<{
      imported: number;
      sources: number;
      files: number;
    }>(
      "SELECT item_count AS imported,source_count AS sources,file_count AS files FROM portability_imports WHERE owner=$1 AND request_id=$2",
      [owner, requestId],
    );
    return result.rows[0];
  }
  async export(
    owner: string,
    write: (chunk: string) => Promise<void>,
    signal?: AbortSignal,
  ) {
    idSchema.parse(owner);
    if (this.exporting)
      throw new AppError(
        429,
        "EXPORT_BUSY",
        "Another archive is being prepared. Try again shortly.",
      );
    this.exporting = true;
    const hash = createHash("sha256");
    const emit = async (record: unknown, integrity = true) => {
      signal?.throwIfAborted();
      const line = JSON.stringify(record) + "\n";
      if (integrity) hash.update(line);
      await write(line);
    };
    try {
      await this.db.transaction(async (tx) => {
        // A consistent MVCC snapshot avoids holding an owner write lock while
        // the browser downloads. Slow/closed clients are bounded by the route.
        await tx.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const exists = await tx.query("SELECT id FROM users WHERE id=$1", [
          owner,
        ]);
        if (!exists.rows.length)
          throw new AppError(
            401,
            "UNAUTHENTICATED",
            "Sign in to export your library.",
          );
        await emit({
          type: "manifest",
          format: archiveFormat,
          version: 3,
          exportedAt: new Date().toISOString(),
        });
        let items = 0,
          sources = 0,
          files = 0,
          fileBytes = 0;
        const live =
          "(i.trashed_at IS NULL OR i.trashed_at>now()-interval '7 days')";
        let after = "00000000-0000-0000-0000-000000000000";
        for (;;) {
          const result = await tx.query<PortableItem>(
            `SELECT i.id,i.source_id AS "sourceId",i.title,i.summary,i.category,i.tags,i.notes,i.is_saved AS "isSaved",i.trashed_at AS "trashedAt",i.revision,i.created_at AS "createdAt",i.updated_at AS "updatedAt",i.reviewed_transcription AS "reviewedTranscription",i.transcription_updated_at AS "transcriptionUpdatedAt" FROM items i WHERE i.owner=$1 AND ${live} AND i.id>$2 ORDER BY i.id LIMIT 100`,
            [owner, after],
          );
          if (!result.rows.length) break;
          for (const row of result.rows) {
            await emit({ type: "item", value: row });
            items++;
            after = row.id;
          }
        }
        after = "00000000-0000-0000-0000-000000000000";
        for (;;) {
          const result = await tx.query<PortableSource>(
            `SELECT s.id,s.original_text AS "originalText",s.url,s.created_at AS "createdAt",s.attachment_id AS "attachmentId" FROM sources s WHERE s.owner=$1 AND s.id>$2 AND EXISTS(SELECT 1 FROM items i WHERE i.owner=s.owner AND i.source_id=s.id AND ${live}) ORDER BY s.id LIMIT 100`,
            [owner, after],
          );
          if (!result.rows.length) break;
          for (const row of result.rows) {
            await emit({ type: "source", value: row });
            sources++;
            after = row.id;
          }
        }
        after = "00000000-0000-0000-0000-000000000000";
        for (;;) {
          const result = await tx.query<PortableFile>(
            `SELECT a.id,a.filename,a.mime,octet_length(a.bytes) AS bytes,a.digest AS sha256,a.created_at AS "createdAt" FROM attachments a WHERE a.owner=$1 AND a.id>$2 AND EXISTS(SELECT 1 FROM sources s JOIN items i ON i.owner=s.owner AND i.source_id=s.id WHERE s.owner=a.owner AND s.attachment_id=a.id AND ${live}) ORDER BY a.id LIMIT 100`,
            [owner, after],
          );
          if (!result.rows.length) break;
          for (const row of result.rows) {
            const file = portableFileSchema.parse(
              JSON.parse(JSON.stringify(row)),
            );
            await emit({ type: "file", value: file });
            const fileHash = createHash("sha256");
            for (
              let offset = 0, index = 0;
              offset < file.bytes;
              offset += archiveChunkBytes, index++
            ) {
              const chunk = await tx.query<{ bytes: Uint8Array }>(
                "SELECT substring(bytes from $3 for $4) AS bytes FROM attachments WHERE owner=$1 AND id=$2",
                [owner, file.id, offset + 1, archiveChunkBytes],
              );
              const bytes = Buffer.from(chunk.rows[0]?.bytes ?? []);
              if (
                bytes.length !==
                Math.min(archiveChunkBytes, file.bytes - offset)
              )
                throw new AppError(
                  500,
                  "EXPORT_INTEGRITY",
                  "An original file could not be exported completely.",
                );
              fileHash.update(bytes);
              await emit({
                type: "chunk",
                id: file.id,
                index,
                data: bytes.toString("base64"),
              });
            }
            if (fileHash.digest("hex") !== file.sha256)
              throw new AppError(
                500,
                "EXPORT_INTEGRITY",
                "An original file failed its integrity check.",
              );
            files++;
            fileBytes += file.bytes;
            after = file.id;
          }
        }
        await emit(
          {
            type: "end",
            items,
            sources,
            files,
            fileBytes,
            sha256: hash.digest("hex"),
          },
          false,
        );
      });
    } finally {
      this.exporting = false;
    }
  }
}

/** Mount after authenticated /api middleware and same-origin protection. Exempt
 * /api/portability/preview from express.json so both formats stream unbuffered. */
export type PortabilityHttpPolicy = {
  uploadIdleTimeoutMs: number;
  uploadDeadlineMs: number;
  exportDeadlineMs: number;
};
export function addPortabilityRoutes(
  app: Express,
  db: Database,
  options: Partial<LibraryLimits> = {},
  policy: Partial<PortabilityHttpPolicy> = {},
) {
  const timeouts = {
    uploadIdleTimeoutMs: 120000,
    uploadDeadlineMs: 5 * 60000,
    exportDeadlineMs: 5 * 60000,
    ...policy,
  };
  const portability = new Portability(db, options);
  app.get("/api/portability/export", async (req, res, next) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeouts.exportDeadlineMs,
    );
    const closed = () => controller.abort();
    res.on("close", closed);
    try {
      res.type("application/x-ndjson");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="drop-it-library.ndjson"',
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox");
      await portability.export(
        res.locals.owner,
        async (line) => {
          controller.signal.throwIfAborted();
          if (!res.write(line))
            await once(res, "drain", { signal: controller.signal });
        },
        controller.signal,
      );
      res.end();
    } catch (error) {
      if (res.headersSent) res.destroy();
      else {
        res.removeHeader("Content-Disposition");
        res.type("application/json");
        next(error);
      }
    } finally {
      clearTimeout(timer);
      res.off("close", closed);
    }
  });
  app.post("/api/portability/preview", async (req, res) => {
    const format = req.is("application/x-ndjson")
      ? "ndjson"
      : req.is("application/json")
        ? "json"
        : null;
    if (!format)
      throw new AppError(
        415,
        "IMPORT_TYPE",
        "Upload a Drop It .ndjson or .json export.",
      );
    if (Number(req.get("Content-Length")) > maxArchiveBytes) throw limit();
    req.setTimeout(timeouts.uploadIdleTimeoutMs, () => req.destroy());
    // An inactivity timeout alone lets a slow sender retain a preview slot and
    // private staging files indefinitely by sending an occasional byte.
    const deadline = setTimeout(() => req.destroy(), timeouts.uploadDeadlineMs);
    try {
      res.json(await portability.preview(res.locals.owner, req, format));
    } finally {
      clearTimeout(deadline);
      req.setTimeout(0);
    }
  });
  app.delete("/api/portability/preview/:id", async (req, res) => {
    await portability.discard(res.locals.owner, idSchema.parse(req.params.id));
    res.json({ ok: true });
  });
  app.post("/api/portability/apply", async (req, res) => {
    res.json(await portability.apply(res.locals.owner, req.body));
  });
  return portability;
}
