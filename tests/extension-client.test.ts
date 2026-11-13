import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";

// These modules ship as plain browser JavaScript, without a Node or Chrome SDK
// dependency. Exercise the actual shipped modules through the Chrome API seam.
const { makeCapture, savePayload } = await import(
  new URL("../extension/capture.js", import.meta.url).href
);
const { createController } = await import(
  new URL("../extension/controller.js", import.meta.url).href
);
const { createOAuth } = await import(
  new URL("../extension/oauth.js", import.meta.url).href
);
const origin = "https://drop-it.example";
const redirect = `https://${"a".repeat(32)}.chromiumapp.org/drop-it`;
const keys = ["title", "url", "text", "summary", "category", "tags", "notes"];
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function fixture() {
  const store: Record<string, unknown> = {};
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const windows: unknown[] = [],
    tabs: unknown[] = [],
    tabQueries: unknown[] = [];
  let hideTabMetadata = false;
  let account = { id: randomUUID(), label: "@synthetic" };
  let activeTab = {
    id: 7,
    title: "Example page",
    url: "https://example.org/article#reading",
  };
  let connectionFailure = 0,
    revokeFailure = false;
  let authorize: URL,
    canceled = false,
    wrongState = false,
    selection = "";
  let captureHandler = async (_init: RequestInit) => {
    void _init;
    return response(
      { id: randomUUID(), title: "Saved capture", replayed: false },
      201,
    );
  };
  const tokens = () => ({
    access_token: randomBytes(32).toString("base64url"),
    refresh_token: randomBytes(32).toString("base64url"),
    token_type: "Bearer",
    expires_in: 3600,
    scope: "capture:write",
  });
  const api = {
    storage: {
      session: {
        async get(input: string | string[]) {
          return structuredClone(
            Object.fromEntries(
              (typeof input === "string" ? [input] : input).map((key) => [
                key,
                store[key],
              ]),
            ),
          );
        },
        async set(input: Record<string, unknown>) {
          Object.assign(store, structuredClone(input));
        },
        async remove(input: string) {
          delete store[input];
        },
      },
    },
    identity: {
      getRedirectURL: () => redirect,
      async launchWebAuthFlow(options: { url: string }) {
        authorize = new URL(options.url);
        if (canceled) throw new Error("Synthetic cancellation");
        const result = new URL(redirect);
        result.searchParams.set("code", randomBytes(32).toString("base64url"));
        result.searchParams.set(
          "state",
          wrongState
            ? randomBytes(32).toString("base64url")
            : authorize.searchParams.get("state")!,
        );
        return result.href;
      },
    },
    tabs: {
      async get(id: number) {
        if (id !== activeTab.id) throw new Error("Tab closed");
        return hideTabMetadata ? { id: activeTab.id } : activeTab;
      },
      async query(options: unknown) {
        tabQueries.push(options);
        return [hideTabMetadata ? { id: activeTab.id } : activeTab];
      },
      async create(value: unknown) {
        tabs.push(value);
      },
    },
    commands: {
      async getAll() {
        return [{ name: "_execute_action", shortcut: "Command+Shift+Y" }];
      },
    },
    scripting: {
      async executeScript() {
        return [
          {
            result: {
              url: activeTab.url,
              title: activeTab.title,
              selectionText: selection,
            },
          },
        ];
      },
    },
    runtime: {
      getURL(path: string) {
        return `chrome-extension://${"a".repeat(32)}/${path}`;
      },
    },
    windows: {
      async create(value: unknown) {
        windows.push(value);
        return { id: 1 };
      },
    },
  };
  const transport = async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).origin, origin);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    const path = new URL(url).pathname;
    calls.push({ path, init });
    if (path === "/register") {
      const registration = JSON.parse(String(init.body));
      assert.deepEqual(registration.redirect_uris, [redirect]);
      assert.equal(registration.scope, "capture:write");
      return response({ client_id: randomUUID() }, 201);
    }
    if (path === "/token") {
      const params = new URLSearchParams(String(init.body));
      assert.equal(params.get("resource"), `${origin}/mcp`);
      if (params.get("grant_type") === "authorization_code") {
        assert.equal(params.get("redirect_uri"), redirect);
        assert.equal(
          createHash("sha256")
            .update(params.get("code_verifier")!)
            .digest("base64url"),
          authorize.searchParams.get("code_challenge"),
        );
      }
      return response(tokens());
    }
    if (path === "/extension/v1/connection")
      return connectionFailure
        ? response({ code: "UNAUTHENTICATED" }, connectionFailure)
        : response({ connected: true, account });
    if (path === "/extension/v1/suggestions")
      return response({
        accountId: account.id,
        pools: ["Reading"],
        tags: ["ideas"],
      });
    if (path === "/extension/v1/capture") return captureHandler(init);
    if (path === "/revoke") {
      if (revokeFailure) throw new Error("Synthetic offline revocation");
      return response({});
    }
    throw new Error("Unexpected destination");
  };
  const controller = createController(api, origin, transport);
  return {
    api,
    calls,
    store,
    windows,
    tabs,
    tabQueries,
    controller,
    transport,
    account() {
      return account;
    },
    connectionFailure(status: number) {
      connectionFailure = status;
    },
    failRevoke() {
      revokeFailure = true;
    },
    switchAccount() {
      account = { id: randomUUID(), label: "@another" };
    },
    tab(value: typeof activeTab) {
      activeTab = value;
    },
    selection(value: string) {
      selection = value;
    },
    hideTabMetadata() {
      hideTabMetadata = true;
    },
    cancel() {
      canceled = true;
    },
    wrongState() {
      wrongState = true;
    },
    setCapture(handler: typeof captureHandler) {
      captureHandler = handler;
    },
    values(draft: Record<string, unknown>) {
      return Object.fromEntries(keys.map((key) => [key, draft[key]]));
    },
    expire() {
      (store.connection as { expiresAt: number }).expiresAt = 0;
    },
  };
}

