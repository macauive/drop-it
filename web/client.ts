import type {
  SearchInput,
  SearchResult,
  SaveInput,
  DraftResult,
} from "../shared/schema.js";
import { fileMime } from "../shared/files.js";
import { downloadOriginal } from "./download.js";
import {
  callEmbedded as call,
  getEmbeddedBridge,
  ClientError,
  responseError,
  type Detail,
} from "./embedded.js";
export {
  ClientError,
  connectEmbedded,
  getEmbeddedState,
  subscribeEmbedded,
  requestEmbeddedFullscreen,
  readEmbeddedView,
  rememberEmbeddedView,
  type Detail,
  type EmbeddedState,
  type EmbeddedPresentation,
} from "./embedded.js";
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
  let result;
  try {
    result = await response.json();
  } catch {
    throw new ClientError(
      "The server response could not be read. Try again.",
      "INVALID_RESPONSE",
    );
  }
  if (!response.ok)
    throw responseError({ isError: true, structuredContent: result });
  return result;
}
export const client = {
  download: async (id: string) => {
    // Refresh authorization and expiration before exporting, rather than
    // downloading bytes retained by an old widget instance.
    const detail = await call<Detail>("get_drop", { id });
    const data = detail.fileData ?? detail.imageData;
    if (!data || !detail.source.filename)
      throw new Error("The original file is no longer available.");
    const bridge = getEmbeddedBridge();
    if (!bridge)
      throw new ClientError("The connection closed. Retry to reconnect.");
    return downloadOriginal(
      bridge,
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
      ? call("draft_drop", { source })
      : api("/api/draft", "POST", { source }),
  search: (input: SearchInput): Promise<SearchResult> =>
    embedded ? call("search_drops", input) : api("/api/search", "POST", input),
  get: (id: string): Promise<Detail> =>
    embedded ? call("get_drop", { id }) : api(`/api/items/${id}`),
  save: (input: SaveInput): Promise<Detail> =>
    embedded
      ? call("save_drop", input as Record<string, unknown>)
      : api("/api/items", "POST", input),
  update: (id: string, fields: Record<string, unknown>): Promise<Detail> =>
    embedded
      ? call("update_drop", { id, ...fields })
      : api(`/api/items/${id}`, "PATCH", fields),
  delete: (id: string, revision: number) =>
    embedded
      ? call("wipe_drop", { id, revision })
      : api(`/api/items/${id}`, "DELETE", { revision }),
  restore: (id: string, revision: number): Promise<Detail> =>
    embedded
      ? call("restore_drop", { id, revision })
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
