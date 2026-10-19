import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  resendEmailSender,
  EmailDeliveryError,
} from "../server/email-delivery.js";
const config = () => ({
  secret: randomBytes(32).toString("hex"),
  from: "sender@example.test",
  apiKey: "re_" + randomBytes(24).toString("hex"),
  deliveryKey: randomBytes(32).toString("hex"),
});
const delivery = () => ({
  id: randomUUID(),
  from: "sender@example.test",
  subject: "Synthetic subject",
  text: "Synthetic body",
});

test("Resend uses a fixed HTTPS endpoint, stable idempotency and refuses redirects", async () => {
  const settings = config(),
    meta = delivery(),
    providerId = randomUUID();
  const requests: RequestInit[] = [];
  const send = resendEmailSender(settings, async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    requests.push(options!);
    return Response.json({ id: providerId });
  });
  assert.equal(
    await send("recipient@example.test", "", "password-changed", meta),
    providerId,
  );
  await send("recipient@example.test", "", "password-changed", meta);
  assert.equal(requests[0].redirect, "error");
  assert.equal(requests[0].body, requests[1].body);
  const headers = new Headers(requests[0].headers);
  assert.equal(headers.get("authorization"), `Bearer ${settings.apiKey}`);
  assert.equal(headers.get("idempotency-key"), `drop-it/${meta.id}`);
  assert.deepEqual(JSON.parse(String(requests[0].body)), {
    from: "Drop It <sender@example.test>",
    to: ["recipient@example.test"],
    subject: meta.subject,
    text: meta.text,
  });
  for (const secret of [settings.apiKey, settings.deliveryKey, settings.secret])
    assert.equal(String(requests[0].body).includes(secret), false);
});

test("Resend retries network, throttling and concurrent-key failures but stops permanent rejections", async () => {
  for (const [status, name, retryable] of [
    [429, "rate_limit_exceeded", true],
    [500, "application_error", true],
    [503, "service_unavailable", true],
    [409, "concurrent_idempotent_requests", true],
    [409, "invalid_idempotent_request", false],
    [400, "validation_error", false],
    [401, "validation_error", false],
    [403, "restricted_api_key", false],
    [422, "validation_error", false],
  ] as const) {
    const send = resendEmailSender(config(), async () =>
      Response.json(
        { name, message: "Synthetic secret provider details" },
        { status, headers: { "retry-after": "120" } },
      ),
    );
    await assert.rejects(
      send("recipient@example.test", "000000", "reset", delivery()),
      (e: unknown) => {
        assert.ok(e instanceof EmailDeliveryError);
        assert.equal(e.retryable, retryable);
        assert.equal(e.retryAfterSeconds, 120);
        assert.doesNotMatch(String(e), /secret provider/);
        return true;
      },
    );
  }
  for (const transport of [
    async () => {
      throw new Error("Private network details");
    },
    async () => Response.json({ id: "invalid" }),
    async () => new Response("x".repeat(9000)),
  ]) {
    const send = resendEmailSender(config(), transport);
    await assert.rejects(
      send("recipient@example.test", "000000", "reset", delivery()),
      (e: unknown) => e instanceof EmailDeliveryError && e.retryable,
    );
  }
});

test("Resend aborts a stalled request within fifteen seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal;
  const send = resendEmailSender(config(), async (_url, options) => {
    signal = options!.signal!;
    return new Promise<Response>((_resolve, reject) =>
      signal.addEventListener("abort", () =>
        reject(new Error("Private timeout details")),
      ),
    );
  });
  const pending = send("recipient@example.test", "000000", "reset", delivery());
  const rejected = assert.rejects(
    pending,
    (e: unknown) => e instanceof EmailDeliveryError && e.retryable,
  );
  t.mock.timers.tick(15000);
  await rejected;
  assert.equal(signal!.aborted, true);
});
