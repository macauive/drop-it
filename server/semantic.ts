import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import {
  scopeFilter,
  literalPattern,
  type SearchScope,
} from "./search-scope.js";
import {
  embeddingModel,
  dimensions,
  vectorSchema,
  type AIProvider,
} from "./ai.js";
import { AppError } from "./errors.js";

export type SearchDocument = {
  id: string;
  revision: number;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  notes: string;
  originalText: string;
};
export function searchText(item: SearchDocument) {
  return [
    item.title,
    item.summary,
    item.category,
    item.tags.join(" "),
    item.notes.slice(0, 1000),
    item.originalText.slice(0, 4000),
  ]
    .join("\n")
    .slice(0, 6000);
}
export function similarity(a: number[], b: number[]) {
  // Scale each input before multiplying so valid finite provider values cannot
  // overflow (or underflow) the dot product and silently discard all matches.
  const scaleA = Math.max(...a.map(Math.abs));
  const scaleB = Math.max(...b.map(Math.abs));
  if (!scaleA || !scaleB) return 0;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] / scaleA;
    const y = b[i] / scaleB;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export const embeddingVersion = `${embeddingModel}:${dimensions}:v1`;
export const indexBatchSize = 32;
// Normalize in double precision before casting to pgvector's float32 values.
// This also handles finite provider values near JS overflow/underflow limits.
export function normalizedVector(raw: unknown): number[] {
  const parsed = vectorSchema.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      502,
      "AI_FAILED",
      "AI returned an invalid search index.",
    );
  const scale = Math.max(...parsed.data.map(Math.abs));
  const scaled = parsed.data.map((value) => value / scale);
  const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
  return scaled.map((value) => value / norm);
}
export async function requireSearchPermission(
  db: Database,
  owner: string,
  epoch: number,
) {
  const { rows } = await db.query(
    "SELECT id FROM users WHERE id=$1 AND ai_search_enabled=true AND ai_search_epoch=$2",
    [owner, epoch],
  );
  if (!rows.length)
    throw new AppError(
      403,
      "AI_DISABLED",
      "AI search is turned off or its permission changed. Search again.",
    );
}
export async function searchIndexStatus(
  db: Database,
  owner: string,
  scope: SearchScope,
) {
  const { params, filtered } = scopeFilter(owner, scope);
  const { rows } = await db.query<{ total: number; indexed: number }>(
    `SELECT count(*)::integer AS total, count(e.item_id)::integer AS indexed
    FROM items i LEFT JOIN item_embeddings e ON e.owner=i.owner AND e.item_id=i.id
      AND e.indexed_revision=i.revision AND e.model=$${params.length + 1} AND e.embedding IS NOT NULL
    WHERE ${filtered}`,
    [...params, embeddingVersion],
  );
  return { ...rows[0], pending: rows[0].total - rows[0].indexed };
}
export async function indexSearchBatch(
  db: Database,
  ai: AIProvider,
  owner: string,
  scope: SearchScope,
  epoch: number,
) {
  await requireSearchPermission(db, owner, epoch);
  const { params, filtered } = scopeFilter(owner, scope);
  const { rows: documents } = await db.query<
    SearchDocument & {
      fingerprint: string | null;
      vector: unknown;
      model: string | null;
    }
  >(
    `WITH pending AS MATERIALIZED (
      SELECT i.id FROM items i LEFT JOIN item_embeddings e ON e.owner=i.owner AND e.item_id=i.id
      WHERE ${filtered} AND (e.item_id IS NULL OR e.embedding IS NULL OR e.indexed_revision IS DISTINCT FROM i.revision OR e.model<>$${params.length + 1})
      ORDER BY i.id LIMIT ${indexBatchSize}
    ) SELECT i.id,i.revision,i.title,i.summary,i.category,i.tags,left(i.notes,1000) AS notes,
      left(concat_ws(' ',COALESCE(i.reviewed_transcription,s.original_text),s.page_snapshot->>'text'),4000) AS "originalText",
      e.fingerprint,e.vector,e.model
    FROM pending p JOIN items i ON i.owner=$1 AND i.id=p.id
    JOIN sources s ON s.id=i.source_id AND s.owner=i.owner
    LEFT JOIN item_embeddings e ON e.owner=i.owner AND e.item_id=i.id
    ORDER BY i.id`,
    [...params, embeddingVersion],
  );
  if (!documents.length) return 0;
  const batch = documents.map((doc) => {
    const text = searchText(doc);
    const fingerprint = createHash("sha256").update(text).digest("hex");
    const cached =
      doc.model === embeddingVersion &&
      doc.fingerprint === fingerprint &&
      vectorSchema.safeParse(doc.vector).success;
    return {
      doc,
      text,
      fingerprint,
      vector: cached ? normalizedVector(doc.vector) : undefined,
    };
  });
  const missing = batch.filter((entry) => !entry.vector);
  if (missing.length) {
    await requireSearchPermission(db, owner, epoch);
    const embedded = await ai.embed(missing.map((entry) => entry.text));
    if (embedded.length !== missing.length)
      throw new AppError(
        502,
        "AI_FAILED",
        "AI returned an invalid search index.",
      );
    for (let i = 0; i < missing.length; i++)
      missing[i].vector = normalizedVector(embedded[i]);
  }
  // One bounded write, guarded against edits, deletion, preference revocation,
  // and revocation followed by re-enabling while an external call was running.
  await db.transaction(async (tx) => {
    // Serialize with preference changes and content edits, but never hold this
    // lock while awaiting the provider. MVCC checks alone permit a late insert
    // to race a preference transaction's cache deletion.
    const permission = await tx.query(
      "SELECT id FROM users WHERE id=$1 AND ai_search_enabled=true AND ai_search_epoch=$2 FOR UPDATE",
      [owner, epoch],
    );
    if (!permission.rows.length)
      throw new AppError(
        403,
        "AI_DISABLED",
        "AI search permission changed. Search again.",
      );
    await tx.query(
      `INSERT INTO item_embeddings(owner,item_id,model,fingerprint,vector,embedding,indexed_revision)
    SELECT i.owner,i.id,$2,b.fingerprint,b.vector,b.embedding::vector(512),i.revision
    FROM jsonb_to_recordset($3::jsonb) AS b(id uuid,revision integer,fingerprint text,vector double precision[],embedding text)
    JOIN items i ON i.owner=$1 AND i.id=b.id AND i.revision=b.revision
    JOIN users u ON u.id=i.owner AND u.ai_search_enabled=true AND u.ai_search_epoch=$4
    ON CONFLICT(owner,item_id) DO UPDATE SET model=EXCLUDED.model,fingerprint=EXCLUDED.fingerprint,
      vector=EXCLUDED.vector,embedding=EXCLUDED.embedding,indexed_revision=EXCLUDED.indexed_revision`,
      [
        owner,
        embeddingVersion,
        JSON.stringify(
          batch.map(({ doc, fingerprint, vector }) => ({
            id: doc.id,
            revision: doc.revision,
            fingerprint,
            vector,
            embedding: JSON.stringify(vector),
          })),
        ),
        epoch,
      ],
    );
  });
  await requireSearchPermission(db, owner, epoch);
  return documents.length;
}

