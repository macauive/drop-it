import { createHash } from "node:crypto";
import type { Options, Store, ClientRateLimitInfo } from "express-rate-limit";
import type { Queryable } from "./db.js";
import { AppError } from "./errors.js";

// One atomic counter per deployment, limiter and database-clock window. Hash
// client identifiers so maintenance data need not retain IPs or owner IDs.
export class DatabaseRateLimitStore implements Store {
  readonly localKeys = false;
  private windowMs = 0;
  private lastErrorAt = -Infinity;

  constructor(
    private readonly db: Queryable,
    readonly prefix: string,
  ) {}

  init(options: Pick<Options, "windowMs">) {
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs <= 0)
      throw new Error("Invalid rate-limit window");
    this.windowMs = options.windowMs;
  }

  private key(key: string) {
    return `${this.prefix}:${createHash("sha256").update(key).digest("hex")}`;
  }

  private async query<T>(sql: string, key: string) {
    if (!this.windowMs) throw new Error("Rate-limit store is not initialized");
    try {
      return await this.db.query<T>(sql, [this.key(key), this.windowMs]);
    } catch {
      // Fail closed: authentication uses this same database. Never advertise
      // an active limiter or expose provider errors/client identifiers on failure.
      if (Date.now() - this.lastErrorAt >= 60000) {
        this.lastErrorAt = Date.now();
        console.error("Rate-limit store unavailable", {
          code: "RATE_LIMIT_UNAVAILABLE",
          limiter: this.prefix,
        });
      }
      throw new AppError(
        503,
        "RATE_LIMIT_UNAVAILABLE",
        "Request protection is temporarily unavailable. Please retry shortly.",
      );
    }
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const { rows } = await this.query<{ hits: number; reset_time: Date }>(
      `INSERT INTO rate_limit_counters(key,window_start,hits)
       VALUES($1,to_timestamp(floor(extract(epoch FROM clock_timestamp())*1000/$2)*$2/1000.0),1)
       ON CONFLICT(key,window_start) DO UPDATE
         SET hits=LEAST(rate_limit_counters.hits::bigint+1,2147483647)::integer
       RETURNING hits,window_start+($2*interval '1 millisecond') AS reset_time`,
      key,
    );
    return { totalHits: rows[0].hits, resetTime: new Date(rows[0].reset_time) };
  }

  async decrement(key: string) {
    await this.query(
      `UPDATE rate_limit_counters SET hits=GREATEST(hits-1,0)
       WHERE key=$1 AND window_start=to_timestamp(floor(extract(epoch FROM clock_timestamp())*1000/$2)*$2/1000.0)`,
      key,
    );
  }

  async resetKey(key: string) {
    await this.query(
      "DELETE FROM rate_limit_counters WHERE key=$1 AND $2::integer>0",
      key,
    );
  }
}
