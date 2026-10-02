import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chatgptFixture } from "./chatgpt-fixture.js";
import { OpenAIProvider } from "../server/ai.js";
import { AppError } from "../server/errors.js";

const context = { text: "Synthetic text", url: "", categories: [] };

test("ChatGPT linking preserves owner, encrypts credentials, signs in, and funds drafts without site key", async () => {
  const f = await chatgptFixture();
  try {
    const before = await f.library.save(f.owner, {
      requestId: crypto.randomUUID(),
      title: "Keep me",
      category: "Testing",
      source: { originalText: "Original" },
    });
    const start = await f.begin();
    assert.equal(start.url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      start.url.searchParams.get("redirect_uri"),
      f.origin + "/auth/chatgpt/callback",
    );
    const callback = await f.request(
      start.callback,
      "GET",
      undefined,
      `${f.cookie}; ${start.browserCookie}`,
    );
    assert.equal(callback.headers.get("location"), "/?chatgpt=connected");
    const rows = (
      await f.db.query<{ owner: string; credentials: string }>(
        "SELECT * FROM chatgpt_connections",
      )
    ).rows;
    assert.equal(rows[0].owner, f.owner);
    assert.ok(!rows[0].credentials.includes(f.access));
    assert.equal(
      (await f.library.get(f.owner, before.item.id)).item.title,
      "Keep me",
    );
    const signed = await f.begin(false, false, "");
    const login = await f.request(
      signed.callback,
      "GET",
      undefined,
      signed.browserCookie,
    );
    assert.equal(login.headers.get("location"), "/");
    const newSession = login.headers
      .getSetCookie()
      .find((value) => value.startsWith("drop_it_session="))!
      .split(";")[0]
      .split("=")[1];
    assert.equal(await f.auth.sessionOwner(newSession), f.owner);
    await f.library.draft(f.owner, { source: { originalText: "test" } });
    const inference = f.calls.find((call) => call.url.endsWith("/responses"))!;
    assert.ok(!(inference.body instanceof URLSearchParams));
    assert.deepEqual(
      [
        inference.body.model,
        inference.body.stream,
        inference.body.store,
        inference.body.max_output_tokens,
      ],
      ["test-model", true, false, undefined],
    );
    assert.equal(inference.authorization, `Bearer ${f.access}`);
    assert.equal(f.state.siteCalls, 0);
    const settings = await (await f.request("/api/settings")).json();
    assert.equal(settings.chatgpt.planConnected, true);
    assert.ok(!JSON.stringify(settings).includes(f.access));
    assert.equal(
      (await f.request("/api/preferences", "PATCH", { aiSearchEnabled: true }))
        .status,
      400,
    );
  } finally {
    await f.close();
  }
});

for (const variant of ["browser", "state", "expired", "denied", "duplicate"]) {
  test(`OAuth rejects ${variant} callbacks and replay without exchanging a code`, async () => {
    const f = await chatgptFixture();
    try {
      const start = await f.begin();
      const before = f.calls.filter((c) => c.url.endsWith("/token")).length;
      if (variant === "expired")
        await f.db.query(
          "UPDATE chatgpt_pending SET expires_at=now()-interval '1 second'",
        );
      const path =
        variant === "state"
          ? start.callback.replace(
              /state=[^&]+/,
              `state=${randomBytes(32).toString("base64url")}`,
            )
          : variant === "denied"
            ? start.callback + "&error=access_denied"
            : variant === "duplicate"
              ? start.callback + "&state=duplicate"
              : start.callback;
      const result = await f.request(
        path,
        "GET",
        undefined,
        variant === "browser"
          ? f.cookie
          : `${f.cookie}; ${start.browserCookie}`,
      );
      assert.equal(result.headers.get("location"), "/?chatgpt=error");
      assert.equal(
        f.calls.filter((c) => c.url.endsWith("/token")).length,
        before,
      );
      if (variant !== "browser")
        assert.equal(
          (
            await f.request(
              start.callback,
              "GET",
              undefined,
              `${f.cookie}; ${start.browserCookie}`,
            )
          ).headers.get("location"),
          "/?chatgpt=error",
        );
      assert.equal(
        (await f.db.query("SELECT * FROM chatgpt_connections")).rows.length,
        0,
      );
    } finally {
      await f.close();
    }
  });
}

