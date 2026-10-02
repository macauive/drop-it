import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  mcpOutputSchemas,
  type McpToolName,
} from "../../shared/mcp-results.js";
import type { Detail } from "../../web/embedded.js";

type Result = Parameters<AppBridge["sendToolResult"]>[0];
type Arguments = Record<string, unknown>;
const stamp = "2026-09-20T12:00:00.000Z";
const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const attachmentA = id(401);
const filtered = {
  query: "synthetic",
  mode: "keyword",
  view: "Saved",
  category: "Testing",
  tag: "fixture",
  after: "2026-09-01T12:34:56.789Z",
  before: "2026-10-01T12:34:56.789Z",
  limit: 2,
  offset: 2,
};
const records = new Map<string, Detail>();
const uploads = new Map<
  string,
  { attachmentId: string; originalText: string; name: string }
>();
let iframe: HTMLIFrameElement;
let bridge: AppBridge | undefined;
let initialized = false;
let handshakes = 0;
let holdNext = "";
let nextId = 500;
let retainedState: unknown;
const requests: Array<{ name: string; arguments: Arguments; status: string }> =
  [];
const pending: Array<{
  entry: (typeof requests)[number];
  resolve: (result: Result) => void;
}> = [];
const el = (name: string) => document.getElementById(name)!;
const say = (message: string) => {
  el("status").textContent = message;
  render();
};
function render() {
  const counts: Record<string, number> = {};
  for (const entry of requests)
    counts[entry.name] = (counts[entry.name] ?? 0) + 1;
  el("counts").textContent = JSON.stringify({
    initialized,
    handshakes,
    tools: requests.length,
    counts,
    pending: pending.length,
    delayArmed: holdNext || null,
  });
  el("requests").textContent = JSON.stringify(requests, null, 2);
  el("records").textContent = JSON.stringify(
    { records: [...records.values()], retainedState },
    null,
    2,
  );
}
function seed() {
  records.clear();
  uploads.clear();
  nextId = 500;
  for (let value = 1; value <= 6; value++) {
    const source = {
      id: id(100 + value),
      originalText:
        value === 1
          ? "Immutable synthetic source A."
          : `Synthetic source ${value}`,
      url: "",
      createdAt: stamp,
      hasImage: false,
      hasFile: value === 1,
      filename: value === 1 ? "widget-file-a.txt" : null,
      mime: value === 1 ? ("text/plain" as const) : null,
      ...(value === 1 ? { attachmentId: attachmentA } : {}),
    };
    records.set(id(value), {
      item: {
        id: id(value),
        sourceId: source.id,
        title: `Synthetic filtered drop ${value}`,
        summary: "Synthetic fixture only",
        category: "Testing",
        tags: ["fixture"],
        isSaved: true,
        notes: "",
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp,
        trashedAt: null,
        deleteAfter: null,
        hasImage: false,
        sourceUrl: "",
        reviewedTranscription: null,
        transcriptionUpdatedAt: null,
        transcriptionProvenance: "original",
      },
      source,
    });
  }
}
function errorResult(message: string, code = "SYNTHETIC_FAILURE"): Result {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: message, code },
    isError: true,
  };
}
function result(
  name: McpToolName,
  args: Arguments,
  data: unknown,
  includeBytes = false,
): Result {
  const structuredContent = mcpOutputSchemas[name].parse(data);
  const detail = data as Detail;
  const bytes =
    includeBytes && detail.source?.hasFile
      ? {
          fileData: `data:text/plain;base64,${btoa(detail.source.originalText)}`,
        }
      : {};
  return {
    content: [],
    structuredContent,
    _meta: { dropIt: { tool: name, input: args }, ...bytes },
  };
}
function search(args: Arguments) {
  const query = String(args.query ?? "").toLowerCase();
  const matches = [...records.values()]
    .map((value) => value.item)
    .filter(
      (item) =>
        (!query || item.title.toLowerCase().includes(query)) &&
        (args.view === "Trash" ? Boolean(item.trashedAt) : !item.trashedAt) &&
        (args.view !== "Saved" || item.isSaved) &&
        (!args.category || item.category === args.category) &&
        (!args.tag || item.tags.includes(String(args.tag))),
    );
  const offset = Number(args.offset ?? 0),
    limit = Number(args.limit ?? 30);
  return {
    items: matches.slice(offset, offset + limit),
    total: matches.length,
    counts: {
      "All drops": [...records.values()].filter(
        (value) => !value.item.trashedAt,
      ).length,
      Saved: [...records.values()].filter(
        (value) => value.item.isSaved && !value.item.trashedAt,
      ).length,
      Trash: [...records.values()].filter((value) => value.item.trashedAt)
        .length,
    },
    categories: ["Testing"],
    aiAvailable: true,
    aiSearchEnabled: false,
    mode: "keyword",
  };
}
function execute(name: string, args: Arguments): Result {
  if (name === "search_drops") return result(name, args, search(args));
  if (name === "upload_source") {
    const file = args.file as { file_id?: string };
    const upload = uploads.get(file.file_id ?? "");
    return upload
      ? result(name, args, {
          attachmentId: upload.attachmentId,
          originalText: upload.originalText,
        })
      : errorResult("Use only the supplied synthetic file.");
  }
  if (name === "draft_drop")
    return result(name, args, {
      draft: {
        title: "Synthetic AI draft",
        summary: "Proposed metadata only",
        category: "Testing",
        tags: ["fixture"],
        extractedText: "Synthetic extraction",
        sourceUrl: "",
      },
    });
  if (name === "save_drop") {
    const supplied = args.source as {
      originalText?: string;
      url?: string;
      attachmentId?: string;
    };
    const upload = [...uploads.values()].find(
      (value) => value.attachmentId === supplied?.attachmentId,
    );
    const source = {
      id: id(nextId++),
      originalText: supplied?.originalText ?? "",
      url: supplied?.url ?? "",
      createdAt: stamp,
      hasImage: false,
      hasFile: Boolean(supplied?.attachmentId),
      filename: supplied?.attachmentId
        ? (upload?.name ?? "widget-file-a.txt")
        : null,
      mime: supplied?.attachmentId ? ("text/plain" as const) : null,
      ...(supplied?.attachmentId
        ? { attachmentId: supplied.attachmentId }
        : {}),
    };
    const detail: Detail = {
      item: {
        id: id(nextId++),
        sourceId: source.id,
        title: String(args.title),
        summary: String(args.summary ?? ""),
        category: String(args.category ?? "Uncategorized"),
        tags: (args.tags ?? []) as string[],
        notes: String(args.notes ?? ""),
        isSaved: Boolean(args.isSaved),
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp,
        trashedAt: null,
        deleteAfter: null,
        hasImage: false,
        sourceUrl: source.url,
        reviewedTranscription: (args.reviewedTranscription ?? null) as
          string | null,
        transcriptionUpdatedAt: args.reviewedTranscription ? stamp : null,
        transcriptionProvenance: args.reviewedTranscription
          ? "reviewed"
          : "original",
      },
      source,
    };
    records.set(detail.item.id, detail);
    return result(name, args, { ...detail, replayed: false });
  }
  const detail = records.get(String(args.id));
  if (!detail) return errorResult("Synthetic drop unavailable", "NOT_FOUND");
  if (name === "get_drop") return result(name, args, detail, true);
  if (args.revision !== detail.item.revision)
    return errorResult(
      "The drop changed. Load the latest version before saving.",
      "CONFLICT",
    );
  if (name === "update_drop") {
    const patch = Object.fromEntries(
      [
        "title",
        "summary",
        "category",
        "tags",
        "notes",
        "isSaved",
        "reviewedTranscription",
      ]
        .filter((key) => key in args)
        .map((key) => [key, args[key]]),
    );
    detail.item = {
      ...detail.item,
      ...patch,
      revision: detail.item.revision + 1,
    };
    if ("reviewedTranscription" in patch) {
      detail.item.transcriptionProvenance =
        patch.reviewedTranscription === null ? "original" : "reviewed";
      detail.item.transcriptionUpdatedAt =
        patch.reviewedTranscription === null ? null : stamp;
    }
    return result(name, args, detail);
  }
  if (name === "wipe_drop" || name === "restore_drop") {
    detail.item.revision++;
    detail.item.trashedAt = name === "wipe_drop" ? stamp : null;
    detail.item.deleteAfter =
      name === "wipe_drop" ? "2026-10-08T00:00:00.000Z" : null;
    return result(
      name,
      args,
      name === "wipe_drop" ? { trashed: true } : detail,
    );
  }
  return errorResult("Unsupported synthetic tool");
}
async function attachHost() {
  if (bridge) {
    say("Host already enabled. Use the widget Retry button if needed.");
    return;
  }
  bridge = new AppBridge(
    null,
    { name: "Synthetic local host", version: "1.0.0" },
    { serverTools: {}, openLinks: {}, downloadFile: {} },
    {
      hostContext: {
        theme: "light",
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: { width: 1100, maxHeight: 790 },
      },
    },
  );
  bridge.oninitialized = () => {
    initialized = true;
    say("Host initialized; no tool result injected and no search requested.");
  };
  bridge.oncalltool = async ({ name, arguments: args = {} }) => {
    const entry = {
      name,
      arguments: structuredClone(args),
      status: "received",
    };
    requests.push(entry);
    if (holdNext === "any" || holdNext === name) {
      holdNext = "";
      entry.status = "pending";
      say(`Held ${name}; use Release success or Release failure.`);
      return new Promise<Result>((resolve) => {
        pending.push({ entry, resolve });
        render();
      });
    }
    try {
      const response = execute(name, args);
      entry.status = response.isError ? "error" : "success";
      render();
      return response;
    } catch {
      entry.status = "fixture-error";
      render();
      return errorResult("Synthetic fixture rejected the request.");
    }
  };
  bridge.onrequestdisplaymode = async ({ mode }) => ({ mode });
  bridge.ondownloadfile = async () => {
    say("Synthetic download requested; no external destination opened.");
    return {};
  };
  bridge.onopenlink = async () => ({ isError: true });
  await bridge.connect(
    new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!),
  );
  say("Host enabled. Waiting for initialization or the widget Retry button.");
}
async function reset(connected: boolean) {
  const old = bridge;
  bridge = undefined;
  if (old) await old.close();
  for (const operation of pending.splice(0))
    operation.resolve(errorResult("Synthetic fixture reset"));
  initialized = false;
  handshakes = 0;
  holdNext = "";
  requests.length = 0;
  retainedState = undefined;
  seed();
  iframe = document.createElement("iframe");
  iframe.title = "Actual Drop It React widget";
  iframe.id = "widget-frame";
  el("stage").replaceChildren(iframe);
  if (connected) await attachHost();
  iframe.src = `/widget?run=${Date.now()}`;
  say(
    connected
      ? "Starting connected widget"
      : "No host: wait 15 seconds for visible error, enable host, then click widget Retry.",
  );
}
async function inject(
  name: McpToolName,
  args: Arguments,
  data: unknown,
  bytes = false,
) {
  if (!bridge || !initialized) {
    say("Initialize the widget before injecting a result.");
    return;
  }
  await bridge.sendToolInput({ arguments: args });
  await bridge.sendToolResult(result(name, args, data, bytes));
  say(`Injected ${name}; host injection is not a UI tool request.`);
}
const action = (control: string, run: () => void | Promise<void>) => {
  el(control).addEventListener("click", () => {
    Promise.resolve()
      .then(run)
      .catch(() => say("Synthetic host control failed; reset the fixture."));
  });
};
action("reset-normal", () => reset(true));
action("reset-timeout", () => reset(false));
action("enable-host", attachHost);
action("inject-empty", () => {
  const args = { ...filtered, query: "no match", offset: 0 };
  return inject("search_drops", args, search(args));
});
action("inject-search", () =>
  inject("search_drops", filtered, search(filtered)),
);
action("inject-draft", () =>
  inject(
    "draft_drop",
    {
      source: {
        attachmentId: attachmentA,
        originalText: "Immutable synthetic source A.",
        url: "",
      },
    },
    {
      draft: {
        title: "Host draft A — unsaved",
        summary:
          "Source A must stay separate from corrected text and replacement B.",
        category: "Testing",
        tags: ["fixture"],
        extractedText: "Immutable synthetic source A.",
        sourceUrl: "",
      },
    },
  ),
);
action("inject-detail", () =>
  inject("get_drop", { id: id(1) }, records.get(id(1)), true),
);
action("inject-detail-bare", () =>
  inject("get_drop", { id: id(1) }, records.get(id(1))),
);
action("cancel-tool", async () => {
  await bridge?.sendToolCancelled({ reason: "Synthetic cancellation" });
  say("Sent synthetic cancellation.");
});
action("hold-next", () => {
  holdNext = (el("delay-tool") as HTMLSelectElement).value;
  say(`Armed delay for ${holdNext}`);
});
for (const success of [true, false])
  action(success ? "release-success" : "release-failure", () => {
    const operation = pending.shift();
    if (!operation) {
      say("No pending request.");
      return;
    }
    operation.entry.status = success ? "released-success" : "released-error";
    operation.resolve(
      success
        ? execute(operation.entry.name, operation.entry.arguments)
        : errorResult("Synthetic delayed failure; your edits must remain."),
    );
    say(`Released ${operation.entry.name}: ${success ? "success" : "failure"}`);
  });
action("clear-log", () => {
  if (pending.length) {
    say("Release pending requests before clearing the log.");
    return;
  }
  requests.length = 0;
  say("Request log cleared.");
});
window.addEventListener("message", (event) => {
  if (
    event.source === iframe?.contentWindow &&
    event.origin === location.origin &&
    event.data?.method === "ui/initialize"
  ) {
    handshakes++;
    render();
  }
});
Object.assign(window, {
  syntheticWidgetUpload: async (file: File) => {
    if (file.name !== "widget-file-b.txt" || file.size > 65536)
      throw new Error("Use only the supplied widget-file-b.txt fixture.");
    const fileId = `synthetic-${nextId++}`;
    uploads.set(fileId, {
      attachmentId: id(nextId++),
      originalText: await file.text(),
      name: file.name,
    });
    say("Synthetic file B staged in memory.");
    return { fileId };
  },
  syntheticWidgetState: (value: unknown) => {
    retainedState = value;
    render();
  },
});
void reset(true);
