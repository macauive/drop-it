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
  draftSchema,
  draftResultSchema,
  type Item,
  type Source,
  type SearchResult,
} from "../shared/schema.js";
import { AppError } from "./errors.js";
import type { AIProvider } from "./ai.js";
import { semanticRank, type SearchDocument } from "./semantic.js";
import { validateUpload } from "./uploads.js";
import { isImageMime } from "../shared/files.js";

export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const selection = `SELECT i.id, i.source_id AS "sourceId", i.title, i.summary, i.category,
  i.is_saved AS "isSaved", i.trashed_at AS "trashedAt", i.trashed_at + interval '7 days' AS "deleteAfter",
  i.tags, i.notes, i.revision, i.created_at AS "createdAt", i.updated_at AS "updatedAt",
  s.url AS "sourceUrl", EXISTS(SELECT 1 FROM attachments a WHERE a.id=s.attachment_id AND a.owner=s.owner AND a.mime IN ('image/png','image/jpeg','image/webp')) AS "hasImage"
  FROM items i JOIN sources s ON s.id=i.source_id AND s.owner=i.owner`;
export class Library {
  constructor(
    readonly db: Database,
    private readonly ai?: AIProvider,
  ) {}
  private readonly aiUsage = new Map<
    string,
    { start: number; count: number; busy: boolean }
  >();
  get aiAvailable() {
    return Boolean(this.ai);
  }
  private async withAI<T>(owner: string, run: (ai: AIProvider) => Promise<T>) {
    if (!this.ai)
      throw new AppError(
        503,
        "AI_UNAVAILABLE",
        "AI is not configured. Manual entry and keyword search are still available.",
      );
    const now = Date.now();
    for (const [id, usage] of this.aiUsage)
      if (!usage.busy && now - usage.start >= 60000) this.aiUsage.delete(id);
    const usage = this.aiUsage.get(owner) ?? {
      start: now,
      count: 0,
      busy: false,
    };
    if (usage.busy || usage.count >= 20)
      throw new AppError(
        429,
        "AI_BUSY",
        "Please wait before starting another AI request.",
      );
    usage.count++;
    usage.busy = true;
    this.aiUsage.set(owner, usage);
    try {
      return await run(this.ai);
    } finally {
      usage.busy = false;
    }
  }
  async draft(owner: string, input: unknown) {
    const { source } = draftSchema.parse(input);
    let image: string | undefined;
    let pdf: { filename: string; data: string } | undefined;
    let fileText = "";
    if (source.attachmentId) {
      const { rows } = await this.db.query<{
        bytes: Uint8Array;
        mime: string;
        filename: string;
        original_text: string;
      }>(
        "SELECT bytes,mime,filename,original_text FROM attachments WHERE owner=$1 AND id=$2",
        [owner, source.attachmentId],
      );
      if (!rows[0])
        throw new AppError(404, "NOT_FOUND", "Attachment unavailable.");
      if (isImageMime(rows[0].mime)) {
        const preview = await sharp(Buffer.from(rows[0].bytes), {
          limitInputPixels: 25_000_000,
        })
          .rotate()
          .resize({
            width: 1536,
            height: 1536,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: 85 })
          .toBuffer();
        image = `data:image/jpeg;base64,${preview.toString("base64")}`;
      } else if (rows[0].mime === "application/pdf") {
        pdf = {
          filename: rows[0].filename,
          data: `data:application/pdf;base64,${Buffer.from(rows[0].bytes).toString("base64")}`,
        };
      } else fileText = rows[0].original_text;
    }
    const { rows } = await this.db.query<{ category: string }>(
      "SELECT category FROM items WHERE owner=$1 GROUP BY category ORDER BY count(*) DESC,category LIMIT 100",
      [owner],
    );
    const url = source.url ? new URL(source.url) : null;
    return this.withAI(owner, async (ai) => {
      const draft = draftResultSchema.parse(
        await ai.draft({
          text: (source.originalText || fileText).slice(0, 16000),
          url: url ? `${url.origin}${url.pathname}` : "",
          categories: rows.map((row) => categorySchema.parse(row.category)),
          image,
          pdf,
        }),
      );
      draft.category = await this.canonicalCategory(
        owner,
        draft.category,
        this.db,
      );
      if (source.url) draft.sourceUrl = source.url;
      return { draft };
    });
  }
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
  async upload(
    owner: string,
    bytes: Buffer,
    declaredMime: string,
    name?: string,
  ) {
    const { mime, filename, originalText } = await validateUpload(
      bytes,
      declaredMime,
      name,
    );
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
        "INSERT INTO attachments(id,owner,bytes,mime,digest,filename,original_text) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id, owner, bytes, mime, digest(bytes), filename, originalText],
      );
    });
    return { attachmentId: id, originalText };
  }
  async get(owner: string, id: string, tx: Queryable = this.db) {
    idSchema.parse(id);
    const { rows } = await tx.query<Item>(
      `${selection} WHERE i.owner=$1 AND i.id=$2 AND (i.trashed_at IS NULL OR i.trashed_at > now()-interval '7 days')`,
      [owner, id],
    );
    if (!rows[0])
      throw new AppError(404, "NOT_FOUND", "This item is no longer available.");
    const result = await tx.query<Source & { attachmentId: string | null }>(
      `SELECT s.id, s.original_text AS "originalText", s.url, s.created_at AS "createdAt", s.attachment_id AS "attachmentId", s.attachment_id IS NOT NULL AS "hasFile", COALESCE(a.mime IN ('image/png','image/jpeg','image/webp'),false) AS "hasImage", a.filename,a.mime FROM sources s LEFT JOIN attachments a ON a.id=s.attachment_id AND a.owner=s.owner WHERE s.owner=$1 AND s.id=$2`,
      [owner, rows[0].sourceId],
    );
    return { item: rows[0], source: result.rows[0] };
  }
  async image(owner: string, sourceId: string) {
    const file = await this.file(owner, sourceId);
    if (!isImageMime(file.mime))
      throw new AppError(404, "NOT_FOUND", "Image unavailable.");
    return file;
  }
  async file(owner: string, sourceId: string) {
    const { rows } = await this.db.query<{
      bytes: Uint8Array;
      mime: string;
      filename: string;
    }>(
      `SELECT a.bytes,a.mime,a.filename FROM attachments a JOIN sources s ON s.attachment_id=a.id AND s.owner=a.owner WHERE s.owner=$1 AND s.id=$2
      AND EXISTS(SELECT 1 FROM items i WHERE i.owner=s.owner AND i.source_id=s.id AND (i.trashed_at IS NULL OR i.trashed_at > now()-interval '7 days'))`,
      [owner, idSchema.parse(sourceId)],
    );
    if (!rows[0]) throw new AppError(404, "NOT_FOUND", "File unavailable.");
    return {
      bytes: Buffer.from(rows[0].bytes),
      mime: rows[0].mime,
      filename: rows[0].filename,
    };
  }
  async search(owner: string, input: unknown): Promise<SearchResult> {
    const q = searchSchema.parse(input);
    const keywordFallback = async (searchNotice: string) => ({
      ...(await this.search(owner, { ...q, mode: "keyword" })),
      searchNotice,
    });
    if (q.mode === "hybrid" && q.query && !this.aiAvailable)
      return keywordFallback(
        "Showing keyword matches. AI search is unavailable.",
      );
    const params: unknown[] = [owner];
    const where = ["i.owner=$1"];
    const add = (expression: string, value: unknown) => {
      params.push(value);
      where.push(expression.replace("?", `$${params.length}`));
    };
    const semantic = q.mode !== "keyword" && Boolean(q.query);
    if (q.query && !semantic) {
      // Literal substring terms: SQL wildcards from input do not widen the search.
      for (const term of q.query.toLowerCase().split(/\s+/).slice(0, 12)) {
        add(
          `strpos(lower(concat_ws(' ',i.title,i.summary,array_to_string(i.tags,' '),i.notes,s.original_text,s.url)),?)>0`,
          term,
        );
      }
    }
    if (q.category) add("lower(i.category)=lower(?)", q.category);
    where.push(
      q.view === "Trash"
        ? "i.trashed_at IS NOT NULL AND i.trashed_at > now()-interval '7 days'"
        : "i.trashed_at IS NULL",
    );
    if (q.view === "Saved") where.push("i.is_saved=true");
    if (q.tag) add("?=ANY(i.tags)", q.tag.toLowerCase());
    if (q.before) add("i.created_at<?", q.before);
    if (q.after) add("i.created_at>?", q.after);
    const filtered = where.join(" AND ");
    const total = await this.db.query<{ count: string }>(
      `SELECT count(*) FROM items i JOIN sources s ON s.id=i.source_id AND s.owner=i.owner WHERE ${filtered}`,
      params,
    );
    let { rows: items } = await this.db.query<Item>(
      `${selection} WHERE ${filtered} ORDER BY i.created_at DESC,i.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.limit, q.offset],
    );
    let resultTotal = Number(total.rows[0].count);
    if (semantic) {
      if (resultTotal > 1000 && q.mode === "hybrid")
        return keywordFallback(
          "Showing keyword matches. Narrow the filters to include AI matches in libraries over 1,000 drops.",
        );
      if (resultTotal > 1000)
        throw new AppError(
          400,
          "AI_SEARCH_SIZE",
          "AI search currently supports up to 1,000 drops at once. Narrow the pool or view.",
        );
      const docs = await this.db.query<
        SearchDocument & { keywordMatch: boolean }
      >(
        `SELECT i.id,i.revision,i.title,i.summary,i.category,i.tags,i.notes,s.original_text AS "originalText",
        NOT EXISTS (SELECT 1 FROM unnest($${params.length + 1}::text[]) AS term
          WHERE strpos(lower(concat_ws(' ',i.title,i.summary,array_to_string(i.tags,' '),i.notes,s.original_text,s.url)),term)=0) AS "keywordMatch"
        FROM items i JOIN sources s ON s.id=i.source_id AND s.owner=i.owner WHERE ${filtered} ORDER BY i.id`,
        [...params, q.query.toLowerCase().split(/\s+/).slice(0, 12)],
      );
      let ranked: { id: string; revision: number; score: number }[];
      try {
        ranked = await this.withAI(owner, (ai) =>
          semanticRank(this.db, ai, owner, q.query, docs.rows),
        );
      } catch (error) {
        if (
          q.mode === "hybrid" &&
          error instanceof AppError &&
          error.code.startsWith("AI_")
        )
          return keywordFallback(
            "Showing keyword matches. AI search could not complete; try again shortly.",
          );
        throw error;
      }
      const byRank = new Map(ranked.map((entry) => [entry.id, entry]));
      for (const doc of docs.rows) {
        if (doc.keywordMatch) {
          const entry = byRank.get(doc.id);
          byRank.set(doc.id, {
            id: doc.id,
            revision: doc.revision,
            score: 2 + (entry?.score ?? 0),
          });
        }
      }
      ranked = [...byRank.values()].sort(
        (a, b) => b.score - a.score || a.id.localeCompare(b.id),
      );
      const current = await this.db.query<Item>(
        `${selection} WHERE ${filtered} AND i.id=ANY($${params.length + 1}::uuid[])`,
        [...params, ranked.map((entry) => entry.id)],
      );
      const byId = new Map(current.rows.map((item) => [item.id, item]));
      const results = ranked.flatMap((entry) => {
        const item = byId.get(entry.id);
        return item && item.revision === entry.revision ? [item] : [];
      });
      resultTotal = results.length;
      items = results.slice(q.offset, q.offset + q.limit);
    }
    const stats = await this.db.query<{
      all: string;
      saved: string;
      trash: string;
    }>(
      `SELECT count(*) FILTER (WHERE trashed_at IS NULL) AS all,
      count(*) FILTER (WHERE trashed_at IS NULL AND is_saved) AS saved,
      count(*) FILTER (WHERE trashed_at > now()-interval '7 days') AS trash FROM items WHERE owner=$1`,
      [owner],
    );
    const categoryRows = await this.db.query<{ category: string }>(
      "SELECT DISTINCT category FROM items WHERE owner=$1 AND (trashed_at IS NULL OR trashed_at > now()-interval '7 days') ORDER BY category",
      [owner],
    );
    return {
      items,
      aiAvailable: this.aiAvailable,
      mode: semantic ? q.mode : ("keyword" as const),
      categories: categoryRows.rows.map((row) =>
        categorySchema.parse(row.category),
      ),
      total: resultTotal,
      counts: {
        "All drops": Number(stats.rows[0].all),
        Saved: Number(stats.rows[0].saved),
        Trash: Number(stats.rows[0].trash),
      },
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
        if (result.item.trashedAt)
          throw new AppError(
            409,
            "IN_TRASH",
            "This drop is in Trash. Restore it to use it again.",
          );
        return { ...result, replayed: true };
      }
      let sourceId = data.sourceId;
      if (sourceId) {
        const source = await tx.query(
          "SELECT s.id FROM sources s WHERE s.owner=$1 AND s.id=$2 AND EXISTS(SELECT 1 FROM items i WHERE i.owner=s.owner AND i.source_id=s.id AND (i.trashed_at IS NULL OR i.trashed_at > now()-interval '7 days'))",
          [owner, sourceId],
        );
        if (!source.rows.length)
          throw new AppError(404, "NOT_FOUND", "Source unavailable.");
      } else {
        const source = data.source!;
        let imageDigest = "";
        if (source.attachmentId) {
          const image = await tx.query<{
            digest: string;
            original_text: string;
          }>(
            "SELECT digest,original_text FROM attachments WHERE owner=$1 AND id=$2",
            [owner, source.attachmentId],
          );
          if (!image.rows[0])
            throw new AppError(404, "NOT_FOUND", "Attachment unavailable.");
          imageDigest = image.rows[0].digest;
          if (!source.originalText)
            source.originalText = image.rows[0].original_text;
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
          `SELECT i.id,i.title FROM items i JOIN sources s ON s.id=i.source_id AND s.owner=i.owner WHERE i.owner=$1 AND (i.trashed_at IS NULL OR i.trashed_at > now()-interval '7 days') AND (s.fingerprint=$2 OR ($3<>'' AND s.url=$3)) LIMIT 5`,
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
      if (item.trashedAt)
        throw new AppError(
          409,
          "IN_TRASH",
          "Restore this drop before editing it.",
        );
      const merged = { ...item, ...data };
      const { rows } = await tx.query(
        "UPDATE items SET title=$1,summary=$2,category=$3,tags=$4,notes=$5,is_saved=$6,revision=revision+1,updated_at=now() WHERE owner=$7 AND id=$8 AND revision=$9 RETURNING id",
        [
          merged.title,
          merged.summary,
          await this.canonicalCategory(owner, merged.category, tx),
          merged.tags,
          merged.notes,
          merged.isSaved,
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
      if (
        ["title", "summary", "category", "tags", "notes"].some(
          (field) => field in data,
        )
      )
        await tx.query(
          "DELETE FROM item_embeddings WHERE owner=$1 AND item_id=$2",
          [owner, data.id],
        );
      return this.get(owner, data.id, tx);
    });
  }
  async delete(owner: string, input: unknown) {
    const data = deleteSchema.parse(input);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
      const { item } = await this.get(owner, data.id, tx);
      if (item.revision !== data.revision)
        throw new AppError(
          409,
          "CONFLICT",
          "This drop changed elsewhere. Reopen it before wiping.",
        );
      if (item.trashedAt) return { trashed: true };
      const result = await tx.query(
        "UPDATE items SET trashed_at=now(),revision=revision+1,updated_at=now() WHERE owner=$1 AND id=$2 AND revision=$3 RETURNING id",
        [owner, data.id, data.revision],
      );
      if (!result.rows.length)
        throw new AppError(
          409,
          "CONFLICT",
          "This item changed elsewhere. Reopen it before deleting.",
        );
      await tx.query(
        "DELETE FROM item_embeddings WHERE owner=$1 AND item_id=$2",
        [owner, data.id],
      );
      return { trashed: true };
    });
  }
  async restore(owner: string, input: unknown) {
    const data = deleteSchema.parse(input);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
      const { item } = await this.get(owner, data.id, tx);
      if (item.revision !== data.revision)
        throw new AppError(
          409,
          "CONFLICT",
          "This drop changed elsewhere. Reopen it before restoring.",
        );
      if (item.trashedAt)
        await tx.query(
          "UPDATE items SET trashed_at=NULL,revision=revision+1,updated_at=now() WHERE owner=$1 AND id=$2",
          [owner, data.id],
        );
      return this.get(owner, data.id, tx);
    });
  }
  async export(owner: string) {
    return this.db.transaction(async (tx) => {
      // Share the owner lock used by saves/deletes for a consistent export.
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
      const items = await tx.query<Item>(
        `${selection} WHERE i.owner=$1 AND (i.trashed_at IS NULL OR i.trashed_at > now()-interval '7 days') ORDER BY i.created_at`,
        [owner],
      );
      const sources = await tx.query<
        Source & { mime: string | null; bytes: Uint8Array | null }
      >(
        `SELECT s.id,s.original_text AS "originalText",s.url,s.created_at AS "createdAt",a.filename,a.mime,a.bytes FROM sources s LEFT JOIN attachments a ON a.id=s.attachment_id AND a.owner=s.owner WHERE s.owner=$1 AND EXISTS(SELECT 1 FROM items i WHERE i.owner=s.owner AND i.source_id=s.id AND (i.trashed_at IS NULL OR i.trashed_at > now()-interval '7 days'))`,
        [owner],
      );
      return {
        version: 2,
        exportedAt: new Date().toISOString(),
        items: items.rows,
        sources: sources.rows.map(({ bytes, ...s }) => ({
          ...s,
          imageBase64:
            bytes && isImageMime(s.mime ?? "")
              ? Buffer.from(bytes).toString("base64")
              : null,
          fileBase64:
            bytes && !isImageMime(s.mime ?? "")
              ? Buffer.from(bytes).toString("base64")
              : null,
        })),
      };
    });
  }
}