test("OIDC rejects invalid issuer, audience, nonce and cross-account identity claims", async () => {
  const f = await chatgptFixture();
  try {
    for (const claims of [
      { iss: "https://example.com" },
      { aud: "another-client" },
      { nonce: "wrong" },
    ]) {
      const start = await f.begin(true, true, f.cookie, claims);
      assert.equal(
        (
          await f.request(
            start.callback,
            "GET",
            undefined,
            `${f.cookie}; ${start.browserCookie}`,
          )
        ).headers.get("location"),
        "/?chatgpt=error",
      );
    }
    const start = await f.begin();
    await f.request(
      start.callback,
      "GET",
      undefined,
      `${f.cookie}; ${start.browserCookie}`,
    );
    const otherSession = await f.auth.register("synthetic-other", f.password);
    const otherCookie = `drop_it_session=${otherSession}`;
    const conflict = await f.begin(true, true, otherCookie);
    assert.equal(
      (
        await f.request(
          conflict.callback,
          "GET",
          undefined,
          `${otherCookie}; ${conflict.browserCookie}`,
        )
      ).headers.get("location"),
      "/?chatgpt=error",
    );
    assert.equal(
      (
        await f.db.query<{ owner: string }>(
          "SELECT owner FROM chatgpt_connections",
        )
      ).rows[0].owner,
      f.owner,
    );
  } finally {
    await f.close();
  }
});

