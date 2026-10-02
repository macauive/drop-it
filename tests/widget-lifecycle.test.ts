import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ClientError,
  EmbeddedController,
  presentationFromResponse,
  readEmbeddedView,
  rememberEmbeddedView,
  responseError,
  type EmbeddedBridge,
  type ToolResponse,
} from "../web/embedded.js";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";

const id = randomUUID(),
  sourceId = randomUUID(),
  stamp = "2026-10-01T00:00:00.000Z";
const item = {
  id,
  sourceId,
  title: "Synthetic",
  summary: "",
  category: "Projects",
  isSaved: false,
  trashedAt: null,
  deleteAfter: null,
  tags: [],
  notes: "",
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp,
  sourceUrl: "",
  hasImage: true,
};
const source = {
  id: sourceId,
  originalText: "Synthetic screenshot text",
  url: "",
  createdAt: stamp,
  hasImage: true,
  hasFile: true,
  filename: "synthetic.png",
  mime: "image/png",
};
const empty = {
  items: [],
  total: 0,
  counts: { "All drops": 2, Saved: 1, Trash: 0 },
  categories: ["Projects"],
  aiAvailable: true,
  aiSearchEnabled: false,
  mode: "keyword",
};
const searchResult: ToolResponse = {
  structuredContent: empty,
  _meta: {
    dropIt: {
      tool: "search_drops",
      input: {
        query: "no match",
        view: "Saved",
        category: "Projects",
        tag: "synthetic",
        after: stamp,
        limit: 10,
        offset: 10,
      },
    },
  },
};
function fakeHost(result: ToolResponse = searchResult) {
  let closes = 0,
    calls = 0,
    observers = 0;
  const context: McpUiHostContext = {
    theme: "light",
    displayMode: "inline",
    availableDisplayModes: ["inline", "fullscreen"],
  };
  const bridge: EmbeddedBridge = {
    connect: async () => {},
    close: async () => {
      closes++;
    },
    callServerTool: async () => {
      calls++;
      return result as Awaited<ReturnType<EmbeddedBridge["callServerTool"]>>;
    },
    getHostContext: () => context,
    requestDisplayMode: async ({ mode }) => ({ mode }),
    getHostCapabilities: () => ({}),
    downloadFile: async () => ({}),
    openLink: async () => ({}),
    setupSizeChangedNotifications: () => {
      observers++;
      return () => {
        observers--;
      };
    },
    ontoolinput: undefined,
    ontoolresult: undefined,
    ontoolcancelled: undefined,
    onhostcontextchanged: undefined,
    onclose: undefined,
  };
  return { bridge, context, counts: () => ({ closes, calls, observers }) };
}

test("initial empty search remains exact and retains all initiating filters without fetching All drops", () => {
  const state = presentationFromResponse(searchResult);
  assert.equal(state?.kind, "search");
  if (state?.kind !== "search") throw new Error("Expected search");
  assert.deepEqual(state.result.items, []);
  assert.equal(state.result.total, 0);
  assert.deepEqual(state.input, {
    query: "no match",
    view: "Saved",
    category: "Projects",
    tag: "synthetic",
    after: stamp,
    limit: 10,
    offset: 10,
    mode: "hybrid",
  });
});

test("draft hydration preserves unsaved source and proposed fields without saving", () => {
  const draft = {
    title: "Suggested title",
    summary: "Suggestion",
    category: "Projects",
    tags: ["test"],
    extractedText: "OCR suggestion",
    sourceUrl: "",
  };
  const supplied = {
    originalText: "Exact supplied source",
    url: "",
    attachmentId: randomUUID(),
  };
  assert.deepEqual(
    presentationFromResponse({
      structuredContent: { draft },
      _meta: { dropIt: { tool: "draft_drop", input: { source: supplied } } },
    }),
    { kind: "draft", source: supplied, draft },
  );
});

test("initial detail retains hidden original bytes and treats model-visible source as data", () => {
  const imageData = `data:image/png;base64,${Buffer.from("synthetic bytes").toString("base64")}`;
  const state = presentationFromResponse({
    structuredContent: { item, source },
    _meta: {
      dropIt: { tool: "get_drop", input: { id } },
      imageData,
      downloadPageUrl: `https://synthetic.example.test/?drop=${id}`,
    },
  });
  assert.equal(state?.kind, "detail");
  if (state?.kind !== "detail") throw new Error("Expected detail");
  assert.equal(state.detail.imageData, imageData);
  assert.equal(state.detail.source.originalText, source.originalText);
  const invalid = presentationFromResponse({
    structuredContent: { item, source },
    _meta: {
      dropIt: { tool: "get_drop", input: { id } },
      imageData: "data:text/html;base64,PHNjcmlwdD4=",
    },
  });
  assert.equal(
    invalid?.kind === "detail" && invalid.detail.imageData,
    undefined,
  );
});

