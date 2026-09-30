import { createHash } from "node:crypto";
import type { Database } from "./db.js";
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
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export async function semanticRank(
  db: Database,
  ai: AIProvider,
  owner: string,
  query: string,
  documents: SearchDocument[],
) {
  if (!documents.length) return [];
  const model = `${embeddingModel}:${dimensions}:v1`;
  const cached = await db.query<{
    item_id: string;
    fingerprint: string;
    vector: number[];
  }>(
    "SELECT item_id,fingerprint,vector FROM item_embeddings WHERE owner=$1 AND model=$2 AND item_id=ANY($3::uuid[])",
    [owner, model, documents.map((d) => d.id)],
  );
  const cache = new Map(cached.rows.map((row) => [row.item_id, row]));
  const vectors = new Map<string, number[]>();
  const pending = [];
  for (const doc of documents) {
    const text = searchText(doc),
      fingerprint = createHash("sha256").update(text).digest("hex"),
      entry = cache.get(doc.id);
    if (
      entry?.fingerprint === fingerprint &&
      vectorSchema.safeParse(entry.vector).success
    )
      vectors.set(doc.id, entry.vector);
    else pending.push({ doc, text, fingerprint });
  }
  const deadline = Date.now() + 45000;
  for (let offset = 0; offset < pending.length; offset += 32) {
    if (Date.now() > deadline)
      throw new AppError(
        503,
        "AI_INDEXING",
        "Search indexing is still in progress. Retry to continue, or use keyword search.",
      );
    const batch = pending.slice(offset, offset + 32),
      embedded = await ai.embed(batch.map((entry) => entry.text));
    if (embedded.length !== batch.length)
      throw new AppError(
        502,
        "AI_FAILED",
        "AI returned an invalid search index.",
      );
    for (let i = 0; i < batch.length; i++) {
      const { doc, fingerprint } = batch[i],
        vector = vectorSchema.parse(embedded[i]);
      vectors.set(doc.id, vector);
      // Skip records edited or deleted while the external call was in flight.
      await db.query(
        `INSERT INTO item_embeddings(owner,item_id,model,fingerprint,vector)
        SELECT owner,id,$3,$4,$5 FROM items WHERE owner=$1 AND id=$2 AND revision=$6
        ON CONFLICT(owner,item_id) DO UPDATE SET model=EXCLUDED.model,fingerprint=EXCLUDED.fingerprint,vector=EXCLUDED.vector`,
        [owner, doc.id, model, fingerprint, vector, doc.revision],
      );
    }
  }
  const [rawQuery] = await ai.embed([query]);
  const queryVector = vectorSchema.parse(rawQuery);
  return documents
    .map((doc) => ({
      id: doc.id,
      revision: doc.revision,
      score: similarity(queryVector, vectors.get(doc.id)!),
    }))
    .filter((entry) => entry.score >= 0.2)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
