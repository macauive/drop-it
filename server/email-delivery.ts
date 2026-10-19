import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";
import { z } from "zod";
import type { EmailAuthConfig } from "./config.js";
import type { Database, Queryable } from "./db.js";
import { emailSchema } from "../shared/schema.js";

export type EmailPurpose = "signup" | "link" | "reset" | "password-changed";
const payloadSchema = z
  .object({
    email: emailSchema,
    code: z.string().regex(/^(?:[0-9]{6})?$/),
    purpose: z.enum(["signup", "link", "reset", "password-changed"]),
    from: z
      .string()
      .max(254)
      .email()
      .regex(/^[^\s<>\r\n,;]+@[^\s<>\r\n,;]+$/),
    subject: z.string().min(1).max(100),
    text: z.string().min(1).max(1000),
  })
  .strict()
  .refine((p) =>
    p.purpose === "password-changed" ? p.code === "" : p.code.length === 6,
  );
type Payload = z.infer<typeof payloadSchema>;
export type EmailSender = (
  email: string,
  code: string,
  purpose: EmailPurpose,
  delivery: { id: string; from: string; subject: string; text: string },
) => Promise<string | void>;

export class EmailDeliveryError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly retryAfterSeconds = 0,
  ) {
    super("Email submission failed.");
  }
}

// Bound provider responses and never propagate their text, addresses or credentials.
async function responseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response");
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) throw new Error("Oversized response");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function resendEmailSender(
  config: EmailAuthConfig,
  transport: typeof fetch = fetch,
): EmailSender {
  return async (_email, _code, _purpose, delivery) => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15000);
    deadline.unref();
    try {
      const response = await transport("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `drop-it/${delivery.id}`,
        },
        body: JSON.stringify({
          from: `Drop It <${delivery.from}>`,
          to: [_email],
          subject: delivery.subject,
          text: delivery.text,
        }),
      });
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        let seconds =
          retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
        if (retryAfter && !seconds)
          seconds = Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000);
        let concurrent = false;
        if (response.status === 409) {
          const body = await responseJson(response).catch(() => null);
          concurrent = z
            .object({ name: z.literal("concurrent_idempotent_requests") })
            .safeParse(body).success;
        } else await response.body?.cancel();
        throw new EmailDeliveryError(
          response.status === 429 || response.status >= 500 || concurrent,
          Number.isFinite(seconds) ? Math.max(0, Math.min(3600, seconds)) : 0,
        );
      }
      const body = z
        .object({ id: z.uuid() })
        .strict()
        .parse(await responseJson(response));
      return body.id;
    } catch (error) {
      if (error instanceof EmailDeliveryError) throw error;
      // A timeout or malformed success can follow acceptance. Retry with the same key.
      throw new EmailDeliveryError(true);
    } finally {
      clearTimeout(deadline);
    }
  };
}

export async function enqueueEmail(
  tx: Queryable,
  config: EmailAuthConfig,
  email: string,
  code: string,
  purpose: EmailPurpose,
  owner: string | null,
  challengeHash: string | null = null,
) {
  const id = randomUUID();
  const payload = payloadSchema.parse({
    email,
    code,
    purpose,
    from: config.from,
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
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(config.deliveryKey, "hex"),
    iv,
  );
  cipher.setAAD(Buffer.from(id));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64",
  );
  // A challenge and its job (or a password change and its notification) commit together.
  // The encrypted body is immutable so every retry has exactly the same provider body.
  await tx.query(
    `INSERT INTO email_outbox(id,owner,challenge_hash,payload,expires_at)
    VALUES($1,$2,$3,$4,CASE WHEN $3::text IS NULL THEN now()+interval '23 hours'
      ELSE (SELECT expires_at FROM email_challenges WHERE hash=$3) END)`,
    [id, owner, challengeHash, sealed],
  );
}

type Job = {
  id: string;
  payload: string;
  challenge_hash: string | null;
  attempts: number;
  lease_token: string;
};

