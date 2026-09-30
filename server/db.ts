import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { mkdir } from "node:fs/promises";
import type { Config } from "./config.js";

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function openDatabase(
  config: Pick<Config, "dataDir"> & Partial<Pick<Config, "databaseUrl">>,
): Promise<Database> {
  if (config.databaseUrl) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
    return {
      query: async <T>(sql: string, params?: unknown[]) => ({
        rows: (await pool.query(sql, params)).rows as T[],
      }),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const value = await fn({
            query: async <T>(sql: string, params?: unknown[]) => ({
              rows: (await client.query(sql, params)).rows as T[],
            }),
          });
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const db = new PGlite(`${config.dataDir}/postgres`);
  await db.waitReady;
  return {
    query: (sql, params) => db.query(sql, params),
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
}

export async function migrate(db: Database) {
  await db.transaction(async (tx) => {
    await tx.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)`,
    );
    const { rows } = await tx.query<{ version: number }>(
      "SELECT version FROM schema_migrations WHERE version = 1",
    );
    if (rows.length) return;
    await tx.query(`CREATE TABLE users (
      id uuid PRIMARY KEY, singleton boolean UNIQUE DEFAULT true CHECK(singleton IS NOT FALSE),
      password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await tx.query(
      `CREATE TABLE sessions (hash text PRIMARY KEY, owner uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL)`,
    );
    await tx.query(`CREATE TABLE attachments (
      id uuid PRIMARY KEY, owner uuid NOT NULL REFERENCES users(id), bytes bytea NOT NULL,
      mime text NOT NULL, digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(owner,id)
    )`);
    await tx.query(`CREATE TABLE sources (
      id uuid PRIMARY KEY, owner uuid NOT NULL REFERENCES users(id), original_text text NOT NULL,
      url text NOT NULL, attachment_id uuid, fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(owner,id), FOREIGN KEY(owner,attachment_id) REFERENCES attachments(owner,id)
    )`);
    await tx.query(`CREATE TABLE items (
      id uuid PRIMARY KEY, owner uuid NOT NULL REFERENCES users(id), source_id uuid NOT NULL,
      title text NOT NULL, summary text NOT NULL, category text NOT NULL CHECK(category IN ('Learn','Build','Try','Buy','Read','Other')),
      status text NOT NULL DEFAULT 'Saved' CHECK(status IN ('Saved','In progress','Done','Dismissed')),
      tags text[] NOT NULL, notes text NOT NULL, revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(owner,source_id) REFERENCES sources(owner,id)
    )`);
    await tx.query(
      `CREATE INDEX items_owner_created ON items(owner,created_at DESC)`,
    );
    await tx.query(
      `CREATE INDEX sources_owner_fingerprint ON sources(owner,fingerprint)`,
    );
    await tx.query(
      `CREATE TABLE save_requests (owner uuid NOT NULL REFERENCES users(id), request_id uuid NOT NULL, fingerprint text NOT NULL, item_id uuid, PRIMARY KEY(owner,request_id))`,
    );
    await tx.query(
      `CREATE TABLE oauth_clients (id text PRIMARY KEY, data jsonb NOT NULL)`,
    );
    await tx.query(
      `CREATE TABLE oauth_pending (id text PRIMARY KEY, client_id text NOT NULL, params jsonb NOT NULL, expires_at timestamptz NOT NULL)`,
    );
    await tx.query(
      `CREATE TABLE oauth_codes (hash text PRIMARY KEY, owner uuid NOT NULL REFERENCES users(id), client_id text NOT NULL, params jsonb NOT NULL, expires_at timestamptz NOT NULL)`,
    );
    await tx.query(
      `CREATE TABLE oauth_tokens (hash text PRIMARY KEY, family uuid NOT NULL, owner uuid NOT NULL REFERENCES users(id), client_id text NOT NULL, kind text NOT NULL, scopes text[] NOT NULL, resource text NOT NULL, expires_at timestamptz NOT NULL)`,
    );
    await tx.query("INSERT INTO schema_migrations(version) VALUES(1)");
  });
  await db.transaction(async (tx) => {
    const { rows } = await tx.query(
      "SELECT version FROM schema_migrations WHERE version=2",
    );
    if (rows.length) return;
    await tx.query("ALTER TABLE items DROP CONSTRAINT items_category_check");
    await tx.query(
      "ALTER TABLE items ADD CONSTRAINT items_category_check CHECK(char_length(category) BETWEEN 1 AND 60 AND category=btrim(category))",
    );
    await tx.query("INSERT INTO schema_migrations(version) VALUES(2)");
  });
  await db.transaction(async (tx) => {
    if (
      (await tx.query("SELECT version FROM schema_migrations WHERE version=3"))
        .rows.length
    )
      return;
    await tx.query(
      "ALTER TABLE items ADD CONSTRAINT items_owner_id_unique UNIQUE(owner,id)",
    );
    await tx.query(`CREATE TABLE item_embeddings (
      owner uuid NOT NULL, item_id uuid NOT NULL, model text NOT NULL,
      fingerprint text NOT NULL, vector double precision[] NOT NULL,
      PRIMARY KEY(owner,item_id), FOREIGN KEY(owner,item_id) REFERENCES items(owner,id) ON DELETE CASCADE
    )`);
    await tx.query("INSERT INTO schema_migrations(version) VALUES(3)");
  });
  await db.transaction(async (tx) => {
    if (
      (await tx.query("SELECT version FROM schema_migrations WHERE version=4"))
        .rows.length
    )
      return;
    await tx.query(
      "ALTER TABLE attachments ADD COLUMN filename text NOT NULL DEFAULT 'source', ADD COLUMN original_text text NOT NULL DEFAULT ''",
    );
    await tx.query(
      "UPDATE attachments SET filename=CASE mime WHEN 'image/png' THEN 'source.png' WHEN 'image/jpeg' THEN 'source.jpg' WHEN 'image/webp' THEN 'source.webp' ELSE 'source' END",
    );
    await tx.query("INSERT INTO schema_migrations(version) VALUES(4)");
  });
}
