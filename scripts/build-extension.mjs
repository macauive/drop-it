import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  rm,
  lstat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = new URL(process.argv[2] || "https://dontdropit.app");
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
if (
  (origin.protocol !== "https:" &&
    !(loopback && origin.protocol === "http:")) ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash ||
  origin.username ||
  origin.password
)
  throw new Error(
    "Pass an HTTPS service origin, or HTTP loopback for local development.",
  );
const output = resolve(root, "dist/chrome-extension");
await mkdir(output, { recursive: true });
if ((await lstat(output)).isSymbolicLink())
  throw new Error("Extension output must not be a symlink.");
// Copy an explicit list only. No credentials, data, repository files, or
// dependencies can enter the extension archive.
const files = [
  "background.js",
  "controller.js",
  "capture.js",
  "oauth.js",
  "popup.js",
  "popup.html",
  "popup.css",
];
for (const file of files) {
  const source = join(root, "extension", file);
  if (!(await lstat(source)).isFile())
    throw new Error("Extension inputs must be regular files.");
  await copyFile(source, join(output, file));
}
const key = (
  await readFile(join(root, "extension/public-key.txt"), "utf8")
).trim();
const id = [
  ...createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest("hex")
    .slice(0, 32),
]
  .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
  .join("");
const manifest = JSON.parse(
  await readFile(join(root, "extension/manifest.json"), "utf8"),
);
manifest.key = key; // Public identity only. No private signing key is retained.
manifest.host_permissions = [`${origin.origin}/*`];
manifest.content_security_policy.extension_pages = `script-src 'self'; object-src 'none'; base-uri 'none'; connect-src ${origin.origin}`;
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeFile(
  join(output, "config.js"),
  `export const serviceOrigin = ${JSON.stringify(origin.origin)};\n`,
);
await mkdir(join(output, "icons"), { recursive: true });
for (const size of [16, 32, 48, 128])
  await sharp(join(root, "web/favicon.svg"))
    .resize(size, size)
    .png()
    .toFile(join(output, `icons/${size}.png`));
const zip = resolve(root, "dist/drop-it-chrome.zip");
await rm(zip, { force: true });
execFileSync(
  "zip",
  [
    "-q",
    zip,
    "manifest.json",
    "config.js",
    ...files,
    ...[16, 32, 48, 128].map((size) => `icons/${size}.png`),
  ],
  { cwd: output, stdio: "pipe" },
);
console.log(
  `Built ${output}\nZIP: ${zip}\nUnpacked extension ID: ${id}\nAdd this exact callback to OAUTH_REDIRECT_URIS (preserve existing entries): https://${id}.chromiumapp.org/drop-it`,
);
