/** Suggest only from caller-provided source values; never fetch or infer page content. */
export function suggestCaptureTitle(
  text: string,
  url: string,
  fileName?: string,
): string {
  const line = text.split(/\r?\n/).find((value) => value.trim());
  if (line) return line.trim().replace(/\s+/g, " ").slice(0, 200);
  if (url.trim()) {
    try {
      const parsed = new URL(url.trim());
      if (
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
      )
        return parsed.hostname.slice(0, 200);
    } catch {
      /* An incomplete source link has no title suggestion yet. */
    }
  }
  return fileName?.slice(0, 200) ?? "";
}
