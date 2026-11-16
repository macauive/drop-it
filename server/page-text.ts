// Filter extraction noise, never user-authored originals or selected passages.
// Restrict the alphabet so punctuation-heavy source code, formulas, Markdown
// tables, and text in any language survive. No provider/LLM interpretation.
const artwork = (line: string) =>
  line.length >= 40 &&
  /^[\s.·:+*|/\\_~^=\-\u2500-\u259f\u2800-\u28ff]+$/u.test(line);

export function cleanPageMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      let end = index + 1;
      for (; end < lines.length; end++) {
        const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[end]);
        if (
          close &&
          close[1][0] === fence[1][0] &&
          close[1].length >= fence[1].length
        )
          break;
      }
      const content = lines.slice(index + 1, end);
      // Remove whole art blocks, rather than leaving broken code fences.
      // Keep short symbol diagrams and every block containing code/prose.
      if (
        end < lines.length &&
        /^(?:text|txt|plaintext|ascii)?$/i.test(fence[2].trim()) &&
        content.some(artwork) &&
        content.every((value) => !value.trim() || artwork(value))
      ) {
        index = end;
        continue;
      }
      output.push(
        lines.slice(index, end < lines.length ? end + 1 : end).join("\n"),
      );
      index = end;
    } else {
      // Keep Markdown table/rule syntax. Large symbol-only animation rows
      // containing non-Markdown dot/braille patterns are safe to discard.
      if (!artwork(line) || !/[·\u2500-\u259f\u2800-\u28ff]/u.test(line)) {
        if (line.trim() || output.at(-1) !== "") output.push(line);
      }
    }
  }
  return output.join("\n").trim();
}