test("page, selection and link capture preserve source URLs and never silently truncate text", () => {
  const tab = {
    id: 1,
    title: "A page",
    url: "https://example.org/page#section",
  };
  const page = makeCapture({}, tab);
  assert.equal(page.kind, "page");
  assert.equal(page.url, tab.url);
  assert.equal(page.text, "");
  const selected = makeCapture(
    {
      menuItemId: "drop-selection",
      selectionText: "<script>untrusted text</script>",
      frameUrl: "https://example.org/frame#one",
    },
    tab,
  );
  assert.equal(selected.text, "<script>untrusted text</script>");
  assert.equal(selected.url, "https://example.org/frame#one");
  const link = makeCapture(
    {
      menuItemId: "drop-link",
      linkUrl: "https://target.example.org/idea#two",
      selectionText: "irrelevant",
    },
    tab,
  );
  assert.equal(link.kind, "link");
  assert.equal(link.title, "target.example.org");
  assert.equal(link.text, "");
  for (const url of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "chrome://settings",
    "https://user:pass@example.org/",
  ])
    assert.throws(() => makeCapture({}, { ...tab, url }));
  assert.throws(
    () => makeCapture({ selectionText: "x".repeat(50001) }, tab),
    /50,000/,
  );
});

test("restricted or unavailable source pages do not block connecting Drop It", async () => {
  const f = fixture();
  f.tab({ id: 7, title: "Extensions", url: "chrome://extensions/" });
  await assert.rejects(f.controller.handle({ type: "capture" }), {
    code: "UNSUPPORTED_PAGE",
  });
  assert.equal(
    (await f.controller.handle({ type: "connect" })).connected,
    true,
  );
  assert.throws(() => makeCapture({}, { id: 7 }), { code: "UNSUPPORTED_PAGE" });
  f.tab({ id: 7, title: "A website", url: "https://example.org/" });
  assert.equal(
    (await f.controller.handle({ type: "capture" })).title,
    "A website",
  );
});
test("capture validation constrains URLs, pool names, tag count and unexpected fields", () => {
  const f = fixture();
  const draft = makeCapture(
    {},
    { url: "https://example.org/", title: "Example" },
  );
  const values = f.values(draft);
  assert.equal(savePayload(draft, values).category, "Uncategorized");
  for (const changes of [
    { owner: randomUUID() },
    { title: "" },
    { category: "<script>" },
    { url: "javascript:alert(1)" },
    { tags: Array.from({ length: 13 }, (_, index) => `tag${index}`).join(",") },
  ])
    assert.throws(() => savePayload(draft, { ...values, ...changes }));
});
test("OAuth uses state and PKCE, requests only capture scope, keeps credentials in session, and revokes on disconnect", async () => {
  const f = fixture();
  assert.equal(
    (await f.controller.handle({ type: "status" })).connected,
    false,
  );
  const connected = await f.controller.handle({ type: "connect" });
  assert.equal(connected.connected, true);
  assert.deepEqual(connected.account, f.account());
  assert.equal(JSON.stringify(connected).includes("access"), false);
  assert.ok(f.store.connection);
  assert.equal((await f.controller.handle({ type: "status" })).connected, true);
  f.expire();
  assert.equal((await f.controller.handle({ type: "status" })).connected, true);
  assert.equal(f.calls.filter((call) => call.path === "/token").length, 2);
  await f.controller.handle({ type: "disconnect" });
  assert.equal(f.store.connection, undefined);
  assert.equal(f.calls.at(-1)!.path, "/revoke");
});
test("canceled sign-in and mismatched state never exchange a code or save tokens", async () => {
  for (const problem of ["cancel", "wrongState"] as const) {
    const f = fixture();
    f[problem]();
    await assert.rejects(f.controller.handle({ type: "connect" }));
    assert.equal(f.store.connection, undefined);
    assert.equal(f.calls.filter((call) => call.path === "/token").length, 0);
  }
});
test("simultaneous access refreshes only once; uncertain refresh failure requires reconnect without token replay", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  f.expire();
  const oauth = createOAuth(f.api, origin, f.transport);
  const [first, second] = await Promise.all([oauth.access(), oauth.access()]);
  assert.equal(first, second);
  assert.equal(f.calls.filter((call) => call.path === "/token").length, 2);
  f.expire();
  let attempts = 0;
  const broken = createOAuth(f.api, origin, async () => {
    attempts++;
    throw new Error("Synthetic network failure");
  });
  await assert.rejects(broken.access(), /Reconnect/);
  await assert.rejects(broken.access(), /Connect/);
  assert.equal(attempts, 1);
  assert.equal(f.store.connection, undefined);
});
test("toolbar captures selected text and preserves draft edits across popup reopen", async () => {
  const f = fixture();
  f.selection("Selected text from the page");
  const draft = await f.controller.handle({ type: "capture" });
  assert.equal(draft.kind, "selection");
  await f.controller.handle({
    type: "update",
    id: draft.id,
    values: { ...f.values(draft), title: "", notes: "Work in progress" },
  });
  const reopened = await f.controller.handle({ type: "capture" });
  assert.equal(reopened.id, draft.id);
  assert.equal(reopened.title, "");
  assert.equal(reopened.notes, "Work in progress");
  await f.controller.context(
    { menuItemId: "drop-link", linkUrl: "https://target.example.org/" },
    { url: "https://example.org/", title: "Parent" },
  );
  assert.match(JSON.stringify(f.tabs), /popup.html\?draft=/);
  assert.equal(f.windows.length, 0);
});
test("missing tab metadata is recovered from the invoked page and draft edits survive reopening", async () => {
  const f = fixture();
  f.hideTabMetadata();
  f.selection("Selected text with café 🧠");
  const draft = await f.controller.handle({ type: "capture" });
  assert.deepEqual(f.tabQueries[0], { active: true, lastFocusedWindow: true });
  assert.equal(draft.url, "https://example.org/article#reading");
  assert.equal(draft.title, "Selected text with café 🧠");
  assert.equal(draft.text, "Selected text with café 🧠");
  const edited = {
    ...f.values(draft),
    title: "Chrome draft recovery",
    notes: "Keep these edits",
  };
  await f.controller.handle({ type: "update", id: draft.id, values: edited });
  const reopened = await f.controller.handle({ type: "capture" });
  assert.equal(reopened.id, draft.id);
  assert.equal(reopened.title, edited.title);
  assert.equal(reopened.notes, edited.notes);
  f.selection("");
  const fresh = await f.controller.handle({
    type: "capture",
    fresh: true,
    tabId: 7,
  });
  assert.notEqual(fresh.id, draft.id);
  assert.equal(fresh.title, "Example page");
  assert.equal(fresh.url, draft.url);
  assert.equal(fresh.text, "");
  assert.equal(fresh.notes, "");
});
test("reopening restores a stored draft before requesting page access that is no longer available", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  const draft = await f.controller.handle({ type: "capture" });
  const edited = {
    ...f.values(draft),
    title: "Chrome draft recovery",
    notes: "Preserve these edits",
  };
  await f.controller.handle({ type: "update", id: draft.id, values: edited });
  f.hideTabMetadata();
  let injections = 0;
  f.api.scripting.executeScript = async () => {
    injections++;
    throw new Error("Page access expired");
  };
  const reopened = await f.controller.handle({ type: "capture" });
  assert.equal(reopened.id, draft.id);
  assert.equal(reopened.title, edited.title);
  assert.equal(reopened.notes, edited.notes);
  assert.equal(reopened.url, draft.url);
  assert.equal(injections, 0);
});
test("right-click review opens a tab without creating windows and saves the exact selected text or link", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  for (const [info, expectedText, expectedUrl] of [
    [
      {
        menuItemId: "drop-selection",
        selectionText: "Selected café 🧠",
        frameUrl: "https://example.org/frame",
      },
      "Selected café 🧠",
      "https://example.org/frame",
    ],
    [
      {
        menuItemId: "drop-link",
        linkUrl: "https://target.example.org/article",
        selectionText: "Not the link content",
      },
      "",
      "https://target.example.org/article",
    ],
  ] as const) {
    await f.controller.context(info, {
      id: 7,
      url: "https://example.org/parent",
    });
    const opened = f.tabs.at(-1) as { url: string; active: boolean };
    assert.equal(opened.active, true);
    const url = new URL(opened.url);
    assert.equal(url.protocol, "chrome-extension:");
    assert.equal(url.pathname, "/popup.html");
    assert.equal(url.searchParams.get("review"), "1");
    assert.equal(url.searchParams.get("tab"), "7");
    const draft = await f.controller.handle({
      type: "draft",
      id: url.searchParams.get("draft"),
    });
    assert.equal(draft.text, expectedText);
    assert.equal(draft.url, expectedUrl);
    f.setCapture(async (init) => {
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.source.originalText, expectedText);
      assert.equal(payload.source.url, expectedUrl);
      assert.equal(payload.accountId, f.account().id);
      return response(
        { id: randomUUID(), title: draft.title, replayed: false },
        201,
      );
    });
    await f.controller.handle({
      type: "save",
      id: draft.id,
      values: f.values(draft),
    });
  }
  assert.equal(f.windows.length, 0);
});
test("missing tab metadata and denied injection open a manual draft that cannot save without a source link", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  f.hideTabMetadata();
  f.api.scripting.executeScript = async () => {
    throw new Error("Denied");
  };
  const draft = await f.controller.handle({ type: "capture" });
  assert.equal(draft.manual, true);
  assert.equal(draft.url, "");
  await assert.rejects(
    f.controller.handle({
      type: "save",
      id: draft.id,
      values: { ...f.values(draft), title: "Manual idea" },
    }),
    /source link/,
  );
  assert.equal(
    f.calls.filter((call) => call.path === "/extension/v1/capture").length,
    0,
  );
  const known = fixture();
  known.api.scripting.executeScript = async () => {
    throw new Error("Denied");
  };
  assert.equal(
    (await known.controller.handle({ type: "capture" })).url,
    "https://example.org/article#reading",
  );
});
test("manual drafts preserve entered links and notes without crossing tabs or accounts", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  f.hideTabMetadata();
  f.api.scripting.executeScript = async () => {
    throw new Error("Denied");
  };
  const draft = await f.controller.handle({ type: "capture" });
  const edited = {
    ...f.values(draft),
    title: "Manual idea",
    url: "https://example.org/typed",
    notes: "Keep these notes",
  };
  await f.controller.handle({ type: "update", id: draft.id, values: edited });
  const reopened = await f.controller.handle({ type: "capture" });
  assert.equal(reopened.id, draft.id);
  assert.equal(reopened.url, edited.url);
  assert.equal(reopened.notes, edited.notes);
  f.tab({ id: 8, title: "Other tab", url: "https://example.org/other" });
  const other = await f.controller.handle({ type: "capture" });
  assert.notEqual(other.id, draft.id);
  assert.equal(other.title, "");
  assert.equal(other.url, "");
  assert.equal(other.notes, "");
  f.switchAccount();
  await f.controller.handle({ type: "status" });
  await assert.rejects(f.controller.handle({ type: "draft", id: draft.id }));
});
test("reopening without page access preserves a frozen retry rather than replacing it", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  const draft = await f.controller.handle({ type: "capture" });
  f.setCapture(async () => {
    throw new Error("Lost response");
  });
  await assert.rejects(
    f.controller.handle({
      type: "save",
      id: draft.id,
      values: f.values(draft),
    }),
  );
  const pending = await f.controller.handle({ type: "draft", id: draft.id });
  f.hideTabMetadata();
  f.api.scripting.executeScript = async () => {
    throw new Error("Denied");
  };
  const reopened = await f.controller.handle({ type: "capture" });
  assert.equal(reopened.id, draft.id);
  assert.deepEqual(reopened.attempt, pending.attempt);
});
test("injected metadata rejects unsafe addresses and oversized selections", async () => {
  for (const url of [
    "file:///private",
    "chrome://settings/",
    "javascript:alert(1)",
    "https://name:secret@example.org/",
  ]) {
    const f = fixture();
    f.hideTabMetadata();
    f.tab({ id: 7, title: "Untrusted metadata", url });
    await assert.rejects(f.controller.handle({ type: "capture" }));
    assert.deepEqual(f.store.captures, {});
  }
  const f = fixture();
  f.hideTabMetadata();
  f.selection("a".repeat(50001));
  await assert.rejects(f.controller.handle({ type: "capture" }), /50,000/);
});
test("navigation between tab lookup and injection does not restore a different page's draft", async () => {
  const f = fixture();
  const old = await f.controller.handle({ type: "capture" });
  f.api.scripting.executeScript = async () => [
    {
      result: {
        url: "https://example.org/new-page",
        title: "New page",
        selectionText: "",
      },
    },
  ];
  const next = await f.controller.handle({ type: "capture" });
  assert.notEqual(next.id, old.id);
  assert.equal(next.url, "https://example.org/new-page");
  assert.equal(next.title, "New page");
});
test("a blocked review preserves the draft and account ownership", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  f.api.tabs.create = async () => {
    throw new Error("Tab blocked");
  };
  await assert.rejects(
    f.controller.context(
      { menuItemId: "drop-link", linkUrl: "https://target.example.org/" },
      { id: 7, url: "https://example.org/" },
    ),
  );
  const captures = f.store.captures as Record<
    string,
    { id: string; accountId: string }
  >;
  const draft = Object.values(captures)[0]!;
  assert.equal(draft.accountId, f.account().id);
  await f.api.storage.session.set({
    connectionNotice: "Review could not open.",
  });
  assert.equal(
    (await f.controller.handle({ type: "status" })).notice,
    "Review could not open.",
  );
  assert.equal((await f.controller.handle({ type: "status" })).notice, "");
  assert.equal(
    (await f.controller.handle({ type: "draft", id: draft.id })).url,
    "https://target.example.org/",
  );
  f.switchAccount();
  await f.controller.handle({ type: "status" });
  await assert.rejects(
    f.controller.handle({ type: "draft", id: draft.id }),
    /capture/i,
  );
});
test("lost save responses freeze the exact request; worker restart and retry confirm the same saved drop", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  const draft = await f.controller.handle({ type: "capture" });
  const id = randomUUID();
  const payloads: string[] = [];
  f.setCapture(async (init) => {
    payloads.push(String(init.body));
    if (payloads.length === 1) throw new Error("Response lost after save");
    return response({ id, title: "Saved once", replayed: true });
  });
  await assert.rejects(
    f.controller.handle({
      type: "save",
      id: draft.id,
      values: f.values(draft),
    }),
    /reach Drop It/,
  );
  const pending = await f.controller.handle({ type: "draft", id: draft.id });
  assert.ok(pending.attempt);
  const restarted = createController(f.api, origin, f.transport);
  const result = await restarted.handle({
    type: "save",
    id: draft.id,
    values: { ...f.values(draft), title: "Changed after uncertainty" },
  });
  assert.equal(result.saved.id, id);
  assert.equal(payloads[0], payloads[1]);
  await restarted.handle({
    type: "save",
    id: draft.id,
    values: f.values(draft),
  });
  assert.equal(payloads.length, 2);
});
test("duplicate warning allows an explicit override and never follows arbitrary server URLs", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  const draft = await f.controller.handle({ type: "capture" });
  const existing = randomUUID();
  f.setCapture(async (init) =>
    JSON.parse(String(init.body)).allowDuplicate
      ? response({ id: randomUUID(), title: "Another drop" }, 201)
      : response(
          {
            code: "DUPLICATE",
            items: [{ id: existing, title: "Existing drop" }],
          },
          409,
        ),
  );
  await assert.rejects(
    f.controller.handle({
      type: "save",
      id: draft.id,
      values: f.values(draft),
    }),
    { code: "DUPLICATE" },
  );
  assert.equal(
    (await f.controller.handle({ type: "draft", id: draft.id })).attempt,
    undefined,
  );
  const saved = await f.controller.handle({
    type: "save",
    id: draft.id,
    values: f.values(draft),
    allowDuplicate: true,
  });
  assert.ok(saved.saved.id);
  await f.controller.handle({ type: "library", id: existing });
  assert.deepEqual(f.tabs.at(-1), { url: `${origin}/?drop=${existing}` });
  await assert.rejects(
    f.controller.handle({
      type: "library",
      id: "https://example.org/redirect",
    }),
  );
});

