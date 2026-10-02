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
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 5,
      connectionTimeoutMillis: 5000,
      query_timeout: 15000,
      statement_timeout: 15000,
      lock_timeout: 5000,
      idle_in_transaction_session_timeout: 15000,
    });
    // Idle connections emit outside any request promise. Do not log connection
    // strings or provider errors, and let the pool replace failed clients.
    pool.on("error", () =>
      console.error("Database connection interrupted", {
        code: "DATABASE_CONNECTION_ERROR",
      }),
    );
    return {
      query: async <T>(sql: string, params?: unknown[]) => ({
        rows: (await pool.query(sql, params)).rows as T[],
      }),
      transaction: async (fn) => {
        const client = await pool.connect();
        let connectionError: Error | undefined;
        // A checked-out client has no pool error listener. In particular an
        // idle transaction can be terminated while its callback awaits I/O.
        const interrupted = (error: Error) => {
          connectionError = error;
          console.error("Database connection interrupted", {
            code: "DATABASE_CONNECTION_ERROR",
          });
        };
        client.on("error", interrupted);
        try {
          await client.query("BEGIN");
          const value = await fn({
            query: async <T>(sql: string, params?: unknown[]) => {
              if (connectionError) throw connectionError;
              return { rows: (await client.query(sql, params)).rows as T[] };
            },
          });
          if (connectionError) throw connectionError;
          await client.query("COMMIT");
          return value;
        } catch (error) {
          if (!connectionError) {
            try {
              await client.query("ROLLBACK");
            } catch (rollbackError) {
              // Discard an unusable client without replacing the original
              // failure with a second error from a failed rollback.
              connectionError =
                rollbackError instanceof Error
                  ? rollbackError
                  : new Error("Database rollback failed");
            }
          }
          throw error;
        } finally {
          // release restores the pool's error listener before ours is removed.
          client.release(connectionError);
          client.removeListener("error", interrupted);
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
  await db.transaction(async (tx) => {
    if (
      (await tx.query("SELECT version FROM schema_migrations WHERE version=5"))
        .rows.length
    )
      return;
    await tx.query("ALTER TABLE items DROP CONSTRAINT items_status_check");
    await tx.query(
      "UPDATE items SET status='Archived',revision=revision+1,updated_at=now() WHERE status='Dismissed'",
    );
    await tx.query(
      "ALTER TABLE items ADD CONSTRAINT items_status_check CHECK(status IN ('Saved','In progress','Done','Archived'))",
    );
    await tx.query("INSERT INTO schema_migrations(version) VALUES(5)");
  });
  await db.transaction(async (tx) => {
    if (
      (await tx.query("SELECT version FROM schema_migrations WHERE version=6"))
        .rows.length
    )
      return;
    await tx.query(
      "ALTER TABLE items ADD COLUMN is_saved boolean NOT NULL DEFAULT false, ADD COLUMN trashed_at timestamptz",
    );
    await tx.query(
      "UPDATE items SET trashed_at=now(),revision=revision+1,updated_at=now() WHERE status='Archived'",
    );
    await tx.query("ALTER TABLE items DROP COLUMN status");
    await tx.query(
      "CREATE INDEX items_trash_expiry ON items(trashed_at) WHERE trashed_at IS NOT NULL",
    );
    await tx.query("INSERT INTO schema_migrations(version) VALUES(6)");
  });
  await db.transaction(async (tx) => {
    if (
      (await tx.query("SELECT version FROM schema_migrations WHERE version=7"))
        .rows.length
    )
      return;
    await tx.query(`ALTER TABLE users
      ADD COLUMN auth_version integer NOT NULL DEFAULT 0 CHECK(auth_version >= 0),
      ADD COLUMN recovery_hash text,
      ADD COLUMN recovery_created_at timestamptz,
      ADD CONSTRAINT users_recovery_state CHECK(
        (recovery_hash IS NULL AND recovery_created_at IS NULL) OR
        (recovery_hash IS NOT NULL AND recovery_hash ~ '^[a-f0-9]{64}$' AND recovery_created_at IS NOT NULL)
      )`);
    await tx.query(`ALTER TABLE sessions
      ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
      ADD COLUMN label text NOT NULL DEFAULT 'Existing browser session',
      ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now(),
      ADD CONSTRAINT sessions_public_id_unique UNIQUE(id),
      ADD CONSTRAINT sessions_label_length CHECK(char_length(label) BETWEEN 1 AND 80)`);
    // Existing sessions have a seven-day lifetime; retain their tokens and
    // derive an approximate creation time without inventing device history.
    await tx.query(`UPDATE sessions SET
      created_at=LEAST(now(),expires_at-interval '7 days'),
      last_seen_at=LEAST(now(),expires_at-interval '7 days')`);
    await tx.query(
      "CREATE INDEX sessions_owner_seen ON sessions(owner,last_seen_at DESC)",
    );
    await tx.query("INSERT INTO schema_migrations(version) VALUES(7)");
  });
  await db.transaction(async (tx) => {
    if (
      (await tx.query("SELECT version FROM schema_migrations WHERE version=8"))
        .rows.length
    )
      return;
    // Retain the original singleton owner and all ownership UUIDs. New accounts
    // use NULL for singleton; PostgreSQL's unique constraint permits multiple NULLs.
    await tx.query(`ALTER TABLE users ADD COLUMN username text UNIQUE,
      ADD CONSTRAINT users_username_format CHECK(username IS NULL OR
        (username ~ '^[a-z0-9][a-z0-9_-]{2,39}$' AND username <> 'owner'))`);
    await tx.query(
      "CREATE UNIQUE INDEX users_recovery_hash_unique ON users(recovery_hash) WHERE recovery_hash IS NOT NULL",
    );
    await tx.query("INSERT INTO schema_migrations(version) VALUES(8)");
  });
  await db.transaction(async (tx) => {
    if (
      (await tx.query("SELECT version FROM schema_migrations WHERE version=9"))
        .rows.length
    )
      return;
    await tx.query(
      "ALTER TABLE users ADD COLUMN ai_search_enabled boolean NOT NULL DEFAULT false",
    );
    await tx.query(
      "ALTER TABLE sources ADD COLUMN normalized_url text NOT NULL DEFAULT ''",
    );
    await tx.query("UPDATE sources SET normalized_url=split_part(url,'#',1)");
    await tx.query(
      "CREATE INDEX sources_owner_normalized_url ON sources(owner,normalized_url) WHERE normalized_url<>''",
    );
    await tx.query(
      "CREATE INDEX sources_owner_attachment ON sources(owner,attachment_id)",
    );
    await tx.query("CREATE INDEX items_owner_source ON items(owner,source_id)");
    await tx.query(`ALTER TABLE items ADD COLUMN reviewed_transcription text,
      ADD COLUMN transcription_updated_at timestamptz,
      ADD CONSTRAINT reviewed_transcription_length CHECK(char_length(reviewed_transcription)<=50000),
      ADD CONSTRAINT reviewed_transcription_state CHECK((reviewed_transcription IS NULL) = (transcription_updated_at IS NULL))`);
    await tx.query(
      "CREATE TABLE capacity_lock (id integer PRIMARY KEY CHECK(id=1))",
    );
    await tx.query("INSERT INTO capacity_lock(id) VALUES(1)");
    await tx.query(`CREATE TABLE portability_imports (
      owner uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, request_id uuid NOT NULL,
      archive_digest text NOT NULL, item_count integer NOT NULL CHECK(item_count>=0),
      source_count integer NOT NULL CHECK(source_count>=0), file_count integer NOT NULL CHECK(file_count>=0),
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,request_id))`);
    await tx.query("INSERT INTO schema_migrations(version) VALUES(9)");
  });
}
