import type { Plugin } from "vite";

// Drop It's web page and MCP widget share one self-contained HTML artifact.
// Only Vite-generated script/stylesheet tags are rewritten; no glob matching.
export function inlineWidget(): Plugin {
  return {
    name: "drop-it:inline-widget",
    apply: "build",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const page = bundle["index.html"];
        if (!page || page.type !== "asset")
          this.error("The widget build must emit index.html.");
        let html = String(page.source);
        for (const [name, output] of Object.entries(bundle)) {
          if (name === "index.html") continue;
          const filename = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          let tag: RegExp;
          let inline: string;
          if (output.type === "chunk") {
            if (
              output.imports.length ||
              output.dynamicImports.some((imported) => imported !== name)
            )
              this.error(
                "The widget build must not depend on separate chunks.",
              );
            tag = new RegExp(
              `<script\\b[^>]*\\bsrc="(?:\\./|/)?${filename}"[^>]*><\\/script>`,
              "g",
            );
            // Preserve JS string values while preventing HTML raw-text escapes.
            const code = output.code.replace(
              /<(\/script\b|script\b|!--)/gi,
              "\\x3c$1",
            );
            inline = `<script type="module">${code}</script>`;
          } else if (name.endsWith(".css")) {
            tag = new RegExp(
              `<link\\b(?=[^>]*\\brel="stylesheet")[^>]*\\bhref="(?:\\./|/)?${filename}"[^>]*>`,
              "g",
            );
            const css =
              typeof output.source === "string"
                ? output.source
                : new TextDecoder().decode(output.source);
            inline = `<style>${css.replace(/<(\/style\b)/gi, "\\3c $1")}</style>`;
          } else {
            this.error(`The widget build emitted an external asset: ${name}`);
          }
          if ([...html.matchAll(tag)].length !== 1)
            this.error(`Expected one HTML reference to ${name}.`);
          html = html.replace(tag, () => inline);
          delete bundle[name];
        }
        page.source = html;
      },
    },
  };
}