test("background bridge accepts only its own popup and registers user-invoked capture menus", async () => {
  const f = fixture();
  const menuItems: Array<Record<string, unknown>> = [];
  let installed: () => void;
  let clicked: (info: unknown, tab: unknown) => void;
  let listener: (
    message: unknown,
    sender: unknown,
    respond: (data: unknown) => void,
  ) => boolean;
  const id = "a".repeat(32);
  const popup = `chrome-extension://${id}/popup.html`;
  const global = globalThis as typeof globalThis & { chrome?: unknown };
  const previous = global.chrome;
  global.chrome = {
    ...f.api,
    storage: {
      session: {
        ...f.api.storage.session,
        async setAccessLevel(input: unknown) {
          assert.deepEqual(input, { accessLevel: "TRUSTED_CONTEXTS" });
        },
      },
    },
    runtime: {
      ...f.api.runtime,
      id,
      onInstalled: {
        addListener(value: typeof installed) {
          installed = value;
        },
      },
      onMessage: {
        addListener(value: typeof listener) {
          listener = value;
        },
      },
    },
    contextMenus: {
      async removeAll() {},
      create(value: Record<string, unknown>) {
        menuItems.push(value);
      },
      onClicked: {
        addListener(value: typeof clicked) {
          clicked = value;
        },
      },
    },
  };
  try {
    await import(new URL("../extension/background.js", import.meta.url).href);
    installed!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(menuItems.length, 3);
    assert.deepEqual(
      menuItems.find((item) => item.id === "drop-link")!.targetUrlPatterns,
      ["https://*/*", "http://*/*"],
    );
    for (const sender of [
      { id, url: "https://example.org/" },
      { id: "b".repeat(32), url: popup },
      { id, url: popup.replace("popup.html", "other.html") },
    ])
      assert.equal(
        listener!({ type: "status" }, sender, () =>
          assert.fail("Untrusted sender received a response"),
        ),
        false,
      );
    const result = await new Promise((resolve) =>
      assert.equal(
        listener!(
          { type: "status" },
          { id, url: popup + "?draft=test" },
          resolve,
        ),
        true,
      ),
    );
    assert.deepEqual(result, {
      ok: true,
      data: {
        connected: false,
        state: "disconnected",
        account: null,
        notice: "",
      },
    });
    for (const info of [
      {
        menuItemId: "drop-selection",
        selectionText: "Selected from native menu",
        pageUrl: "https://example.org/",
      },
      { menuItemId: "drop-link", linkUrl: "https://target.example.org/" },
    ]) {
      clicked!(info, { id: 7, url: "https://example.org/" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const opened = f.tabs.at(-1) as { url: string };
      assert.ok(
        opened,
        "The registered click listener must open a fallback tab",
      );
      const draftId = new URL(opened.url).searchParams.get("draft");
      const data = await new Promise<{
        ok: boolean;
        data: { text: string; url: string };
      }>((resolve) => {
        listener!(
          { type: "draft", id: draftId },
          { id, url: opened.url },
          resolve as (data: unknown) => void,
        );
      });
      assert.equal(data.ok, true);
      assert.equal(data.data.text, info.selectionText || "");
      assert.equal(data.data.url, info.linkUrl || "https://example.org/");
    }
  } finally {
    global.chrome = previous;
  }
});

test("account switching clears pending captures, confirmations and suggestions; stale windows cannot save to B", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  const accountA = f.account().id;
  const draft = await f.controller.handle({ type: "capture" });
  await f.controller.handle({ type: "suggestions" });
  f.setCapture(async () => {
    throw new Error("Response lost after saving to A");
  });
  await assert.rejects(
    f.controller.handle({
      type: "save",
      id: draft.id,
      values: f.values(draft),
    }),
  );
  assert.equal(
    (await f.controller.handle({ type: "draft", id: draft.id })).attempt
      .accountId,
    accountA,
  );
  const before = f.calls.filter((call) =>
    call.path.endsWith("/capture"),
  ).length;
  f.switchAccount();
  const status = await f.controller.handle({ type: "connect" });
  assert.match(status.notice, /Account changed/);
  assert.equal(f.store.suggestions, null);
  await assert.rejects(f.controller.handle({ type: "draft", id: draft.id }), {
    code: "CAPTURE_UNAVAILABLE",
  });
  await assert.rejects(
    f.controller.handle({
      type: "save",
      id: draft.id,
      values: f.values(draft),
    }),
  );
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/capture")).length,
    before,
  );
  assert.equal(
    (await f.controller.handle({ type: "suggestions" })).accountId,
    f.account().id,
  );
});