export async function semanticPage(
  db: Database,
  owner: string,
  scope: SearchScope,
  epoch: number,
  queryVector: number[],
  terms: string[],
  hybrid: boolean,
  limit: number,
  offset: number,
) {
  const { params, filtered } = scopeFilter(owner, scope);
  const model = `$${params.length + 1}`,
    vector = `$${params.length + 2}::vector(512)`,
    permissionEpoch = `$${params.length + 3}`;
  const keywordFilter = terms
    .map(
      (_, index) =>
        `i.search_text LIKE $${params.length + 6 + index} ESCAPE '!'`,
    )
    .join(" AND ");
  type Match = {
    id: string;
    revision: number;
    keyword: boolean;
    semantic: boolean;
  };
  // Exact scoring intentionally avoids a global ANN index: tenant and view
  // filters apply before scoring, with no approximate-recall loss at 10k items.
  // Only page-sized IDs leave PostgreSQL; documents/vectors stay in the DB.
  const { rows } = await db.query<{ total: number; matches: Match[] }>(
    `WITH keywords AS MATERIALIZED (
      SELECT i.id FROM items i WHERE ${filtered} AND ${keywordFilter}
    ), scored AS MATERIALIZED (
      SELECT i.id,i.revision,k.id IS NOT NULL AS keyword,
        1-(e.embedding <=> ${vector}) AS score
      FROM items i LEFT JOIN keywords k ON k.id=i.id
      JOIN users u ON u.id=i.owner AND u.ai_search_enabled=true AND u.ai_search_epoch=${permissionEpoch}
      LEFT JOIN item_embeddings e ON e.owner=i.owner AND e.item_id=i.id AND e.model=${model}
        AND e.indexed_revision=i.revision AND e.embedding IS NOT NULL
      WHERE ${filtered}
    ), matched AS MATERIALIZED (
      SELECT id,revision,keyword,COALESCE(score>=0.2,false) AS semantic,COALESCE(score,0) AS score
      FROM scored WHERE score>=0.2 ${hybrid ? "OR keyword" : ""}
    ), page AS (
      SELECT id,revision,keyword,semantic FROM matched
      ORDER BY ${hybrid ? "keyword DESC," : ""}score DESC,id LIMIT $${params.length + 4} OFFSET $${params.length + 5}
    ) SELECT (SELECT count(*)::integer FROM matched) AS total,
      COALESCE((SELECT jsonb_agg(page) FROM page),'[]'::jsonb) AS matches`,
    [
      ...params,
      embeddingVersion,
      JSON.stringify(queryVector),
      epoch,
      limit,
      offset,
      ...terms.map(literalPattern),
    ],
  );
  return rows[0];
}