export class EmailDelivery {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private closing = false;
  constructor(
    readonly db: Database,
    readonly config: EmailAuthConfig,
    readonly send: EmailSender,
  ) {}
  start() {
    if (this.timer || this.closing) return;
    const tick = () => {
      void this.processPending().catch(() => {
        console.error("Email queue processing failed", {
          code: "EMAIL_QUEUE_FAILED",
        });
      });
    };
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
    tick();
  }
  processPending(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.processBatch().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async processBatch() {
    // Expiration and acceptance erase the encrypted recipient/code immediately.
    await this.db
      .query(`UPDATE email_outbox SET status='failed',payload=NULL,lease_token=NULL,locked_until=NULL,
      failure_code='expired' WHERE status='pending' AND expires_at<=clock_timestamp()`);
    for (let count = 0; count < 4 && !this.closing; count++) {
      const token = randomUUID();
      const job = (
        await this.db.query<Job>(
          `WITH candidate AS (
        SELECT id FROM email_outbox WHERE status='pending' AND next_attempt_at<=clock_timestamp()
          AND (locked_until IS NULL OR locked_until<=clock_timestamp())
          AND expires_at>clock_timestamp()+interval '30 seconds'
        ORDER BY next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE email_outbox o SET lease_token=$1,locked_until=clock_timestamp()+interval '60 seconds',
        attempts=attempts+1 FROM candidate c WHERE o.id=c.id RETURNING o.*`,
          [token],
        )
      ).rows[0];
      if (!job) break;
      if (job.attempts > 20) {
        await this.fail(job, "retry_exhausted");
        continue;
      }
      let payload: Payload;
      try {
        const sealed = Buffer.from(job.payload, "base64");
        if (sealed.length < 29 || sealed.length > 8192)
          throw new Error("Invalid payload");
        const decipher = createDecipheriv(
          "aes-256-gcm",
          Buffer.from(this.config.deliveryKey, "hex"),
          sealed.subarray(0, 12),
        );
        decipher.setAAD(Buffer.from(job.id));
        decipher.setAuthTag(sealed.subarray(12, 28));
        payload = payloadSchema.parse(
          JSON.parse(
            Buffer.concat([
              decipher.update(sealed.subarray(28)),
              decipher.final(),
            ]).toString("utf8"),
          ),
        );
      } catch {
        await this.fail(job, "invalid_payload");
        continue;
      }
      let providerId: string | void;
      try {
        providerId = await this.send(
          payload.email,
          payload.code,
          payload.purpose,
          {
            id: job.id,
            from: payload.from,
            subject: payload.subject,
            text: payload.text,
          },
        );
      } catch (error) {
        const transient =
          !(error instanceof EmailDeliveryError) || error.retryable;
        if (!transient || job.attempts >= 20)
          await this.fail(
            job,
            transient ? "retry_exhausted" : "provider_rejected",
          );
        else {
          const seconds = Math.max(
            Math.min(3600, 5 * 2 ** (job.attempts - 1)) + randomInt(0, 5),
            error instanceof EmailDeliveryError ? error.retryAfterSeconds : 0,
          );
          await this.db.query(
            `UPDATE email_outbox SET next_attempt_at=clock_timestamp()+$3*interval '1 second',
            lease_token=NULL,locked_until=NULL,failure_code='temporary_failure'
            WHERE id=$1 AND lease_token=$2`,
            [job.id, job.lease_token, seconds],
          );
          console.error("Email submission will retry", {
            code: "EMAIL_DELIVERY_RETRY",
            jobId: job.id,
          });
        }
        continue;
      }
      // Keep acknowledgement outside the provider catch: a DB failure after acceptance
      // retains the lease and payload for recovery with the original idempotency key.
      await this.db.query(
        `UPDATE email_outbox SET status='accepted',payload=NULL,provider_id=$3,
        lease_token=NULL,locked_until=NULL,failure_code=NULL WHERE id=$1 AND lease_token=$2`,
        [job.id, job.lease_token, providerId ?? null],
      );
    }
  }
  private async fail(job: Job, reason: string) {
    await this.db.query(
      `UPDATE email_outbox SET status='failed',payload=NULL,lease_token=NULL,
      locked_until=NULL,failure_code=$3 WHERE id=$1 AND lease_token=$2`,
      [job.id, job.lease_token, reason],
    );
    console.error("Email submission failed", {
      code: "EMAIL_DELIVERY_FAILED",
      jobId: job.id,
    });
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await this.running;
  }
}
