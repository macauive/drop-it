import type { App } from "@modelcontextprotocol/ext-apps";
import { fileMime, fileTypes, maxFileBytes } from "../shared/files.js";

// Only the already-authorized original returned by get_item is handed to the
// host. Never ask the host to fetch a URL or accept a path from source content.
export async function downloadOriginal(
  host: Pick<App, "getHostCapabilities" | "downloadFile"> &
    Partial<Pick<App, "openLink">>,
  data: string,
  filename: string,
  downloadPageUrl?: string,
  itemId?: string,
) {
  if (!host.getHostCapabilities()?.downloadFile) {
    if (
      downloadPageUrl &&
      itemId &&
      host.getHostCapabilities()?.openLinks &&
      host.openLink
    ) {
      // The URL is generated in server-owned tool metadata, never source text.
      // A normal browser sign-in and owner-scoped get are still required.
      const url = new URL(downloadPageUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== "/" ||
        url.search !== `?drop=${itemId}`
      )
        throw new Error(
          "The download page is invalid. Open Drop It in your browser.",
        );
      let result;
      try {
        result = await host.openLink({ url: url.href });
      } catch {
        throw new Error(
          "Could not open Drop It. Open it in your browser to download the original.",
        );
      }
      if (result.isError)
        throw new Error(
          "Opening Drop It was cancelled or declined by the host.",
        );
      return "browser" as const;
    }
    throw new Error(
      "This host does not support file downloads. Open Drop It in your browser to download the original.",
    );
  }
  const separator = data.indexOf(",");
  const header = data.slice(0, separator);
  const blob = data.slice(separator + 1);
  const mimeType = header.slice(5, -7);
  if (
    separator < 0 ||
    header !== `data:${mimeType};base64` ||
    !Object.values(fileTypes).some((type) => type === mimeType) ||
    !blob ||
    blob.length > 4 * Math.ceil(maxFileBytes / 3) ||
    blob.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(blob) ||
    filename.length > 255 ||
    /[/\\]/.test(filename) ||
    [...filename].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    fileMime(filename) !== mimeType
  )
    throw new Error(
      "The original file could not be downloaded. Reload the drop and try again.",
    );
  let result;
  try {
    result = await host.downloadFile({
      contents: [
        {
          type: "resource",
          resource: {
            uri: `file:///${encodeURIComponent(filename)}`,
            mimeType,
            blob,
          },
        },
      ],
    });
  } catch {
    throw new Error(
      "The host could not start the download. Open Drop It in your browser to download the original.",
    );
  }
  if (result.isError)
    throw new Error("Download was cancelled or declined by the host.");
  return "download" as const;
}
