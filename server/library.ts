import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Database, Queryable } from "./db.js";
import {
  saveSchema,
  searchSchema,
  updateSchema,
  deleteSchema,
  idSchema,
  categorySchema,
  type Item,
  type Source,
} from "../shared/schema.js";
import { AppError } from "./errors.js";

export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const selection = `SELECT i.id, i.source_id AS "sourceId", i.title, i.summary, i.category, i.status,
  i.tags, i.notes, i.revision, i.created_at AS "createdAt", i.updated_at AS "updatedAt",
  s.url AS "sourceUrl", s.attachment_id IS NOT NULL AS "hasImage"
  FROM items i JOIN sources s ON s.id=i.source_id AND s.owner=i.owner`;
export class Library {
  constructor(readonly db: Database) {}
  private async canonicalCategory(
    owner: string,
    category: string,
    tx: Queryable,
  ) {
    const { rows } = await tx.query<{ category: string }>(
      "SELECT category FROM items WHERE owner=$1 AND lower(category)=lower($2) ORDER BY created_at,id LIMIT 1",
      [owner, category],
    );
    return categorySchema.parse(rows[0]?.category ?? category);
  }
  async upload(owner: string, bytes: Buffer, declaredMime: string) {
    if (!bytes.length || bytes.length > 10 * 1024 * 1024)
      throw new AppError(413, "FILE_SIZE", "Choose an image under 10 MB.");
    let mime: string;
    try {
      const image = sharp(bytes, {
        limitInputPixels: 25_000_000,
        animated: true,
        failOn: "warning",
      });
      const metadata = await image.metadata();
      mime = (
        { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as Record<
          string,
          string
        >
      )[metadata.format ?? ""];
      if (
        !mime ||
        (metadata.pages && metadata.pages > 1) ||
        mime !== declaredMime
      )
        throw new Error("Invalid image");
      await image.stats();
    } catch {
      throw new AppError(
        400,
        "INVALID_IMAGE",
        "Choose a valid, single-frame PNG, JPEG, or WebP image under 25 megapixels.",
      );
    }
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
      const { rows } = await tx.query<{ size: string }>(
        "SELECT COALESCE(sum(octet_length(bytes)),0) AS size FROM attachments WHERE owner=$1",
        [owner],
      );
      if (Number(rows[0].size) + bytes.length > 250 * 1024 * 1024)
        throw new AppError(
          413,
          "QUOTA",
          "Your 250 MB attachment limit has been reached.",
        );
      await tx.query(
        "INSERT INTO attachments(id,owner,bytes,mime,digest) VALUES($1,$2,$3,$4,$5)",
        [id, owner, bytes, mime, digest(bytes)],
      );
    });
    return { attachmentId: id };
  }
  async get(owner: string, id: string, tx: Queryable = this.db) {
    idSchema.parse(id);
    const { rows } = await tx.query<Item>(
      `${selection} WHERE i.owner=$1 AND i.id=$2`,
      [owner, id],
    );
    if (!rows[0])
      throw new AppError(404, "NOT_FOUND", "This item is no longer available.");
    const result = await tx.query<Source & { attachmentId: string | null }>(
      `SELECT id, original_text AS "originalText", url, created_at AS "createdAt", attachment_id AS "attachmentId", attachment_id IS NOT NULL AS "hasImage" FROM sources WHERE owner=$1 AND id=$2`,
      [owner, rows[0].sourceId],
    );
    return { item: rows[0], source: result.rows[0] };
  }
  async image(owner: string, sourceId: string) {
    const { rows } = await this.db.query<{ bytes: Uint8Array; mime: string }>(
      `SELECT a.bytes,a.mime FROM attachments a JOIN sources s ON s.attachment_id=a.id AND s.owner=a.owner WHERE s.owner=$1 AND s.id=$2`,
      [owner, idSchema.parse(sourceId)],
    );
    if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Image unavailable.");
    return { bytes: Buffer.from(rows[0].bytes), mime: rows[0].mime };
  }
  async search(owner: string, input: unknown) {
    const q = searchSchema.parse(input);
    const params: unknown[] = [owner];
    const where = ["i.owner=$1"];
    const add = (expression: string, value: unknown) => {
      params.push(value);
      where.push(expression.replace("?", `$${params.length}`));
    };
    if (q.query) {
      // Literal substring terms: SQL wildcards from input do not widen the search.
      for (const term of q.query.toLowerCase().split(/\s+/).slice(0, 12)) {
        add(
          `strpos(lower(concat_ws(' ',i.title,i.summary,array_to_string(i.tags,' '),i.notes,s.original_text,s.url)),?)>0`,
          term,
        );
      }
    }
    if (q.category) add("lower(i.category)=lower(?)", q.category);
    if (q.status) add("i.status=?", q.status);
    if (q.tag) add("?=ANY(i.tags)", q.tag.toLowerCase());
    if (q.before) add("i.created_at<?", q.before);
    if (q.after) add("i.created_at>?", q.after);
    const filtered = where.join(" AND ");
    const total = await this.db.query<{ count: string }>(
      `SELECT count(*) FROM items i JOIN sources s ON s.id=i.source_id AND s.owner=i.owner WHERE ${filtered}`,
      params,
    );
    const { rows: items } = await this.db.query<Item>(
      `${selection} WHERE ${filtered} ORDER BY i.created_at DESC,i.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.limit, q.offset],
    );
    const stats = await this.db.query<{ status: string; count: string }>(
      "SELECT status,count(*) FROM items WHERE owner=$1 GROUP BY status",
      [owner],
    );
    const categoryRows = await this.db.query<{ category: string }>(
      "SELECT DISTINCT category FROM items WHERE owner=$1 ORDER BY category",
      [owner],
    );
    return {
      items,
      categories: categoryRows.rows.map((row) =>
        categorySchema.parse(row.category),
      ),
      total: Number(total.rows[0].count),
      counts: Object.fromEntries(
        stats.rows.map((row) => [row.status, Number(row.count)]),
      ),
    };
  }
  async save(owner: string, input: unknown) {
    const data = saveSchema.parse(input);
    const fingerprint = digest(JSON.stringify(data));
    // Preserve retries of pre-migration requests that omitted the old default.
    const legacyFingerprint =
      (input as { category?: unknown }).category === undefined
        ? digest(JSON.stringify({ ...data, category: "Other" }))
        : fingerprint;
    return this.db.transaction(async (tx) => {
      // Serializes saves for one owner, covering idempotency and duplicate detection.
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
      const request = await tx.query<{ fingerprint: string; item_id: string }>(
        "SELECT fingerprint,item_id FROM save_requests WHERE owner=$1 AND request_id=$2",
        [owner, data.requestId],
      );
      if (request.rows[0]) {
        if (
          request.rows[0].fingerprint !== fingerprint &&
          request.rows[0].fingerprint !== legacyFingerprint
        )
          throw new AppError(
            409,
            "REQUEST_REUSED",
            "This save request was already used for different content.",
          );
        const result = await this.get(owner, request.rows[0].item_id, tx).catch(
          (error: unknown) => {
            if (error instanceof AppError && error.code === "NOT_FOUND")
              throw new AppError(
                410,
                "DELETED",
                "This saved item has since been deleted.",
              );
            throw error;
          },
        );
        return { ...result, replayed: true };
      }
      let sourceId = data.sourceId;
      if (sourceId) {
        const source = await tx.query(
          "SELECT id FROM sources WHERE owner=$1 AND id=$2",
          [owner, sourceId],
        );
        if (!source.rows.length)
          throw new AppError(404, "NOT_FOUND", "Source unavailable.");
      } else {
        const source = data.source!;
        let imageDigest = "";
        if (source.attachmentId) {
          const image = await tx.query<{ digest: string }>(
            "SELECT digest FROM attachments WHERE owner=$1 AND id=$2",
            [owner, source.attachmentId],
          );
          if (!image.rows[0])
            throw new AppError(404, "NOT_FOUND", "Attachment unavailable.");
          imageDigest = image.rows[0].digest;
        }
        let url = source.url;
        if (url) {
          const parsed = new URL(url);
          parsed.hash = "";
          url = parsed.href;
        }
        const sourceFingerprint = digest(
          JSON.stringify([
            source.originalText.trim(),
            url,
            imageDigest,
            !source.originalText.trim() && !url && !imageDigest
              ? data.title
              : "",
          ]),
        );
        const duplicates = await tx.query<{ id: string; title: string }>(
          `SELECT i.id,i.title FROM items i JOIN sources s ON s.id=i.source_id AND s.owner=i.owner WHERE i.owner=$1 AND (s.fingerprint=$2 OR ($3<>'' AND s.url=$3)) LIMIT 5`,
          [owner, sourceFingerprint, url],
        );
        if (!data.allowDuplicate && duplicates.rows.length)
          throw new AppError(
            409,
            "DUPLICATE",
            "This source is already in your library.",
            { items: duplicates.rows },
          );
        sourceId = randomUUID();
        await tx.query(
          "INSERT INTO sources(id,owner,original_text,url,attachment_id,fingerprint) VALUES($1,$2,$3,$4,$5,$6)",
          [
            sourceId,
            owner,
            source.originalText,
            url,
            source.attachmentId ?? null,
            sourceFingerprint,
          ],
        );
      }
      const id = randomUUID();
      await tx.query(
        "INSERT INTO items(id,owner,source_id,title,summary,category,tags,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          owner,
          sourceId,
          data.title,
          data.summary,
          await this.canonicalCategory(owner, data.category, tx),
          data.tags,
          data.notes,
        ],
      );
      await tx.query(
        "INSERT INTO save_requests(owner,request_id,fingerprint,item_id) VALUES($1,$2,$3,$4)",
        [owner, data.requestId, fingerprint, id],
      );
      return { ...(await this.get(owner, id, tx)), replayed: false };
    });
  }
  async update(owner: string, input: unknown) {
    const data = updateSchema.parse(input);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
      const { item } = await this.get(owner, data.id, tx);
      const merged = { ...item, ...data };
      const { rows } = await tx.query(
        "UPDATE items SET title=$1,summary=$2,category=$3,tags=$4,notes=$5,status=$6,revision=revision+1,updated_at=now() WHERE owner=$7 AND id=$8 AND revision=$9 RETURNING id",
        [
          merged.title,
          merged.summary,
          await this.canonicalCategory(owner, merged.category, tx),
          merged.tags,
          merged.notes,
          merged.status,
          owner,
          data.id,
          data.revision,
        ],
      );
      if (!rows.length)
        throw new AppError(
          409,
          "CONFLICT",
          "This item changed elsewhere. Reopen it before editing.",
        );
      return this.get(owner, data.id, tx);
    });
  }
  async delete(owner: string, input: unknown) {
    const data = deleteSchema.parse(input);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
      const { source } = await this.get(owner, data.id, tx);
      const result = await tx.query(
        "DELETE FROM items WHERE owner=$1 AND id=$2 AND revision=$3 RETURNING id",
        [owner, data.id, data.revision],
      );
      if (!result.rows.length)
        throw new AppError(
          409,
          "CONFLICT",
          "This item changed elsewhere. Reopen it before deleting.",
        );
      await tx.query(
        "DELETE FROM sources WHERE owner=$1 AND id=$2 AND NOT EXISTS(SELECT 1 FROM items WHERE owner=$1 AND source_id=$2)",
        [owner, source.id],
      );
      if (source.attachmentId)
        await tx.query(
          "DELETE FROM attachments WHERE owner=$1 AND id=$2 AND NOT EXISTS(SELECT 1 FROM sources WHERE owner=$1 AND attachment_id=$2)",
          [owner, source.attachmentId],
        );
      return { deleted: true };
    });
  }
  async export(owner: string) {
    return this.db.transaction(async (tx) => {
      // Share the owner lock used by saves/deletes for a consistent export.
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
      const items = await tx.query<Item>(
        `${selection} WHERE i.owner=$1 ORDER BY i.created_at`,
        [owner],
      );
      const sources = await tx.query<
        Source & { mime: string | null; bytes: Uint8Array | null }
      >(
        `SELECT s.id,s.original_text AS "originalText",s.url,s.created_at AS "createdAt",a.mime,a.bytes FROM sources s LEFT JOIN attachments a ON a.id=s.attachment_id AND a.owner=s.owner WHERE s.owner=$1`,
        [owner],
      );
      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        items: items.rows,
        sources: sources.rows.map(({ bytes, ...s }) => ({
          ...s,
          imageBase64: bytes ? Buffer.from(bytes).toString("base64") : null,
        })),
      };
    });
  }
}