test("linking requires password, origin and same live session; revoked sessions cannot finish", async () => {
  const f = await chatgptFixture();
  try {
    assert.equal(
      (
        await f.request("/api/chatgpt/start", "POST", {
          link: true,
          currentPassword: "wrong",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await f.request("/api/chatgpt/start", "POST", {}, "", {
          Origin: "https://example.com",
        })
      ).status,
      403,
    );
    const start = await f.begin();
    await f.auth.logout(f.session);
    assert.equal(
      (
        await f.request(
          start.callback,
          "GET",
          undefined,
          `${f.cookie}; ${start.browserCookie}`,
        )
      ).headers.get("location"),
      "/?chatgpt=error",
    );
    assert.equal(
      (await f.db.query("SELECT * FROM chatgpt_connections")).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("missing plan permission cannot enable plan billing or create a link", async () => {
  const f = await chatgptFixture();
  try {
    f.state.tokenScope = "openid email profile";
    const start = await f.begin();
    assert.equal(
      (
        await f.request(
          start.callback,
          "GET",
          undefined,
          `${f.cookie}; ${start.browserCookie}`,
        )
      ).headers.get("location"),
      "/?chatgpt=error",
    );
    await assert.rejects(
      f.library.draft(f.owner, { source: { originalText: "test" } }),
    );
    assert.equal(f.state.siteCalls, 0);
  } finally {
    await f.close();
  }
});

test("refresh rotation is serialized and failed refresh persists disconnected credentials", async () => {
  const f = await chatgptFixture();
  try {
    const start = await f.begin();
    await f.request(
      start.callback,
      "GET",
      undefined,
      `${f.cookie}; ${start.browserCookie}`,
    );
    await f.db.query(
      "UPDATE chatgpt_connections SET expires_at=now()-interval '1 second'",
    );
    const provider = await f.chatgpt.provider(f.owner, f.fallback);
    await Promise.all([provider!.draft(context), provider!.draft(context)]);
    assert.equal(f.state.refreshCalls, 1);
    await f.db.query(
      "UPDATE chatgpt_connections SET expires_at=now()-interval '1 second'",
    );
    f.state.refreshStatus = 400;
    await assert.rejects(provider!.draft(context));
    assert.equal((await f.chatgpt.status(f.owner)).planConnected, false);
    assert.equal(f.state.siteCalls, 0);
  } finally {
    await f.close();
  }
});

test("plan limit, disconnect and disabled configuration never use operator key; remote failures reported", async () => {
  const f = await chatgptFixture();
  try {
    const start = await f.begin();
    await f.request(
      start.callback,
      "GET",
      undefined,
      `${f.cookie}; ${start.browserCookie}`,
    );
    f.state.failure = "subscription_sharing_usage_limit_exceeded";
    await assert.rejects(
      f.library.draft(f.owner, { source: { originalText: "test" } }),
      (error) => error instanceof AppError && error.code === "AI_LIMIT",
    );
    f.state.revokeStatus = 503;
    const disconnected = await f.request("/api/chatgpt/disconnect", "POST", {
      currentPassword: f.password,
    });
    assert.equal((await disconnected.json()).revoked, false);
    f.config.chatgpt = undefined;
    await assert.rejects(
      f.library.draft(f.owner, { source: { originalText: "test" } }),
    );
    assert.equal(f.state.siteCalls, 0);
    assert.equal((await f.chatgpt.status(f.owner)).planRequired, true);
  } finally {
    await f.close();
  }
});

test("identity-only linking doesn't imply plan permission and disabled installations preserve current AI", async () => {
  const f = await chatgptFixture();
  try {
    f.config.chatgpt!.planScopes = "";
    const start = await f.begin(true, false);
    assert.equal(start.url.searchParams.get("scope"), "openid profile email");
    await f.request(
      start.callback,
      "GET",
      undefined,
      `${f.cookie}; ${start.browserCookie}`,
    );
    assert.equal((await f.chatgpt.status(f.owner)).connected, true);
    assert.equal((await f.chatgpt.status(f.owner)).planConnected, false);
    await f.library.draft(f.owner, { source: { originalText: "test" } });
    assert.equal(f.state.siteCalls, 1);
    f.config.chatgpt = undefined;
    assert.equal(
      (
        await f
          .request("/api/session", "GET", undefined, "")
          .then((r) => r.json())
      ).chatgptEnabled ?? false,
      false,
    );
    assert.equal(
      (await f.request("/api/chatgpt/start", "POST", {}, "")).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("password changes remove ChatGPT sign-in grants and pending links", async () => {
  const f = await chatgptFixture();
  try {
    const start = await f.begin();
    await f.request(
      start.callback,
      "GET",
      undefined,
      `${f.cookie}; ${start.browserCookie}`,
    );
    await f.begin();
    await f.auth.changePassword(
      f.owner,
      f.session,
      f.password,
      randomBytes(24).toString("base64url"),
    );
    assert.equal(
      (await f.db.query("SELECT * FROM chatgpt_connections")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM chatgpt_pending")).rows.length,
      0,
    );
    assert.equal((await f.chatgpt.status(f.owner)).planRequired, true);
  } finally {
    await f.close();
  }
});

test("SSE requires completion and handles fragmented Unicode, quota failures and malformed streams", async () => {
  const completed = {
    type: "response.completed",
    response: {
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                title: "Café",
                summary: "",
                category: "Testing",
                tags: [],
                extractedText: "",
                sourceUrl: "",
              }),
            },
          ],
        },
      ],
    },
  };
  for (const [stream, valid] of [
    [`data: ${JSON.stringify(completed)}\r\n\r\n`, true],
    [
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      false,
    ],
    ["data: [DONE]\n\n", false],
    ["data: invalid\n\n", false],
  ] as const) {
    const bytes = new TextEncoder().encode(stream);
    const provider = new OpenAIProvider(
      {
        apiKey: randomBytes(20).toString("hex"),
        model: "synthetic",
        chatgptPlan: true,
      },
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes)
                controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          }),
        ),
    );
    if (valid) assert.equal((await provider.draft(context)).title, "Café");
    else await assert.rejects(provider.draft(context));
  }
});

test("confidential clients send their secret only in Basic auth; successful callbacks cannot replay", async () => {
  const f = await chatgptFixture();
  try {
    f.config.chatgpt!.authMethod = "client_secret_basic";
    f.config.chatgpt!.clientSecret = randomBytes(32).toString("base64url");
    const start = await f.begin();
    assert.ok(!start.url.href.includes(f.config.chatgpt!.clientSecret));
    const callback = await f.request(
      start.callback,
      "GET",
      undefined,
      `${f.cookie}; ${start.browserCookie}`,
    );
    assert.equal(callback.headers.get("location"), "/?chatgpt=connected");
    const exchange = f.calls.find((call) => call.url.endsWith("/token"))!;
    assert.ok(exchange.authorization?.startsWith("Basic "));
    assert.ok(exchange.body instanceof URLSearchParams);
    assert.equal(exchange.body.has("client_secret"), false);
    const before = f.calls.length;
    assert.equal(
      (
        await f.request(
          start.callback,
          "GET",
          undefined,
          `${f.cookie}; ${start.browserCookie}`,
        )
      ).headers.get("location"),
      "/?chatgpt=error",
    );
    assert.equal(f.calls.length, before);
  } finally {
    await f.close();
  }
});

test("transient refresh errors retain credentials; account deletion cascades only that owner's grants", async () => {
  const f = await chatgptFixture();
  try {
    const start = await f.begin();
    await f.request(
      start.callback,
      "GET",
      undefined,
      `${f.cookie}; ${start.browserCookie}`,
    );
    const otherSession = await f.auth.register("other-account", f.password);
    const other = (await f.auth.sessionOwner(otherSession))!;
    await f.db.query(
      "UPDATE chatgpt_connections SET expires_at=now()-interval '1 second'",
    );
    f.state.refreshStatus = 503;
    await assert.rejects(
      f.library.draft(f.owner, { source: { originalText: "test" } }),
    );
    assert.equal((await f.chatgpt.status(f.owner)).planConnected, true);
    assert.equal(f.state.siteCalls, 0);
    await f.begin();
    await f.auth.deleteAccount(f.owner, f.session, f.password);
    assert.equal(
      (await f.db.query("SELECT * FROM chatgpt_connections")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM chatgpt_pending")).rows.length,
      0,
    );
    assert.equal(await f.auth.sessionOwner(otherSession), other);
  } finally {
    await f.close();
  }
});

for (const claims of [{ expired: true }, { invalidSignature: true }]) {
  test(`OIDC rejects ${Object.keys(claims)[0]} identity tokens`, async () => {
    const f = await chatgptFixture();
    try {
      const start = await f.begin(true, true, f.cookie, claims);
      assert.equal(
        (
          await f.request(
            start.callback,
            "GET",
            undefined,
            `${f.cookie}; ${start.browserCookie}`,
          )
        ).headers.get("location"),
        "/?chatgpt=error",
      );
      assert.equal(
        (await f.db.query("SELECT * FROM chatgpt_connections")).rows.length,
        0,
      );
    } finally {
      await f.close();
    }
  });
}
