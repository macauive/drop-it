import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

type BrowserClient = typeof import("../web/client.js");
type FetchHandler = typeof fetch;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withClient(
  run: (fixture: {
    client: BrowserClient;
    setFetch: (handler: FetchHandler) => void;
    eventCount: () => number;
  }) => Promise<void>,
  embedded = false,
) {
  const descriptors = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
  };
  const fakeWindow = new EventTarget();
  Object.defineProperty(fakeWindow, "parent", {
    value: embedded ? new EventTarget() : fakeWindow,
  });
  let events = 0;
  fakeWindow.addEventListener("dropit:unauthenticated", () => {
    events++;
  });
  let handler: FetchHandler = async () => {
    throw new Error("A browser-auth-state test attempted an unmocked request.");
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: fakeWindow,
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: ((...args) => handler(...args)) satisfies FetchHandler,
  });
  try {
    // Each import represents a new page, with a fresh browser auth lifecycle.
    const path = new URL(
      `../web/client.ts?auth-state=${randomUUID()}`,
      import.meta.url,
    );
    const client = (await import(path.href)) as BrowserClient;
    assert.equal(client.embedded, embedded);
    await run({
      client,
      setFetch: (next) => {
        handler = next;
      },
      eventCount: () => events,
    });
  } finally {
    for (const key of ["window", "fetch"] as const) {
      const descriptor = descriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const denied = (code = "UNAUTHENTICATED") =>
  Response.json({ error: "Synthetic sign-in error", code }, { status: 401 });

test("normal JSON requests retain their data and credentials without ending the browser session", () =>
  withClient(async ({ client, setFetch, eventCount }) => {
    setFetch(async (path, options) => {
      assert.equal(path, "/api/search");
      assert.equal(options?.credentials, "same-origin");
      assert.equal(options?.method, "POST");
      assert.deepEqual(JSON.parse(options?.body as string), {
        query: "fixture",
      });
      return Response.json({ items: [], total: 0 });
    });
    assert.deepEqual(
      await client.api("/api/search", "POST", { query: "fixture" }),
      { items: [], total: 0 },
    );
    assert.equal(eventCount(), 0);

    setFetch(async () =>
      Response.json({ error: "Synthetic temporary failure" }, { status: 503 }),
    );
    await assert.rejects(
      client.api("/api/settings"),
      /Synthetic temporary failure/,
    );
    assert.equal(eventCount(), 0);
  }));

test("a protected JSON401 signals session loss while preserving the caller's typed error", () =>
  withClient(async ({ client, setFetch, eventCount }) => {
    setFetch(async () => denied());
    await assert.rejects(client.api("/api/security"), (error: unknown) => {
      assert.ok(error instanceof client.ClientError);
      assert.equal(error.code, "UNAUTHENTICATED");
      return true;
    });
    assert.equal(eventCount(), 1);
  }));

test("code-less HTTP errors preserve bounded public guidance and reject malformed payloads", () =>
  withClient(async ({ client, setFetch, eventCount }) => {
    for (const [status, message] of [
      [403, "Request origin was not accepted."],
      [413, "The upload is too large."],
      [400, "Invalid request body."],
    ] as const) {
      setFetch(async () => Response.json({ error: message }, { status }));
      await assert.rejects(client.api("/api/settings"), (error: unknown) => {
        assert.ok(error instanceof client.ClientError);
        assert.equal(error.message, message);
        assert.equal(error.code, undefined);
        return true;
      });
    }
    for (const payload of [
      { error: { message: "Malformed nested error" } },
      { error: "x".repeat(1001) },
      { error: "Untrusted internal error", private: "must not leak" },
    ]) {
      setFetch(async () => Response.json(payload, { status: 500 }));
      await assert.rejects(client.api("/api/settings"), (error: unknown) => {
        assert.ok(error instanceof client.ClientError);
        assert.equal(error.message, "The action could not be completed. Try again.");
        assert.equal(error.details, undefined);
        return true;
      });
    }
    assert.equal(eventCount(), 0);
  }));

test("file uploads use the same session-loss lifecycle and preserve their upload error", () =>
  withClient(async ({ client, setFetch, eventCount }) => {
    const file = new File(["Synthetic upload"], "fixture notes.txt", {
      type: "text/plain",
    });
    setFetch(async (path, options) => {
      assert.equal(path, "/api/attachments");
      assert.equal(options?.method, "POST");
      assert.equal(options?.credentials, "same-origin");
      assert.equal(options?.body, file);
      assert.equal(
        new Headers(options?.headers).get("X-File-Name"),
        "fixture%20notes.txt",
      );
      return denied();
    });
    await assert.rejects(client.client.upload(file), /Synthetic sign-in error/);
    assert.equal(eventCount(), 1);
  }));

test("export requests signal session loss without consuming the response body", () =>
  withClient(async ({ client, setFetch, eventCount }) => {
    const response = denied();
    setFetch(async (path, options) => {
      assert.equal(path, "/api/export");
      assert.equal(options?.credentials, "same-origin");
      return response;
    });
    const returned = await client.browserRequest("/api/export", {
      credentials: "omit",
    });
    assert.equal(returned, response);
    assert.equal(returned.bodyUsed, false);
    assert.equal((await returned.json()).code, "UNAUTHENTICATED");
    assert.equal(eventCount(), 1);
  }));

test("wrong credentials stay inline and public authentication failures never clear the page", () =>
  withClient(async ({ client, setFetch, eventCount }) => {
    for (const code of ["LOGIN_FAILED", "RECOVERY_FAILED"]) {
      setFetch(async () => denied(code));
      await assert.rejects(client.api("/api/change-password", "POST", {}), {
        code,
      });
      assert.equal(eventCount(), 0);
    }
    for (const path of ["/api/login", "/api/setup", "/api/recover"]) {
      setFetch(async () => denied());
      await assert.rejects(client.api(path, "POST", {}));
      assert.equal(eventCount(), 0);
    }
    setFetch(async () => denied());
    await assert.rejects(client.api("/api/settings"));
    assert.equal(eventCount(), 1);
  }));

test("malformed401 bodies still signal session loss and remain readable by the caller", () =>
  withClient(async ({ client, setFetch, eventCount }) => {
    const response = new Response("Synthetic proxy error: invalid JSON", {
      status: 401,
    });
    setFetch(async () => response);
    const returned = await client.browserRequest("/api/export");
    assert.equal(eventCount(), 1);
    assert.equal(await returned.text(), "Synthetic proxy error: invalid JSON");
  }));

test("concurrent protected401 responses emit one session-loss event", () =>
  withClient(async ({ client, setFetch, eventCount }) => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    setFetch((path) =>
      path === "/api/settings" ? first.promise : second.promise,
    );
    const requests = [
      client.browserRequest("/api/settings"),
      client.browserRequest("/api/export"),
    ];
    first.resolve(denied());
    second.resolve(denied());
    const responses = await Promise.all(requests);
    assert.deepEqual(
      responses.map((response) => response.status),
      [401, 401],
    );
    assert.equal(eventCount(), 1);
  }));

test("a protected401 arriving after successful login cannot clear the new browser session", () =>
  withClient(async ({ client, setFetch, eventCount }) => {
    const previous = deferred<Response>();
    setFetch((path) =>
      path === "/api/settings"
        ? previous.promise
        : Promise.resolve(Response.json({ ok: true })),
    );
    const oldRequest = client.browserRequest("/api/settings");
    await client.api("/api/login", "POST", {
      password: "Synthetic test password",
    });
    previous.resolve(denied());
    assert.equal((await oldRequest).status, 401);
    assert.equal(eventCount(), 0);

    setFetch(async () => denied());
    await client.browserRequest("/api/settings");
    assert.equal(eventCount(), 1);
  }));

test("a protected401 whose cloned body finishes after login cannot clear the new session", () =>
  withClient(async ({ client, setFetch, eventCount }) => {
    const parsing = deferred<void>();
    const finish = deferred<void>();
    const response = denied();
    const clone = response.clone.bind(response);
    response.clone = () => {
      const copy = clone();
      const json = copy.json.bind(copy);
      copy.json = async () => {
        parsing.resolve();
        await finish.promise;
        return json();
      };
      return copy;
    };
    setFetch(async (path) =>
      path === "/api/settings" ? response : Response.json({ ok: true }),
    );
    const oldRequest = client.browserRequest("/api/settings");
    await parsing.promise;
    await client.api("/api/login", "POST", {
      password: "Synthetic test password",
    });
    finish.resolve();
    assert.equal((await oldRequest).status, 401);
    assert.equal(eventCount(), 0);
    assert.equal((await response.json()).code, "UNAUTHENTICATED");
  }));

test("embedded requests never dispatch standalone browser-session events", () =>
  withClient(async ({ client, setFetch, eventCount }) => {
    setFetch(async () => denied());
    await assert.rejects(client.api("/api/security"), {
      code: "UNAUTHENTICATED",
    });
    assert.equal((await client.browserRequest("/api/export")).status, 401);
    assert.equal(eventCount(), 0);
  }, true));
