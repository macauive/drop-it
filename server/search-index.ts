import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { AIProvider } from "./ai.js";
import { AppError } from "./errors.js";
import { indexSearchBatch } from "./semantic.js";
import { searchScopeSchema, type SearchScope } from "./search-scope.js";

type AIGate = <T>(
  owner: string,
  run: (ai: AIProvider) => Promise<T>,
) => Promise<T>;
type Job = { owner: string; scope: unknown; epoch: number; token: string };

export class SearchIndexer {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closing = false;
  constructor(
    private readonly db: Database,
    private readonly withAI: AIGate,
  ) {}

  async enqueue(owner: string, scope: SearchScope, epoch: number) {
    await this.db.query(
      `INSERT INTO search_index_jobs(owner,scope,epoch)
      SELECT id,$2::jsonb,$3 FROM users WHERE id=$1 AND ai_search_enabled=true AND ai_search_epoch=$3
      ON CONFLICT(owner) DO UPDATE SET scope=EXCLUDED.scope,epoch=EXCLUDED.epoch,
        retry_at=CASE WHEN search_index_jobs.scope=EXCLUDED.scope AND search_index_jobs.epoch=EXCLUDED.epoch
          THEN search_index_jobs.retry_at ELSE clock_timestamp() END`,
      [owner, JSON.stringify(scope), epoch],
    );
  }
  start() {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        console.error("Search indexing interrupted", {
          code: "SEARCH_INDEX_ERROR",
        }),
      );
    }, 1000);
    this.timer.unref();
  }
  async tick() {
    if (this.pending || this.closing) return;
    this.pending = this.runOnce();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
  private async runOnce() {
    const token = randomUUID();
    const { rows } = await this.db.query<Job>(
      `WITH next AS (
        SELECT owner FROM search_index_jobs WHERE retry_at<=clock_timestamp()
        AND (locked_until IS NULL OR locked_until<clock_timestamp())
        ORDER BY requested_at,owner LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE search_index_jobs j SET lease_token=$1,locked_until=clock_timestamp()+interval '60 seconds'
      FROM next WHERE j.owner=next.owner RETURNING j.owner,j.scope,j.epoch,j.lease_token AS token`,
      [token],
    );
    const job = rows[0];
    if (!job) return;
    try {
      const scope = searchScopeSchema.parse(job.scope);
      await this.withAI(job.owner, async (ai) => {
        const deadline = Date.now() + 45000;
        for (
          let batch = 0;
          batch < 8 && !this.closing && Date.now() < deadline;
          batch++
        ) {
          const current = await this.db.query(
            `UPDATE search_index_jobs SET locked_until=clock_timestamp()+interval '60 seconds'
            WHERE owner=$1 AND lease_token=$2 AND scope=$3::jsonb AND epoch=$4 RETURNING owner`,
            [job.owner, token, JSON.stringify(scope), job.epoch],
          );
          if (!current.rows.length) return;
          if (
            !(await indexSearchBatch(this.db, ai, job.owner, scope, job.epoch))
          ) {
            await this.db.query(
              "DELETE FROM search_index_jobs WHERE owner=$1 AND lease_token=$2 AND scope=$3::jsonb AND epoch=$4",
              [job.owner, token, JSON.stringify(scope), job.epoch],
            );
            return;
          }
        }
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "AI_DISABLED")
        await this.db.query(
          "DELETE FROM search_index_jobs WHERE owner=$1 AND lease_token=$2 AND epoch=$3",
          [job.owner, token, job.epoch],
        );
      else {
        // Back off on outages/rate limits without recording provider errors or
        // private text. A later tick/restart resumes from persisted embeddings.
        await this.db.query(
          "UPDATE search_index_jobs SET retry_at=clock_timestamp()+interval '60 seconds' WHERE owner=$1 AND lease_token=$2",
          [job.owner, token],
        );
      }
    } finally {
      await this.db.query(
        `UPDATE search_index_jobs SET lease_token=NULL,locked_until=NULL,requested_at=clock_timestamp()
        WHERE owner=$1 AND lease_token=$2`,
        [job.owner, token],
      );
    }
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await this.pending;
  }
}