test("expired authentication preserves bound drafts and frozen retries through same-account reconnect", async () => {
  const f = fixture();
  const initial = await f.controller.handle({ type: "capture" });
  assert.equal(initial.accountId, null);
  await f.controller.handle({ type: "connect" });
  let draft = await f.controller.handle({ type: "draft", id: initial.id });
  assert.equal(draft.accountId, f.account().id);
  f.setCapture(async () => response({ code: "UNAVAILABLE" }, 503));
  await assert.rejects(
    f.controller.handle({
      type: "save",
      id: draft.id,
      values: f.values(draft),
    }),
  );
  draft = await f.controller.handle({ type: "draft", id: draft.id });
  const attempt = draft.attempt;
  f.connectionFailure(401);
  const expired = await f.controller.handle({ type: "status" });
  assert.equal(expired.state, "expired");
  assert.equal(expired.connected, false);
  assert.equal(f.store.connection, undefined);
  assert.deepEqual(
    (await f.controller.handle({ type: "draft", id: draft.id })).attempt,
    attempt,
  );
  f.connectionFailure(0);
  await f.controller.handle({ type: "connect" });
  assert.deepEqual(
    (await f.controller.handle({ type: "draft", id: draft.id })).attempt,
    attempt,
  );
});

test("explicit disconnect clears local account data even when server revocation is offline", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  const draft = await f.controller.handle({ type: "capture" });
  await f.controller.handle({ type: "suggestions" });
  f.failRevoke();
  await assert.rejects(
    f.controller.handle({ type: "disconnect" }),
    /confirm server revocation/,
  );
  assert.equal(f.store.connection, undefined);
  assert.equal(f.store.activeAccount, null);
  assert.equal(f.store.suggestions, null);
  await assert.rejects(f.controller.handle({ type: "draft", id: draft.id }));
  const status = await f.controller.handle({ type: "status" });
  assert.equal(status.state, "disconnected");
});

