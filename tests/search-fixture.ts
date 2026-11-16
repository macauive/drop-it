import { randomUUID } from "node:crypto";
import type { Database } from "../server/db.js";
import { dimensions, type AIProvider } from "../server/ai.js";

export const fixtureVector = (topic: number) =>
  Array.from({ length: dimensions }, (_, i) =>
    i === topic ? 1 : Math.sin((i + 1) * (topic + 1) * 1.61803398875) * 0.001,
  );
export function searchProvider(
  observe: (texts: string[]) => void = () => {},
): AIProvider {
  return {
    async draft() {
      throw new Error("Drafting is not part of this synthetic fixture");
    },
    async embed(texts) {
      observe(texts);
      return texts.map((text) =>
        fixtureVector(
          text === "herbs" ? 3 : Number(text.match(/topic-(\d)/)?.[1] ?? 0),
        ),
      );
    },
  };
}
// Deterministic IDs make a match near the end of a 10k library distinguishable
// from a first-page-only implementation. No environment files or live AI.
export async function seedSearchLibrary(db: Database, count = 10000) {
  const owner = randomUUID(),
    other = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,'synthetic-unusable-hash'),($2,NULL,'synthetic-unusable-hash')",
    [owner, other],
  );
  for (let start = 1; start <= count; start += 250) {
    const end = Math.min(count, start + 249);
    await db.query(
      `INSERT INTO sources(id,owner,original_text,url,fingerprint,normalized_url)
      SELECT md5($1||'source'||n)::uuid,$1::uuid,'topic-'||(n%10)||' '||repeat('Synthetic saved research text. ',60),'https://example.com/'||n,md5(n::text),'https://example.com/'||n
      FROM generate_series($2::integer,$3::integer) AS n`,
      [owner, start, end],
    );
    await db.query(
      `INSERT INTO items(id,owner,source_id,title,summary,category,tags,notes,is_saved,created_at)
      SELECT md5($1||'item'||n)::uuid,$1::uuid,md5($1||'source'||n)::uuid,
      CASE WHEN n=$2 THEN 'herbs literal identifier' ELSE 'Record '||n END,'',
      CASE WHEN n%10=3 THEN 'Garden' ELSE 'Research' END,
      CASE WHEN n%100=93 THEN ARRAY['focus'] ELSE ARRAY[]::text[] END,'',n%2=0,
      timestamptz '2026-01-01 00:00:00+00'+n*interval '1 minute'
      FROM generate_series($3::integer,$4::integer) AS n`,
      [owner, count, start, end],
    );
  }
  await db.query(
    "INSERT INTO sources(id,owner,original_text,url,fingerprint) VALUES($1,$2,'topic-3 FOREIGN_PRIVATE_MARKER','','foreign')",
    [randomUUID(), other],
  );
  await db.query(
    `INSERT INTO items(id,owner,source_id,title,summary,category,tags,notes)
    SELECT $1,$2,id,'herbs foreign','','Garden',ARRAY['focus'],'' FROM sources WHERE owner=$2`,
    [randomUUID(), other],
  );
  return { owner, other };
}

export async function seedSearchEmbeddings(
  db: Database,
  owner: string,
  model: string,
  pending = 0,
) {
  let cursor: string | null = null;
  const vectors = JSON.stringify(
    Array.from({ length: 10 }, (_, topic) => ({
      topic,
      a: fixtureVector(topic),
    })),
  );
  for (;;) {
    const { rows }: { rows: { id: string }[] } = await db.query<{ id: string }>(
      `WITH targets AS MATERIALIZED (
        SELECT id FROM items WHERE owner=$1 AND ($4::uuid IS NULL OR id>$4::uuid) ORDER BY id LIMIT 250
      ) INSERT INTO item_embeddings(owner,item_id,model,fingerprint,vector,embedding,indexed_revision)
      SELECT i.owner,i.id,$2,'synthetic-benchmark',v.a,v.a::vector(512),i.revision
      FROM targets t JOIN items i ON i.owner=$1 AND i.id=t.id
      JOIN sources s ON s.owner=i.owner AND s.id=i.source_id
      JOIN jsonb_to_recordset($3::jsonb) AS v(topic integer,a double precision[])
        ON v.topic=substring(s.original_text from 7 for 1)::integer RETURNING item_id AS id`,
      [owner, model, vectors, cursor],
    );
    if (!rows.length) break;
    cursor = rows
      .map((row) => row.id)
      .sort()
      .at(-1)!;
  }
  if (pending)
    await db.query(
      "DELETE FROM item_embeddings WHERE owner=$1 AND item_id IN (SELECT id FROM items WHERE owner=$1 ORDER BY id LIMIT $2)",
      [owner, pending],
    );
  await db.query("ANALYZE items");
  await db.query("ANALYZE sources");
  await db.query("ANALYZE item_embeddings");
}
