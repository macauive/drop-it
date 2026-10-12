import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { Config, EmailAuthConfig } from "./config.js";
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
export type EmailPurpose = Purpose | "password-changed";
export type EmailSender = (
  email: string,
  code: string,
  purpose: EmailPurpose,
) => Promise<void>;
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

type MailTransport = Pick<
  ReturnType<typeof nodemailer.createTransport>,
  "sendMail" | "close"
>;
export function smtpEmailSender(
  config: EmailAuthConfig,
  createTransport: (
    options: SMTPTransport.Options,
  ) => MailTransport = nodemailer.createTransport,
): EmailSender {
  return async (email, code, purpose) => {
    const transport = createTransport({
      // Match Amountly's fixed Proton transport; request data never chooses a host.
      host: "smtp.protonmail.ch",
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
      auth: { user: config.username, pass: config.password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transport.sendMail({
          from: { name: "Drop It", address: config.from },
          to: { address: email, name: "" },
          subject:
            purpose === "password-changed"
              ? "Your Drop It password was changed"
              : purpose === "reset"
                ? "Reset your Drop It password"
                : "Verify your Drop It email",
          text:
            purpose === "password-changed"
              ? "Your Drop It password was changed. All browser sessions and connected apps have been signed out. If you did not make this change, open Drop It and reset your password or contact support immediately. This email contains no password or recovery code."
              : `Your Drop It ${purpose === "reset" ? "password reset" : "email verification"} code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
        }),
        new Promise<never>((_, reject) => {
          // Bound the entire submission, including greeting/TLS/auth, so shutdown
          // can drain mail within the server's twenty-second budget.
          deadline = setTimeout(() => {
            transport.close();
            reject(new Error("Authentication email timed out."));
          }, 15000);
          deadline.unref();
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      transport.close();
    }
  };
}

export class EmailAuth {
  private deliveries = new Set<Promise<void>>();
  private closing = false;
  constructor(
    readonly db: Database,
    readonly auth: Auth,
    readonly config: Config,
    readonly send?: EmailSender,
  ) {}
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
  private dispatch(
    email: string,
    code: string,
    purpose: EmailPurpose,
    challengeHash?: string,
  ) {
    const delivery = Promise.resolve()
      .then(() => this.send!(email, code, purpose))
      .catch(async () => {
        console.error("Authentication email delivery failed", {
          code: "EMAIL_DELIVERY_FAILED",
        });
        // Notification failure never changes an already-committed password.
        if (challengeHash)
          await this.db.query("DELETE FROM email_challenges WHERE hash=$1", [
            challengeHash,
          ]);
      })
      .catch(() => {
        console.error("Authentication email cleanup failed", {
          code: "EMAIL_CLEANUP_FAILED",
        });
      });
    this.deliveries.add(delivery);
    void delivery.finally(() => this.deliveries.delete(delivery));
  }
  notifyPasswordChanged(email: string) {
    if (!this.enabled || this.closing) return;
    this.dispatch(emailSchema.parse(email), "", "password-changed");
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
    const deliver = await this.db.transaction(async (tx) => {
      // Limits survive restarts and apply across requesting IPs. All valid
      // addresses consume the same budget, including nonexistent accounts.
      if (!(await this.limit(tx, this.mac(`email:${email}`), 5, true)))
        return false;
      if (
        !(await this.limit(tx, "service", 100, false)) ||
        this.deliveries.size >= 4
      )
        return false;
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
        `INSERT INTO email_challenges(hash,email,purpose,owner,auth_version,password_hash,code_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(email,purpose) DO UPDATE SET
        hash=EXCLUDED.hash,owner=EXCLUDED.owner,auth_version=EXCLUDED.auth_version,
        password_hash=EXCLUDED.password_hash,code_hash=EXCLUDED.code_hash,attempts=0,expires_at=now()+interval '10 minutes'`,
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
      return true;
    });
    if (deliver) {
      // Deliver outside the response and transaction: SMTP timing/failures must
      // not reveal whether an email exists. No emails or codes enter logs.
      this.dispatch(email, code, purpose, hash);
    }
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
    let changedEmail: string | undefined;
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
        changedEmail = row.email;
      }
      await tx.query("DELETE FROM email_challenges WHERE hash=$1", [hash]);
      return true;
    });
    // Throw outside the transaction so failed attempt counters are committed.
    if (!ok) throw rejected();
    if (changedEmail) this.notifyPasswordChanged(changedEmail);
    return { ok: true };
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.deliveries]);
  }
}
