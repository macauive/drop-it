import { readFileSync } from "node:fs";

// Reuse the original library favicon for public-page and installed-app branding.
export const appIconSvg = readFileSync(
  new URL("../web/favicon.svg", import.meta.url),
  "utf8",
);
const faviconIco = readFileSync(new URL("../web/favicon.ico", import.meta.url));
export const publicBrandHead = `
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#f8f9fb" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#090a0b" media="(prefers-color-scheme: dark)">
  <link rel="icon" type="image/x-icon" href="data:image/x-icon;base64,${faviconIco.toString("base64")}">
  <link rel="icon" type="image/svg+xml" sizes="any" href="data:image/svg+xml,${encodeURIComponent(appIconSvg)}">`;
const brandMark = appIconSvg.replace(
  "<svg ",
  '<svg class="brand-icon" aria-hidden="true" ',
);

export const publicBrandStyles = `
    :root {
      font-family:
        Inter,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
      color: #242932;
      background: #f8f9fb;
      font-synthesis: none;
      --blue: #1764c0;
      --muted: #626c78;
      --line: #e0e5ec;
      --text: #242932;
      --surface: #fff;
      color-scheme: light;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        color: #f1f3f5;
        background: #090a0b;
        --blue: #82b8ff;
        --muted: #a3aab4;
        --line: #282c31;
        --text: #f1f3f5;
        --surface: #0f1113;
        color-scheme: dark;
      }
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
    }
    a {
      color: inherit;
      text-decoration: none;
      text-underline-offset: 4px;
    }
    a:focus-visible {
      outline: 3px solid var(--blue);
      outline-offset: 5px;
    }
    a:hover {
      text-decoration: underline;
    }
    svg {
      flex-shrink: 0;
    }
    h1,
    h2,
    h3,
    p {
      margin: 0;
    }
    p {
      line-height: 1.7;
    }
    .container {
      width: min(1120px, calc(100% - 80px));
      margin-inline: auto;
    }
    .skip {
      position: absolute;
      top: 12px;
      left: 12px;
      transform: translateY(-200%);
      padding: 12px;
      background: var(--surface);
      z-index: 5;
    }
    .skip:focus {
      transform: none;
    }
    header {
      border-bottom: 1px solid var(--line);
    }
    .navigation {
      min-height: 88px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-size: 24px;
      font-weight: 720;
      white-space: nowrap;
    }
    .brand-icon {
      display: block;
      width: 32px;
      height: 32px;
      flex: none;
    }
    .brand-dot { color: var(--blue); }
    nav {
      display: flex;
      align-items: center;
      gap: 30px;
      font-size: 14px;
      font-weight: 500;
    }
    .nav-library {
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }
    .nav-library svg {
      width: 17px;
      height: 17px;
    }
    footer {
      border-top: 1px solid var(--line);
    }
    .footer-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      padding-block: 27px;
      color: var(--muted);
      font-size: 12px;
    }
    .footer-credit {
      line-height: 1.7;
      overflow-wrap: anywhere;
    }
    .footer-credit strong {
      color: var(--text);
      font-weight: 600;
    }
    footer nav {
      gap: 24px;
      font-size: 12px;
    }
    nav a[aria-current="page"] {
      color: var(--blue);
      text-decoration: underline;
    }
    @media (max-width: 900px) {
      .container { width: calc(100% - 48px); }
    }
    @media (max-width: 640px) {
      .container { width: calc(100% - 40px); }
      .navigation { flex-wrap: wrap; gap: 18px; padding-block: 20px; }
      .navigation nav { width: 100%; justify-content: space-between; }
      nav { gap: 18px; font-size: 13px; flex-wrap: wrap; }
      .nav-library svg { display: none; }
      .footer-inner { align-items: flex-start; flex-direction: column; gap: 18px; padding-block: 24px; }
    }
    @media (max-width: 360px) {
      .container { width: calc(100% - 32px); }
      nav { gap: 12px; }
    }
`;

export function publicHeader(currentPath: string) {
  const current = (path: string) =>
    currentPath === path ? ' aria-current="page"' : "";
  return `<a class="skip" href="#main">Skip to content</a>
  <header><div class="container navigation">
    <a class="brand" href="/about" aria-label="Drop It — About">${brandMark}<span class="brand-name">drop it<span class="brand-dot">.</span></span></a>
    <nav aria-label="Main"><a href="/about"${current("/about")}>About</a><a href="/support"${current("/support")}>Support</a><a class="nav-library" href="/">Open library <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg></a></nav>
  </div></header>`;
}

// publisher must already be HTML-escaped by the caller.
export function publicFooter(publisher: string, currentPath: string) {
  const links = [
    ["/support", "Support"],
    ["/privacy", "Privacy"],
    ["/terms", "Terms"],
  ]
    .map(
      ([path, label]) =>
        `<a href="${path}"${path === currentPath ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("");
  return `<footer><div class="container footer-inner"><p class="footer-credit"><strong>Drop It</strong><br>Published by ${publisher}.</p><nav aria-label="Product information">${links}</nav></div></footer>`;
}

// title/body/publisher are trusted page markup or HTML-escaped by the caller.
export function renderInformationPage(
  title: string,
  body: string,
  publisher: string,
  path: string,
) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} · Drop It</title>
  ${publicBrandHead}
  <style>${publicBrandStyles}
    .information { max-width: 760px; padding-block: 64px 72px; }
    .information h1 { font-size: clamp(36px, 6vw, 48px); line-height: 1.15; letter-spacing: -1.5px; margin-bottom: 28px; }
    .information h2 { font-size: 24px; line-height: 1.3; letter-spacing: -.5px; margin-block: 36px 14px; }
    .information p + p { margin-top: 18px; }
    .information a { color: var(--blue); text-decoration: underline; overflow-wrap: anywhere; }
    @media (max-width: 640px) { .information { padding-block: 40px 48px; } }
  </style>
</head>
<body>
  ${publicHeader(path)}
  <main id="main" class="container information"><h1>${title}</h1>${body}</main>
  ${publicFooter(publisher, path)}
</body>
</html>`;
}
