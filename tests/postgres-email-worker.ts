// Process-kill fixture. Its sole connection must target the parent's private
// synthetic cluster; never accepts a hosted database or loads environment files.
import { z } from "zod";
import { openDatabase } from "../server/db.js";
import { Auth } from "../server/auth.js";
import { EmailAuth } from "../server/email-auth.js";
process.once("message", async (raw) => {
  try {
    const input = z
      .object({
        root: z.string().min(1),
        databaseUrl: z.string().url(),
        secret: z.string().min(32),
        password: z.string().min(15),
      })
      .strict()
      .parse(raw);
    const url = new URL(input.databaseUrl);
    if (
      url.hostname !== "localhost" ||
      url.username !== "synthetic_auth_app" ||
      url.port !== "55437" ||
      url.searchParams.get("host") !== input.root + "/socket" ||
      !input.root.includes("drop-it-pg-auth-")
    )
      throw new Error("Unsafe fixture connection");
    const db = await openDatabase({
      dataDir: input.root,
      databaseUrl: input.databaseUrl,
    });
    const config = {
      port: 4317,
      origin: "http://127.0.0.1:4317",
      local: true,
      production: false,
      dataDir: input.root,
      databaseUrl: input.databaseUrl,
      ai: undefined,
      redirectUris: [],
      publicAccounts: true,
      signupEnabled: true,
      emailAuth: {
        secret: input.secret,
        from: "sender@example.test",
        username: input.secret,
        password: input.secret,
      },
    };
    let code = "";
    const auth = new Auth(db, config),
      emails = new EmailAuth(db, auth, config, async (_email, value) => {
        code = value;
        await new Promise(() => {});
      });
    const result = await emails.request(
      "signup",
      "crash@example.test",
      input.password,
    );
    process.send?.({ requestId: result.requestId, code });
    setInterval(() => {}, 1000);
  } catch {
    process.send?.({ error: "Synthetic crash fixture failed" });
    process.exitCode = 1;
  }
});