test("concurrent captures stay separate by tab and rapid double saves make one capture request", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  const a = await f.controller.handle({ type: "capture" });
  f.tab({ id: 8, title: "Another tab", url: a.pageUrl });
  const b = await f.controller.handle({ type: "capture" });
  assert.notEqual(a.id, b.id);
  await Promise.all([
    f.controller.handle({
      type: "update",
      id: a.id,
      values: { ...f.values(a), notes: "First window" },
    }),
    f.controller.handle({
      type: "update",
      id: b.id,
      values: { ...f.values(b), notes: "Second window" },
    }),
  ]);
  assert.equal(
    (await f.controller.handle({ type: "draft", id: a.id })).notes,
    "First window",
  );
  assert.equal(
    (await f.controller.handle({ type: "draft", id: b.id })).notes,
    "Second window",
  );
  const [one, two] = await Promise.all(
    [1, 2].map(() =>
      f.controller.handle({ type: "save", id: a.id, values: f.values(a) }),
    ),
  );
  assert.equal(one.saved.id, two.saved.id);
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/capture")).length,
    1,
  );
});

test("discard and fresh capture remove sticky selections without changing another review", async () => {
  const f = fixture();
  f.selection("First passage");
  const first = await f.controller.handle({ type: "capture" });
  f.selection("Second passage");
  const second = await f.controller.handle({
    type: "capture",
    fresh: true,
    tabId: first.tabId,
  });
  assert.notEqual(first.id, second.id);
  assert.equal(second.text, "Second passage");
  await f.controller.handle({ type: "discard", id: first.id });
  await assert.rejects(f.controller.handle({ type: "draft", id: first.id }));
  assert.equal(
    (await f.controller.handle({ type: "draft", id: second.id })).text,
    "Second passage",
  );
  await assert.rejects(f.controller.handle({ type: "capture", tabId: -1 }));
  await assert.rejects(
    f.controller.handle({ type: "capture", tabId: 99 }),
    /tab closed/,
  );
});

