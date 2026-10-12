import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { SendMailOptions } from "nodemailer";
import { smtpEmailSender } from "../server/email-auth.js";
const config = () => ({
  secret: randomBytes(32).toString("hex"),
  from: "sender@example.test",
  username: randomBytes(24).toString("hex"),
  password: randomBytes(24).toString("hex"),
});

test("SMTP uses mandatory validated TLS and confirmation mail contains no password or code", async () => {
  const settings = config(),
    messages: SendMailOptions[] = [];
  let options: SMTPTransport.Options | undefined,
    closes = 0;
  const send = smtpEmailSender(settings, (input) => {
    options = input;
    return {
      sendMail: async (message) => {
        messages.push(message);
        return {};
      },
      close: () => {
        closes++;
      },
    };
  });
  const sentinel = randomBytes(24).toString("hex");
  await send("recipient@example.test", sentinel, "password-changed");
  assert.equal(options!.host, "smtp.protonmail.ch");
  assert.equal(options!.requireTLS, true);
  assert.equal(options!.tls!.rejectUnauthorized, true);
  assert.equal(options!.logger, false);
  assert.equal(options!.debug, false);
  assert.equal(options!.disableFileAccess, true);
  assert.equal(options!.disableUrlAccess, true);
  assert.equal(messages[0].subject, "Your Drop It password was changed");
  for (const secret of [sentinel, settings.password, settings.secret])
    assert.equal(JSON.stringify(messages[0]).includes(secret), false);
  assert.match(
    String(messages[0].text),
    /reset your password or contact support/,
  );
  assert.equal(closes, 1);
});

test("a stalled SMTP submission times out before the service shutdown deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closes = 0;
  const send = smtpEmailSender(config(), () => ({
    sendMail: () => new Promise(() => {}),
    close: () => {
      closes++;
    },
  }));
  const pending = send("recipient@example.test", "000000", "reset");
  const rejected = assert.rejects(pending, /email timed out/);
  t.mock.timers.tick(15000);
  await rejected;
  assert.ok(closes > 0);
});
