import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

test("extension packaging includes only reviewed browser assets and one service origin", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  try {
    execFileSync(
      process.execPath,
      ["scripts/build-extension.mjs", "http://localhost:4317"],
      { cwd: root, stdio: "pipe" },
    );
    const manifest = JSON.parse(
      await readFile(
        new URL("../dist/chrome-extension/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(manifest.manifest_version, 3);
    assert.equal(
      manifest.commands._execute_action.suggested_key.mac,
      "Command+Shift+Y",
    );
    assert.equal(
      manifest.commands._execute_action.suggested_key.default,
      "Ctrl+Shift+Y",
    );
    assert.deepEqual(manifest.host_permissions, ["http://localhost:4317/*"]);
    assert.deepEqual(manifest.permissions, [
      "activeTab",
      "scripting",
      "contextMenus",
      "storage",
      "identity",
    ]);
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.externally_connectable, undefined);
    assert.match(
      manifest.content_security_policy.extension_pages,
      /connect-src http:\/\/localhost:4317$/,
    );
    const key = (
      await readFile(
        new URL("../extension/public-key.txt", import.meta.url),
        "utf8",
      )
    ).trim();
    assert.equal(manifest.key, key);
    assert.equal(
      createHash("sha256").update(Buffer.from(key, "base64")).digest().length,
      32,
    );
    const names = execFileSync("unzip", ["-Z1", "dist/drop-it-chrome.zip"], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    assert.deepEqual(
      names.sort(),
      [
        "manifest.json",
        "config.js",
        "background.js",
        "controller.js",
        "capture.js",
        "oauth.js",
        "popup.js",
        "popup.html",
        "popup.css",
        "icons/16.png",
        "icons/32.png",
        "icons/48.png",
        "icons/128.png",
      ].sort(),
    );
    assert.match(
      await readFile(
        new URL("../dist/chrome-extension/config.js", import.meta.url),
        "utf8",
      ),
      /http:\/\/localhost:4317/,
    );
    for (const bad of [
      "http://example.org",
      "https://example.org/path",
      "https://example.org/?token=unsafe",
      "https://user:pass@example.org",
    ])
      assert.throws(() =>
        execFileSync(process.execPath, ["scripts/build-extension.mjs", bad], {
          cwd: root,
          stdio: "pipe",
        }),
      );
  } finally {
    // The user-facing package always targets the existing public library.
    execFileSync(process.execPath, ["scripts/build-extension.mjs"], {
      cwd: root,
      stdio: "pipe",
    });
  }
});
