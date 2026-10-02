import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import {
  idSchema,
  searchSchema,
  sourceInputSchema,
  views,
  type Item,
  type Source,
  type SearchInput,
  type SearchResult,
  type SaveInput,
  type DraftResult,
} from "../shared/schema.js";
import {
  detailResultSchema,
  mcpErrorSchema,
  mcpOutputSchemas,
  type McpToolName,
} from "../shared/mcp-results.js";
import { maxFileBytes } from "../shared/files.js";

type FileRef = { fileId: string; fileName?: string; mimeType?: string };
declare global {
  interface Window {
    openai?: {
      uploadFile?: (file: File) => Promise<FileRef>;
      getFileDownloadUrl?: (input: {
        fileId: string;
      }) => Promise<{ downloadUrl: string }>;
      widgetState?: unknown;
      setWidgetState?: (state: { dropItView: (typeof views)[number] }) => void;
    };
  }
}

export type Detail = {
  item: Item;
  source: Source;
  imageData?: string;
  fileData?: string;
  downloadPageUrl?: string;
};
export type ErrorDetails = { items?: Array<{ id: string; title: string }> };
export class ClientError extends Error {
  constructor(
    message: string,
    public code?: string,
    public details?: ErrorDetails,
  ) {
    super(message);
  }
}
export type ToolResponse = {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
export type EmbeddedPresentation =
  | { kind: "search"; input: SearchInput; result: SearchResult }
  | { kind: "detail"; detail: Detail }
  | {
      kind: "draft";
      source: NonNullable<SaveInput["source"]>;
      draft: DraftResult;
    }
  | { kind: "trashed"; id: string };
export type EmbeddedState = {
  status: "idle" | "connecting" | "ready" | "error";
  error: string;
  presentation: EmbeddedPresentation | null;
  version: number;
  displayMode: "inline" | "fullscreen" | "pip";
  canFullscreen: boolean;
};
const toolNameSchema = z.enum(
  Object.keys(mcpOutputSchemas) as [McpToolName, ...McpToolName[]],
);
const contextSchema = z
  .object({
    tool: toolNameSchema,
    input: z.record(z.string(), z.unknown()),
  })
  .strict();

// HTTP middleware errors have a bounded public message but may omit the MCP
// error code. Keep the display boundary strict without hiding that guidance.
const displayErrorSchema = mcpErrorSchema.extend({
  code: mcpErrorSchema.shape.code.optional(),
});

export function responseError(result: ToolResponse) {
  const parsed = displayErrorSchema.safeParse(result.structuredContent);
  if (parsed.success)
    return new ClientError(parsed.data.error, parsed.data.code, {
      ...(parsed.data.items ? { items: parsed.data.items } : {}),
    });
  // Authentication errors carry the host challenge separately and have no
  // successful output shape. Use bounded server text, never transport errors.
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  return new ClientError(
    typeof text === "string" && text.length <= 1000
      ? text
      : "The action could not be completed. Try again.",
  );
}

export function detailFromResponse(result: ToolResponse): Detail {
  const detail = detailResultSchema.parse({
    item: result.structuredContent?.item,
    source: result.structuredContent?.source,
  });
  const meta = result._meta;
  const data = meta?.[detail.source.hasImage ? "imageData" : "fileData"];
  const prefix = `data:${detail.source.mime};base64,`;
  const validData =
    detail.source.hasFile &&
    typeof data === "string" &&
    data.length <= 4 * Math.ceil(maxFileBytes / 3) + 100 &&
    data.startsWith(prefix) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(data.slice(prefix.length));
  return {
    ...detail,
    ...(validData
      ? { [detail.source.hasImage ? "imageData" : "fileData"]: data }
      : {}),
    ...(typeof meta?.downloadPageUrl === "string" &&
    meta.downloadPageUrl.length <= 2048
      ? { downloadPageUrl: meta.downloadPageUrl }
      : {}),
  };
}

export function presentationFromResponse(
  result: ToolResponse,
  toolName?: string,
  input: Record<string, unknown> = {},
): EmbeddedPresentation | null {
  if (result.isError) throw responseError(result);
  const context = contextSchema.safeParse(result._meta?.dropIt);
  const name = toolNameSchema.parse(
    context.success ? context.data.tool : toolName,
  );
  const args = context.success ? context.data.input : input;
  const data = mcpOutputSchemas[name].parse(result.structuredContent);
  if (name === "search_drops")
    return {
      kind: "search",
      input: searchSchema.parse(args),
      result: mcpOutputSchemas.search_drops.parse(data),
    };
  if (name === "draft_drop")
    return {
      kind: "draft",
      source: sourceInputSchema.parse(args.source),
      draft: mcpOutputSchemas.draft_drop.parse(data).draft,
    };
  if (name === "wipe_drop")
    return { kind: "trashed", id: idSchema.parse(args.id) };
  if (["get_drop", "save_drop", "update_drop", "restore_drop"].includes(name))
    return { kind: "detail", detail: detailFromResponse(result) };
  return null;
}

export type EmbeddedBridge = Pick<
  App,
  | "connect"
  | "close"
  | "callServerTool"
  | "getHostContext"
  | "requestDisplayMode"
  | "ontoolinput"
  | "ontoolresult"
  | "ontoolcancelled"
  | "onhostcontextchanged"
  | "onclose"
  | "getHostCapabilities"
  | "downloadFile"
  | "openLink"
> &
  Partial<Pick<App, "setupSizeChangedNotifications">>;
type ActiveBridge = { bridge: EmbeddedBridge; cleanup?: () => void };

// Exported for lifecycle tests with a synthetic host. No storage, credentials,
// or network is involved until an actual embedded UI explicitly connects.
export class EmbeddedController {
  private state: EmbeddedState = {
    status: "idle",
    error: "",
    presentation: null,
    version: 0,
    displayMode: "inline",
    canFullscreen: false,
  };
  private listeners = new Set<() => void>();
  private active?: ActiveBridge;
  private connection?: Promise<void>;
  private input: Record<string, unknown> = {};
  constructor(
    private readonly factory: () => EmbeddedBridge,
    private readonly applyContext: (
      context: McpUiHostContext,
    ) => void = () => {},
    private readonly timeoutMs = 15000,
  ) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<EmbeddedState>) {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  private context(context: McpUiHostContext = {}) {
    this.applyContext(context);
    this.publish({
      ...(context.displayMode ? { displayMode: context.displayMode } : {}),
      ...(context.availableDisplayModes
        ? {
            canFullscreen: context.availableDisplayModes.includes("fullscreen"),
          }
        : {}),
    });
  }
  private async dispose(entry: ActiveBridge) {
    entry.cleanup?.();
    entry.bridge.ontoolinput = undefined;
    entry.bridge.ontoolresult = undefined;
    entry.bridge.ontoolcancelled = undefined;
    entry.bridge.onhostcontextchanged = undefined;
    entry.bridge.onclose = undefined;
    try {
      await entry.bridge.close();
    } catch {
      /* The transport is already gone. */
    }
  }
  connect = (): Promise<void> => {
    if (this.connection) {
      const entry = this.active;
      return this.connection.then(() => {
        // A tool cancellation or unreadable result does not close the bridge.
        // Retry acknowledges that error; it must not replay a possibly completed
        // mutation or leave the cached successful connection stuck in error.
        if (entry && this.active === entry && this.state.status === "error")
          this.publish({ status: "ready", error: "" });
      });
    }
    const entry = { bridge: this.factory() } as ActiveBridge;
    this.active = entry;
    this.input = {};
    this.publish({ status: "connecting", error: "" });
    const current = () => this.active === entry;
    entry.bridge.ontoolinput = ({ arguments: args }) => {
      if (!current()) return;
      this.input = args ?? {};
      this.publish({ error: "" });
    };
    entry.bridge.ontoolresult = (result) => {
      if (!current()) return;
      try {
        const presentation = presentationFromResponse(
          result as ToolResponse,
          entry.bridge.getHostContext()?.toolInfo?.tool.name,
          this.input,
        );
        if (presentation)
          this.publish({
            status: "ready",
            error: "",
            presentation,
            version: this.state.version + 1,
          });
      } catch (error) {
        this.publish({
          status: "error",
          presentation: null,
          error:
            error instanceof ClientError
              ? error.message
              : "The result could not be displayed. Try the request again.",
          version: this.state.version + 1,
        });
      }
    };
    entry.bridge.ontoolcancelled = () => {
      if (current())
        this.publish({
          status: "error",
          error: "The action was cancelled. You can try again.",
        });
    };
    entry.bridge.onhostcontextchanged = (context) => {
      if (current()) this.context(context);
    };
    entry.bridge.onclose = () => {
      if (!current()) return;
      this.active = undefined;
      this.connection = undefined;
      void this.dispose(entry);
      this.publish({
        status: "error",
        error: "The connection closed. Retry to reconnect.",
      });
    };
    this.connection = this.open(entry);
    return this.connection;
  };
  private async open(entry: ActiveBridge) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => entry.bridge.connect()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timeout")),
            this.timeoutMs,
          );
        }),
      ]);
      if (this.active !== entry) throw new Error("closed");
      this.context(entry.bridge.getHostContext());
      entry.cleanup = entry.bridge.setupSizeChangedNotifications?.();
      // An initial tool result may already have arrived during initialization.
      if (this.state.status === "connecting") this.publish({ status: "ready" });
    } catch {
      if (this.active === entry) {
        this.active = undefined;
        this.connection = undefined;
        await this.dispose(entry);
        this.publish({
          status: "error",
          error:
            "The ChatGPT connection could not be established. Retry to reconnect.",
        });
      }
      throw new ClientError(
        "The ChatGPT connection could not be established. Retry to reconnect.",
        "CONNECTION_FAILED",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  call = async <T>(
    name: McpToolName,
    args: Record<string, unknown>,
  ): Promise<T> => {
    await this.connect();
    const entry = this.active!;
    let result: ToolResponse;
    try {
      result = (await entry.bridge.callServerTool(
        { name, arguments: args },
        { timeout: 90000 },
      )) as ToolResponse;
    } catch {
      throw new ClientError(
        "No result was received. Check your library before retrying this action.",
        "CONNECTION_FAILED",
      );
    }
    if (result.isError) throw responseError(result);
    const data = mcpOutputSchemas[name].safeParse(result.structuredContent);
    if (!data.success)
      throw new ClientError(
        "The response could not be read. Reload and try again.",
        "INVALID_RESPONSE",
      );
    // UI-originated calls return to their caller only. Publishing them as host
    // notifications would re-open panels and overwrite in-progress forms.
    return {
      ...data.data,
      ...(["get_drop", "save_drop", "update_drop", "restore_drop"].includes(
        name,
      )
        ? detailFromResponse(result)
        : {}),
    } as T;
  };
  getBridge = () => this.active?.bridge;
  requestFullscreen = async () => {
    await this.connect();
    if (!this.state.canFullscreen) return false;
    try {
      const result = await this.active!.bridge.requestDisplayMode(
        { mode: "fullscreen" },
        { timeout: 15000 },
      );
      this.context({ displayMode: result.mode });
      return result.mode === "fullscreen";
    } catch {
      throw new ClientError(
        "Fullscreen is unavailable in this host. Continue in the current view.",
      );
    }
  };
  close = async () => {
    const entry = this.active;
    this.active = undefined;
    this.connection = undefined;
    if (entry) await this.dispose(entry);
    this.publish({ status: "idle", error: "", presentation: null });
  };
}

function applyContext(context: McpUiHostContext) {
  if (typeof document === "undefined") return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
  if (context.displayMode)
    document.documentElement.dataset.displayMode = context.displayMode;
}
const controller = new EmbeddedController(
  () =>
    new App(
      { name: "drop-it-library", version: "0.1.0" },
      {},
      { autoResize: false },
    ),
  applyContext,
);
export const getEmbeddedState = controller.getState;
export const subscribeEmbedded = controller.subscribe;
export const connectEmbedded = controller.connect;
export const requestEmbeddedFullscreen = controller.requestFullscreen;
export const callEmbedded = controller.call;
export const getEmbeddedBridge = controller.getBridge;

const viewStateSchema = z.object({ dropItView: z.enum(views) }).strict();
export function readEmbeddedView(): (typeof views)[number] | null {
  const state = viewStateSchema.safeParse(
    typeof window === "undefined" ? undefined : window.openai?.widgetState,
  );
  return state.success ? state.data.dropItView : null;
}
export function rememberEmbeddedView(view: (typeof views)[number]) {
  const state = viewStateSchema.safeParse({ dropItView: view });
  if (!state.success || typeof window === "undefined") return;
  try {
    window.openai?.setWidgetState?.(state.data);
  } catch {
    /* Optional host capability. */
  }
}
