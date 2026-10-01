import { App } from "@modelcontextprotocol/ext-apps";
import type {
  Item,
  Source,
  SearchInput,
  SearchResult,
  SaveInput,
  DraftResult,
} from "../shared/schema.js";
import { fileMime } from "../shared/files.js";
import { downloadOriginal } from "./download.js";

type FileRef = { fileId: string; fileName?: string; mimeType?: string };
declare global {
  interface Window {
    openai?: {
      uploadFile?: (file: File) => Promise<FileRef>;
      getFileDownloadUrl?: (input: {
        fileId: string;
      }) => Promise<{ downloadUrl: string }>;
    };
  }
}
export const embedded = window.parent !== window;
const publicAuthPaths = new Set([
  "/api/login",
  "/api/setup",
  "/api/register",
  "/api/recover",
]);
let browserAuthVersion = 0;

// Shared by JSON requests, uploads, and exports. A wrong credential remains an
// inline form error; a missing browser session clears the authenticated UI.
export async function browserRequest(path: string, options: RequestInit = {}) {
  const version = browserAuthVersion;
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
  });
  if (embedded) return response;
  if (publicAuthPaths.has(path)) {
    if (response.ok) browserAuthVersion++;
    return response;
  }
  if (response.status === 401 && version === browserAuthVersion) {
    const result = await response
      .clone()
      .json()
      .catch(() => null);
    if (
      version === browserAuthVersion &&
      result?.code !== "LOGIN_FAILED" &&
      result?.code !== "RECOVERY_FAILED"
    ) {
      browserAuthVersion++;
      window.dispatchEvent(new Event("dropit:unauthenticated"));
    }
  }
  return response;
}
export class ClientError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
type Detail = {
  item: Item;
  source: Source;
  imageData?: string;
  fileData?: string;
  downloadPageUrl?: string;
};
type ToolResponse = {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
let bridge: App | undefined;
let connection: Promise<void> | undefined;
async function connect() {
  if (!connection) {
    bridge = new App(
      { name: "drop-it-library", version: "0.1.0" },
      {},
      { autoResize: true },
    );
    bridge.ontoolresult = (result) =>
      window.dispatchEvent(
        new CustomEvent("dropit:result", { detail: result.structuredContent }),
      );
    connection = Promise.race([
      bridge.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error("The ChatGPT connection timed out. Reopen Drop It."),
            ),
          15000,
        ),
      ),
    ]);
  }
  return connection;
}
async function call<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  await connect();
  const result = (await bridge!.callServerTool({
    name,
    arguments: args,
  })) as ToolResponse;
  const data = result.structuredContent;
  if (result.isError || !data)
    throw new ClientError(
      typeof data?.error === "string"
        ? data.error
        : "The action could not be completed.",
      typeof data?.code === "string" ? data.code : undefined,
    );
  return {
    ...data,
    ...(typeof result._meta?.imageData === "string"
      ? { imageData: result._meta.imageData }
      : {}),
    ...(typeof result._meta?.fileData === "string"
      ? { fileData: result._meta.fileData }
      : {}),
    ...(typeof result._meta?.downloadPageUrl === "string"
      ? { downloadPageUrl: result._meta.downloadPageUrl }
      : {}),
  } as T;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await browserRequest(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new ClientError(
      result.error ?? "The action could not be completed.",
      result.code,
    );
  return result;
}
export const client = {
  download: async (id: string) => {
    // Refresh authorization and expiration before exporting, rather than
    // downloading bytes retained by an old widget instance.
    const detail = await call<Detail>("get_item", { id });
    const data = detail.fileData ?? detail.imageData;
    if (!data || !detail.source.filename)
      throw new Error("The original file is no longer available.");
    return downloadOriginal(
      bridge!,
      data,
      detail.source.filename,
      detail.downloadPageUrl,
      id,
    );
  },
  draft: (
    source: NonNullable<SaveInput["source"]>,
  ): Promise<{ draft: DraftResult }> =>
    embedded
      ? call("draft_item", { source })
      : api("/api/draft", "POST", { source }),
  search: (input: SearchInput): Promise<SearchResult> =>
    embedded ? call("search_items", input) : api("/api/search", "POST", input),
  get: (id: string): Promise<Detail> =>
    embedded ? call("get_item", { id }) : api(`/api/items/${id}`),
  save: (input: SaveInput): Promise<Detail> =>
    embedded
      ? call("save_item", input as Record<string, unknown>)
      : api("/api/items", "POST", input),
  update: (id: string, fields: Record<string, unknown>): Promise<Detail> =>
    embedded
      ? call("update_item", { id, ...fields })
      : api(`/api/items/${id}`, "PATCH", fields),
  delete: (id: string, revision: number) =>
    embedded
      ? call("delete_item", { id, revision })
      : api(`/api/items/${id}`, "DELETE", { revision }),
  restore: (id: string, revision: number): Promise<Detail> =>
    embedded
      ? call("restore_item", { id, revision })
      : api(`/api/items/${id}/restore`, "POST", { revision }),
  upload: async (
    file: File,
  ): Promise<{ attachmentId: string; originalText: string }> => {
    if (embedded) {
      if (!window.openai?.uploadFile || !window.openai.getFileDownloadUrl)
        throw new Error(
          "Attach the file to your ChatGPT message and ask Drop It to save it.",
        );
      const ref = await window.openai.uploadFile(file);
      const { downloadUrl } = await window.openai.getFileDownloadUrl({
        fileId: ref.fileId,
      });
      return call("upload_source", {
        file: {
          download_url: downloadUrl,
          file_id: ref.fileId,
          file_name: file.name,
          mime_type: fileMime(file.name) ?? "application/octet-stream",
        },
      });
    }
    const response = await browserRequest("/api/attachments", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name),
      },
      body: file,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Upload failed.");
    return result;
  },
};