test("result received during initialization is retained for late subscribers; UI calls do not replay it", async () => {
  const host = fakeHost();
  host.bridge.connect = async () => {
    host.bridge.ontoolresult?.(
      searchResult as Parameters<
        NonNullable<EmbeddedBridge["ontoolresult"]>
      >[0],
    );
  };
  const controller = new EmbeddedController(() => host.bridge);
  await controller.connect();
  const original = controller.getState();
  assert.equal(original.presentation?.kind, "search");
  assert.equal(original.version, 1);
  let updates = 0;
  const unsubscribe = controller.subscribe(() => {
    updates++;
  });
  await controller.call("search_drops", {});
  assert.equal(controller.getState(), original);
  assert.equal(updates, 0);
  assert.equal(host.counts().calls, 1);
  unsubscribe();
  await controller.close();
  assert.equal(updates, 0);
  assert.equal(host.counts().observers, 0);
});

test("connection timeout closes old transport and a real Retry can initialize a new host", async () => {
  const first = fakeHost(),
    second = fakeHost();
  first.bridge.connect = () => new Promise(() => {});
  let attempts = 0;
  const controller = new EmbeddedController(
    () => (++attempts === 1 ? first.bridge : second.bridge),
    undefined,
    10,
  );
  await assert.rejects(controller.connect(), /Retry to reconnect/);
  assert.equal(controller.getState().status, "error");
  assert.equal(first.counts().closes, 1);
  assert.equal(first.bridge.ontoolresult, undefined);
  await controller.connect();
  assert.equal(controller.getState().status, "ready");
  assert.equal(attempts, 2);
  assert.equal(second.counts().observers, 1);
  await controller.close();
  assert.equal(second.counts().observers, 0);
});

for (const failure of [
  "cancelled",
  "tool error",
  "malformed result",
] as const) {
  test(`Retry recovers a connected ${failure} without replaying any tool`, async () => {
    const host = fakeHost();
    let connections = 0;
    host.bridge.connect = async () => {
      connections++;
    };
    const controller = new EmbeddedController(() => host.bridge);
    await controller.connect();
    host.bridge.ontoolresult?.(
      searchResult as Parameters<
        NonNullable<EmbeddedBridge["ontoolresult"]>
      >[0],
    );
    const original = controller.getState().presentation;
    if (failure === "cancelled")
      host.bridge.ontoolcancelled?.({ reason: "Synthetic cancellation" });
    else
      host.bridge.ontoolresult?.(
        (failure === "tool error"
          ? {
              isError: true,
              structuredContent: {
                error: "Synthetic failure",
                code: "TEST_FAILURE",
              },
            }
          : {
              structuredContent: { items: "invalid" },
              _meta: searchResult._meta,
            }) as Parameters<NonNullable<EmbeddedBridge["ontoolresult"]>>[0],
      );
    assert.equal(controller.getState().status, "error");
    assert.notEqual(controller.getState().error, "");

    await controller.connect();
    assert.equal(controller.getState().status, "ready");
    assert.equal(controller.getState().error, "");
    assert.equal(connections, 1);
    assert.deepEqual(host.counts(), { closes: 0, calls: 0, observers: 1 });
    assert.equal(
      controller.getState().presentation,
      failure === "cancelled" ? original : null,
    );

    // Recovery leaves the bridge usable for a later explicit user request.
    await controller.call("search_drops", {});
    assert.equal(host.counts().calls, 1);
    await controller.close();
    assert.equal(host.counts().observers, 0);
  });
}

test("host context changes update theme and fullscreen only when advertised", async () => {
  const host = fakeHost();
  const received: McpUiHostContext[] = [];
  const controller = new EmbeddedController(
    () => host.bridge,
    (context) => received.push(context),
  );
  await controller.connect();
  host.bridge.onhostcontextchanged?.({
    theme: "dark",
    styles: { variables: { "--color-text-primary": "#fff" } },
  } as McpUiHostContext);
  assert.equal(received.at(-1)?.theme, "dark");
  assert.equal(await controller.requestFullscreen(), true);
  assert.equal(controller.getState().displayMode, "fullscreen");
  host.bridge.onhostcontextchanged?.({
    availableDisplayModes: ["inline"],
    displayMode: "inline",
  });
  assert.equal(await controller.requestFullscreen(), false);
  await controller.close();
});

test("safe duplicate details survive for review while arbitrary error fields are rejected", () => {
  const error = responseError({
    isError: true,
    structuredContent: {
      error: "Already saved",
      code: "DUPLICATE",
      items: [{ id, title: "Synthetic duplicate" }],
    },
  });
  assert.ok(error instanceof ClientError);
  assert.deepEqual(error.details, {
    items: [{ id, title: "Synthetic duplicate" }],
  });
  const unsafe = responseError({
    isError: true,
    structuredContent: {
      error: "Internal detail",
      code: "ERROR",
      private: "must not leak",
    },
  });
  assert.equal(unsafe.details, undefined);
  assert.equal(unsafe.message.includes("Internal detail"), false);
});

test("optional widget state persists only the non-sensitive library view", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  let written: unknown;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      openai: {
        widgetState: { dropItView: "Saved" },
        setWidgetState: (state: unknown) => {
          written = state;
        },
      },
    },
  });
  try {
    assert.equal(readEmbeddedView(), "Saved");
    rememberEmbeddedView("Trash");
    assert.deepEqual(written, { dropItView: "Trash" });
    Object.assign(window.openai!, {
      widgetState: { dropItView: "Saved", query: "private query" },
    });
    assert.equal(readEmbeddedView(), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
