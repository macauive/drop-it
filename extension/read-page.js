// Serialized by chrome.scripting: keep this self-contained and read-only.
// Never read form values, run page scripts, fetch URLs or traverse frames.
export function readPageDocument(mode = "selection-or-page") {
  const selectionText = (window.getSelection()?.toString() || "").slice(
    0,
    50001,
  );
  const metadata = {
    url: window.location.href,
    title: document.title.slice(0, 200),
    selectionText,
  };
  // Selected passages remain exact, including code and intentional artwork.
  if (selectionText && mode !== "page") return metadata;
  const excluded =
    'script,style,noscript,template,svg,canvas,nav,aside,footer,form,input,textarea,select,button,[hidden],[inert],[aria-hidden="true"],[contenteditable]:not([contenteditable="false"]),[role="navigation"],[role="complementary"],[role="dialog"]';
  let roots = [...document.querySelectorAll('main,[role="main"]')];
  if (!roots.length) roots = [...document.querySelectorAll("article")];
  if (!roots.length && document.body) roots = [document.body];
  roots = roots.filter(
    (root) => !roots.some((other) => other !== root && other.contains(root)),
  );
  const parts = [];
  let length = 0,
    visited = 0,
    truncated = false,
    previousCode = null;
  for (const root of roots) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.matches(excluded)) return NodeFilter.FILTER_REJECT;
            const style = getComputedStyle(node);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.visibility === "collapse"
            )
              return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    // TreeWalker does not filter its root or ancestors.
    if (root.closest(excluded)) continue;
    let hidden = false;
    for (let ancestor = root; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      ) {
        hidden = true;
        break;
      }
    }
    if (hidden) continue;
    let node;
    while ((node = walker.nextNode())) {
      if (++visited > 50000) {
        truncated = true;
        break;
      }
      const value = node.textContent || "";
      const code = node.parentElement?.closest("code");
      // Drop symbol-only art before counting toward the excerpt budget.
      // Keep prose, numbers, source code, tables and non-Latin text.
      const text = code
        ? value
        : value
            .split(/\r?\n/)
            .filter(
              (line) =>
                line.length < 40 ||
                !/^[\s.·:+*|/\\_~^=\-\u2500-\u259f\u2800-\u28ff]+$/u.test(line),
            )
            .join("\n")
            .trim();
      if (!text) continue;
      // Syntax highlighting splits one code block into many text nodes. Keep
      // their original whitespace instead of inserting newlines per token.
      const continuation = code && code === previousCode;
      const separator = parts.length && !continuation ? 1 : 0;
      const remaining = 50000 - length - separator;
      if (text.length > remaining) {
        const excerpt = text.slice(0, Math.max(0, remaining));
        if (continuation) parts[parts.length - 1] += excerpt;
        else parts.push(excerpt);
        truncated = true;
        break;
      }
      if (continuation) parts[parts.length - 1] += text;
      else parts.push(text);
      previousCode = code;
      length += text.length + separator;
    }
    if (truncated) break;
  }
  const text = parts.join("\n").trim();
  const description =
    document.querySelector('meta[name="description" i]')?.content || "";
  return {
    ...metadata,
    text,
    truncated,
    description: description.replace(/\s+/g, " ").trim().slice(0, 500),
  };
}