test("expired drafts, capture limits and legacy unbound retries fail closed", async () => {
  const f = fixture();
  const first = await f.controller.handle({ type: "capture" });
  const captures = f.store.captures as Record<string, { createdAt: number }>;
  captures[first.id].createdAt = Date.now() - 3600001;
  await assert.rejects(
    f.controller.handle({ type: "draft", id: first.id }),
    /expired/,
  );
  for (let index = 0; index < 14; index++)
    await f.controller.handle({ type: "capture", fresh: true });
  assert.equal(Object.keys(f.store.captures as object).length, 12);
  delete f.store.captureStateVersion;
  const restarted = createController(f.api, origin, f.transport);
  await restarted.handle({ type: "status" });
  assert.deepEqual(f.store.captures, {});
});

test("offline status preserves local edits; suggestions cache follows the account and expires", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  const draft = await f.controller.handle({ type: "capture" });
  await f.controller.handle({
    type: "update",
    id: draft.id,
    values: { ...f.values(draft), notes: "Keep these notes" },
  });
  await f.controller.handle({ type: "suggestions" });
  await f.controller.handle({ type: "suggestions" });
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/suggestions")).length,
    1,
  );
  (f.store.suggestions as { at: number }).at = Date.now() - 61000;
  await f.controller.handle({ type: "suggestions" });
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/suggestions")).length,
    2,
  );
  f.connectionFailure(503);
  assert.equal(
    (await f.controller.handle({ type: "status" })).state,
    "offline",
  );
  assert.equal(
    (await f.controller.handle({ type: "draft", id: draft.id })).notes,
    "Keep these notes",
  );
  f.connectionFailure(0);
  assert.equal((await f.controller.handle({ type: "status" })).connected, true);
});

