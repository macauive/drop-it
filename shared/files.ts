export const fileTypes = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
} as const;
export const fileAccept = Object.keys(fileTypes)
  .map((extension) => `.${extension}`)
  .join(",");
export const maxFileBytes = 10 * 1024 * 1024;
export function fileMime(filename: string) {
  const extension = filename.split(".").pop()?.toLowerCase();
  return Object.hasOwn(fileTypes, extension ?? "")
    ? fileTypes[extension as keyof typeof fileTypes]
    : undefined;
}
export const isImageMime = (mime: string) =>
  ["image/png", "image/jpeg", "image/webp"].includes(mime);
