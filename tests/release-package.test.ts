import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  rm,
  access,
  readFile,
  mkdir,
  copyFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(
  new URL("../scripts/package-plugin.mjs", import.meta.url),
);
const skillFiles = [
  "skills/capture-content/SKILL.md",
  "skills/research-library/SKILL.md",
  "skills/organize-library/SKILL.md",
];
test("release packaging includes only public manifest, MCP config, icon and the three reviewed skills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drop-it-package-test-"));
  try {
    const settings = join(dir, "settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        origin: "https://synthetic.example.test",
        publisher: "Synthetic publisher",
        supportEmail: "support@example.test",
        demoRecordingUrl: "https://synthetic.example.test/demo",
        countries: ["US"],
      }),
    );
    execFileSync(process.execPath, [script, settings], {
      cwd: dir,
      stdio: "pipe",
    });
    const zip = join(dir, "dist/drop-it-plugin.zip");
    const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    assert.deepEqual(
      entries,
      [
        ".codex-plugin/plugin.json",
        ".mcp.json",
        "assets/icon.svg",
        ...skillFiles,
      ].sort(),
    );
    const manifest = JSON.parse(
      execFileSync("unzip", ["-p", zip, ".codex-plugin/plugin.json"], {
        encoding: "utf8",
      }),
    );
    assert.equal(manifest.interface.developerName, "Synthetic publisher");
    assert.equal(manifest.version, "0.1.1");
    assert.equal(manifest.skills, "./skills/");
    for (const path of skillFiles) {
      const packaged = execFileSync("unzip", ["-p", zip, path], {
        encoding: "utf8",
      });
      assert.equal(
        packaged,
        await readFile(new URL(`../${path}`, import.meta.url), "utf8"),
      );
    }
    assert.equal(
      manifest.extensions["com.openai"].review.test_cases.positive.length,
      5,
    );
    assert.equal(
      manifest.extensions["com.openai"].review.test_cases.negative.length,
      3,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("incomplete or credential-bearing release settings cannot create a package", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drop-it-package-reject-"));
  try {
    const settings = join(dir, "settings.json");
    for (const data of [
      { origin: "https://your-domain.example", publisher: "" },
      {
        origin: "https://synthetic.example.test",
        publisher: "Synthetic",
        supportEmail: "support@example.test",
        demoRecordingUrl: "https://synthetic.example.test/demo",
        countries: ["US"],
        apiKey: "invalid-fixture-value",
      },
    ]) {
      await writeFile(settings, JSON.stringify(data));
      assert.throws(() =>
        execFileSync(process.execPath, [script, settings], {
          cwd: dir,
          stdio: "pipe",
        }),
      );
      await assert.rejects(access(join(dir, "dist/drop-it-plugin.zip")));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("draft packaging omits a missing video and does not create a submission-ready archive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drop-it-package-draft-"));
  try {
    const settings = join(dir, "settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        origin: "https://synthetic.example.test",
        publisher: "Synthetic",
        supportEmail: "support@example.test",
        demoRecordingUrl: "",
        countries: ["US"],
      }),
    );
    assert.throws(() =>
      execFileSync(process.execPath, [script, settings], {
        cwd: dir,
        stdio: "pipe",
      }),
    );
    execFileSync(process.execPath, [script, settings, "--draft"], {
      cwd: dir,
      stdio: "pipe",
    });
    await assert.rejects(access(join(dir, "dist/drop-it-plugin.zip")));
    const zip = join(dir, "dist/drop-it-plugin-draft.zip");
    const manifest = JSON.parse(
      execFileSync("unzip", ["-p", zip, ".codex-plugin/plugin.json"], {
        encoding: "utf8",
      }),
    );
    assert.equal(
      manifest.extensions["com.openai"].review.demo_recording_url,
      undefined,
    );
    assert.equal(manifest.skills, "./skills/");
    const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    assert.deepEqual(
      entries,
      [
        ".codex-plugin/plugin.json",
        ".mcp.json",
        "assets/icon.svg",
        ...skillFiles,
      ].sort(),
    );
    assert.equal(
      manifest.interface.privacyPolicyURL,
      "https://synthetic.example.test/privacy",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skill packaging excludes unlisted files and rejects symlinked files or parent directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drop-it-skill-boundary-"));
  try {
    await mkdir(join(dir, "scripts"));
    await mkdir(join(dir, "release"));
    await copyFile(script, join(dir, "scripts/package-plugin.mjs"));
    await symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(dir, "node_modules"),
      "dir",
    );
    for (const path of [
      "release/icon.svg",
      "release/review-cases.json",
      ...skillFiles,
    ]) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await copyFile(new URL(`../${path}`, import.meta.url), join(dir, path));
    }
    const settings = join(dir, "settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        origin: "https://synthetic.example.test",
        publisher: "Synthetic",
        supportEmail: "support@example.test",
        demoRecordingUrl: "https://synthetic.example.test/demo",
        countries: ["US"],
      }),
    );
    await writeFile(
      join(dir, "skills/capture-content/unlisted.txt"),
      "Synthetic unlisted content",
    );
    const fixtureScript = join(dir, "scripts/package-plugin.mjs");
    execFileSync(process.execPath, [fixtureScript, settings], {
      cwd: dir,
      stdio: "pipe",
    });
    const zip = join(dir, "dist/drop-it-plugin.zip");
    const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    assert.deepEqual(
      entries,
      [
        ".codex-plugin/plugin.json",
        ".mcp.json",
        "assets/icon.svg",
        ...skillFiles,
      ].sort(),
    );
    await rm(join(dir, "dist"), { recursive: true });

    const outside = join(dir, "outside.txt");
    await writeFile(
      outside,
      "Synthetic outside content that must not be packaged",
    );
    const target = join(dir, skillFiles[0]);
    await rm(target);
    await symlink(outside, target);
    for (const args of [[], ["--draft"]]) {
      assert.throws(
        () =>
          execFileSync(process.execPath, [fixtureScript, settings, ...args], {
            cwd: dir,
            stdio: "pipe",
          }),
        (error: unknown) => {
          assert.match(
            String((error as { stderr: Buffer }).stderr),
            /Skill package inputs must be regular files/,
          );
          return true;
        },
      );
    }
    await assert.rejects(access(join(dir, "dist")));

    await rm(join(dir, "skills/capture-content"), { recursive: true });
    await symlink(
      fileURLToPath(new URL("../skills/capture-content", import.meta.url)),
      join(dir, "skills/capture-content"),
      "dir",
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [fixtureScript, settings], {
          cwd: dir,
          stdio: "pipe",
        }),
      (error: unknown) => {
        assert.match(
          String((error as { stderr: Buffer }).stderr),
          /Skill package inputs must be regular files/,
        );
        return true;
      },
    );
    await assert.rejects(access(join(dir, "dist")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