test("large Unicode captures retain exact source bytes and expose the registered shortcut", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  const text = "🌱漢字".repeat(12500);
  assert.equal(text.length, 50000);
  f.selection(text);
  const draft = await f.controller.handle({ type: "capture" });
  await f.controller.handle({
    type: "save",
    id: draft.id,
    values: f.values(draft),
  });
  const payload = JSON.parse(
    String(f.calls.find((call) => call.path.endsWith("/capture"))!.init.body),
  );
  assert.equal(payload.source.originalText, text);
  assert.equal(payload.accountId, f.account().id);
  assert.equal(
    (await f.controller.handle({ type: "shortcut" })).shortcut,
    "Command+Shift+Y",
  );
});

test("invalid or unavailable suggestions never poison the cache or prevent manual capture", async () => {
  const f = fixture();
  await f.controller.handle({ type: "connect" });
  const draft = await f.controller.handle({ type: "capture" });
  for (const bad of [
    response({ accountId: randomUUID(), pools: ["Other account"], tags: [] }),
    response({
      accountId: f.account().id,
      pools: Array(101).fill("Reading"),
      tags: [],
    }),
    response({ accountId: f.account().id, pools: [], tags: ["x".repeat(41)] }),
    response({ code: "UNAVAILABLE" }, 503),
  ]) {
    const controller = createController(
      f.api,
      origin,
      (url: string, init: RequestInit) =>
        new URL(url).pathname.endsWith("/suggestions")
          ? Promise.resolve(bad)
          : f.transport(url, init),
    );
    await assert.rejects(controller.handle({ type: "suggestions" }));
    assert.equal(f.store.suggestions, null);
  }
  assert.ok(
    (
      await f.controller.handle({
        type: "save",
        id: draft.id,
        values: {
          ...f.values(draft),
          category: "Typed manually",
          tags: "new-tag",
        },
      })
    ).saved.id,
  );
});
