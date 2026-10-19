import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Config } from "./config.js";
import {
  EmailDelivery,
  enqueueEmail,
  type EmailSender,
} from "./email-delivery.js";
export type { EmailSender, EmailPurpose } from "./email-delivery.js";
import type { Database, Queryable } from "./db.js";
import { Auth, hashPassword, verifyPassword } from "./auth.js";
import { digest } from "./library.js";
import { AppError } from "./errors.js";
import {
  emailSchema,
  newPasswordSchema,
  emailChallengeSchema,
} from "../shared/schema.js";

type Purpose = "signup" | "link" | "reset";
type Challenge = {
  hash: string;
  email: string;
  purpose: Purpose;
  owner: string | null;
  auth_version: number | null;
  password_hash: string | null;
  code_hash: string;
  attempts: number;
  live: boolean;
};
const rejected = () =>
  new AppError(
    400,
    "EMAIL_CODE_INVALID",
    "The code was not accepted. Request a new code or try again.",
  );

export class EmailAuth {
  readonly delivery?: EmailDelivery;
  private closing = false;
  constructor(
    readonly db: Database,
    readonly auth: Auth,
    readonly config: Config,
    readonly send?: EmailSender,
  ) {
    if (config.emailAuth && send)
      this.delivery = new EmailDelivery(db, config.emailAuth, send);
  }
  get enabled() {
    return Boolean(this.config.emailAuth && this.send);
  }
  private settings() {
    if (!this.enabled || this.closing)
      throw new AppError(
        503,
        "EMAIL_AUTH_UNAVAILABLE",
        "Email verification is not available yet. Try again later.",
      );
    return this.config.emailAuth!;
  }
  private mac(value: string) {
    return createHmac("sha256", this.settings().secret)
      .update(value)
      .digest("hex");
  }
  private async limit(
    tx: Queryable,
    key: string,
    max: number,
    cooldown: boolean,
  ) {
    const { rows } = await tx.query(
      `INSERT INTO email_request_limits(key) VALUES($1)
      ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN email_request_limits.starts_at < now()-interval '1 hour' THEN 1 ELSE email_request_limits.count+1 END,
      starts_at=CASE WHEN email_request_limits.starts_at < now()-interval '1 hour' THEN now() ELSE email_request_limits.starts_at END,
      last_at=now()
      WHERE (email_request_limits.starts_at < now()-interval '1 hour' OR email_request_limits.count < $2)
        AND ($3::boolean=false OR email_request_limits.last_at < now()-interval '1 minute')
      RETURNING key`,
      [key, max, cooldown],
    );
    return rows.length > 0;
  }
  async request(
    purpose: Purpose,
    rawEmail: string,
    password?: string,
    owner?: string,
    session?: string,
  ) {
    this.settings();
    if (
      purpose === "signup" &&
      (!this.config.publicAccounts || !this.config.signupEnabled)
    )
      throw new AppError(
        403,
        "SIGNUP_CLOSED",
        "New accounts are not available yet.",
      );
    const email = emailSchema.parse(rawEmail);
    const passwordHash =
      purpose === "signup"
        ? await hashPassword(newPasswordSchema.parse(password))
        : null;
    const version =
      purpose === "link"
        ? await this.auth.confirmPassword(owner!, session!, password!)
        : null;
    const requestId = randomBytes(32).toString("base64url"),
      hash = digest(requestId);
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const codeHash = this.mac(`${hash}:${code}`);
    await this.db.transaction(async (tx) => {
      // Limits survive restarts and apply across requesting IPs. All valid
      // addresses consume the same budget, including nonexistent accounts.
      if (!(await this.limit(tx, this.mac(`email:${email}`), 5, true)))
        return false;
      if (!(await this.limit(tx, "service", 100, false))) return false;
      let account:
        { id: string; auth_version: number; email: string | null } | undefined;
      if (purpose === "link") {
        account = (
          await tx.query<{
            id: string;
            auth_version: number;
            email: string | null;
          }>("SELECT id,auth_version,email FROM users WHERE id=$1 FOR UPDATE", [
            owner,
          ])
        ).rows[0];
        if (!account || account.auth_version !== version || account.email)
          return false;
        if (
          !(
            await tx.query(
              "SELECT hash FROM sessions WHERE owner=$1 AND hash=$2 AND expires_at>clock_timestamp()",
              [owner, digest(session!)],
            )
          ).rows.length
        )
          return false;
        if (
          (await tx.query("SELECT id FROM users WHERE email=$1", [email])).rows
            .length
        )
          return false;
      } else {
        account = (
          await tx.query<{
            id: string;
            auth_version: number;
            email: string | null;
          }>(
            "SELECT id,auth_version,email FROM users WHERE email=$1 FOR UPDATE",
            [email],
          )
        ).rows[0];
        if (purpose === "signup" ? Boolean(account) : !account) return false;
      }
      await tx.query(
        "DELETE FROM email_challenges WHERE email=$1 AND purpose=$2",
        [email, purpose],
      );
      await tx.query(
        `INSERT INTO email_challenges(hash,email,purpose,owner,auth_version,password_hash,code_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          hash,
          email,
          purpose,
          account?.id ?? null,
          account?.auth_version ?? null,
          passwordHash,
          codeHash,
        ],
      );
      await enqueueEmail(
        tx,
        this.settings(),
        email,
        code,
        purpose,
        account?.id ?? null,
        hash,
      );
    });
    return { ok: true, requestId };
  }
  async verify(
    purpose: Purpose,
    input: { requestId: string; code: string },
    password?: string,
    owner?: string,
    session?: string,
  ) {
    this.settings();
    emailChallengeSchema.parse(input);
    if (
      purpose === "signup" &&
      (!this.config.signupEnabled || !this.config.publicAccounts)
    )
      throw new AppError(
        403,
        "SIGNUP_CLOSED",
        "New accounts are not available yet.",
      );
    const hash = digest(input.requestId);
    const version =
      purpose === "link"
        ? await this.auth.confirmPassword(owner!, session!, password!)
        : null;
    const newHash =
      purpose === "reset"
        ? await hashPassword(newPasswordSchema.parse(password))
        : null;
    const ok = await this.db.transaction(async (tx) => {
      // Owner before challenge is the same lock order as password changes,
      // recovery and account deletion, avoiding deadlocks under rotation.
      const peek = (
        await tx.query<{ owner: string | null }>(
          "SELECT owner FROM email_challenges WHERE hash=$1",
          [hash],
        )
      ).rows[0];
      if (peek?.owner)
        await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
          peek.owner,
        ]);
      const row = (
        await tx.query<Challenge>(
          "SELECT *,expires_at>clock_timestamp() AS live FROM email_challenges WHERE hash=$1 FOR UPDATE",
          [hash],
        )
      ).rows[0];
      if (
        !row ||
        row.purpose !== purpose ||
        !row.live ||
        row.attempts >= 3 ||
        (purpose === "link" && row.owner !== owner)
      )
        return false;
      await tx.query(
        "UPDATE email_challenges SET attempts=attempts+1 WHERE hash=$1",
        [hash],
      );
      // A third attempt exhausts this challenge. Do not later deliver a code
      // that can no longer be used if the worker has not submitted it yet.
      if (row.attempts === 2)
        await tx.query("DELETE FROM email_outbox WHERE challenge_hash=$1", [
          hash,
        ]);
      const actual = Buffer.from(this.mac(`${hash}:${input.code}`), "hex");
      if (!timingSafeEqual(actual, Buffer.from(row.code_hash, "hex")))
        return false;
      if (purpose === "signup") {
        if (
          !(
            await verifyPassword(
              newPasswordSchema.parse(password),
              row.password_hash!,
            )
          ).valid
        )
          return false;
        // Never claim/merge a previously verified account by matching email.
        if (
          !(
            await tx.query(
              `INSERT INTO users(id,singleton,password_hash,email,email_verified_at)
          VALUES($1,NULL,$2,$3,clock_timestamp()) ON CONFLICT(email) DO NOTHING RETURNING id`,
              [randomUUID(), row.password_hash, row.email],
            )
          ).rows.length
        )
          return false;
      } else if (purpose === "link") {
        if (row.auth_version !== version) return false;
        if (
          !(
            await tx.query(
              "SELECT hash FROM sessions WHERE owner=$1 AND hash=$2 AND expires_at>clock_timestamp()",
              [owner, digest(session!)],
            )
          ).rows.length
        )
          return false;
        if (
          (await tx.query("SELECT id FROM users WHERE email=$1", [row.email]))
            .rows.length
        )
          return false;
        // Another signup/link can win this address after the availability
        // read. Recover only the unique conflict, keeping failed attempts.
        await tx.query("SAVEPOINT email_claim");
        try {
          if (
            !(
              await tx.query(
                "UPDATE users SET email=$1,email_verified_at=clock_timestamp() WHERE id=$2 AND email IS NULL AND auth_version=$3 RETURNING id",
                [row.email, owner, version],
              )
            ).rows.length
          )
            return false;
        } catch (error) {
          if ((error as { code?: string }).code !== "23505") throw error;
          await tx.query("ROLLBACK TO SAVEPOINT email_claim");
          return false;
        }
        await tx.query("RELEASE SAVEPOINT email_claim");
      } else {
        if (
          !(await this.auth.completeEmailRecovery(
            tx,
            row.owner!,
            row.auth_version!,
            row.email,
            newHash!,
          ))
        )
          return false;
      }
      await tx.query("DELETE FROM email_challenges WHERE hash=$1", [hash]);
      return true;
    });
    // Throw outside the transaction so failed attempt counters are committed.
    if (!ok) throw rejected();
    return { ok: true };
  }
  async close() {
    this.closing = true;
    await this.delivery?.close();
  }
}
