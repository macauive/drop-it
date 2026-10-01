import {
  readFile,
  mkdir,
  writeFile,
  mkdtemp,
  rm,
  copyFile,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";

// Only public listing fields are accepted. Credentials never belong in a package.
const httpsUrl = z
  .string()
  .max(1024)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.hostname.endsWith(".example")
    );
  });
const schema = z
  .object({
    origin: httpsUrl.refine(
      (value) => new URL(value).pathname === "/" && !new URL(value).search,
    ),
    publisher: z.string().trim().min(1).max(80),
    supportEmail: z.string().email().max(254),
    demoRecordingUrl: httpsUrl,
    countries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .min(1)
      .max(249),
  })
  .strict();
const input = process.argv[2];
if (!input) {
  console.error(
    "Pass a release settings JSON file containing public listing fields. See release/settings.example.json.",
  );
  process.exit(1);
}
let settings;
try {
  settings = schema.parse(JSON.parse(await readFile(input, "utf8")));
} catch {
  console.error(
    "Release settings are incomplete or invalid. Provide the real HTTPS origin, publisher, support email, recording URL and country codes. No package was created.",
  );
  process.exit(1);
}
const origin = new URL(settings.origin).origin;
const review = JSON.parse(
  await readFile(
    new URL("../release/review-cases.json", import.meta.url),
    "utf8",
  ),
);
const directory = await mkdtemp(join(tmpdir(), "drop-it-package-"));
try {
  const meta = {
    displayName: "Drop It",
    shortDescription: "Save ideas. Find them later.",
    longDescription:
      "Save supplied text, links and supported files to your private Drop It library. Find saved material, review original sources, edit notes, bookmark drops and restore items from seven-day Trash. Drop It does not automatically fetch web pages. An account is required.",
    developerName: settings.publisher,
    category: "Productivity",
    capabilities: [
      "Save supplied content",
      "Search your library",
      "Read original sources",
      "Organize drops",
    ],
    websiteURL: `${origin}/about`,
    supportURL: `${origin}/support`,
    privacyPolicyURL: `${origin}/privacy`,
    termsOfServiceURL: `${origin}/terms`,
    defaultPrompt: [
      "Save this idea in my library.",
      "Find my saved ideas about gardening.",
      "Show my bookmarked drops.",
    ],
    logo: "./assets/icon.svg",
    composerIcon: "./assets/icon.svg",
  };
  await mkdir(join(directory, ".codex-plugin"));
  await mkdir(join(directory, "assets"));
  await copyFile(
    new URL("../release/icon.svg", import.meta.url),
    join(directory, "assets/icon.svg"),
  );
  await writeFile(
    join(directory, ".codex-plugin/plugin.json"),
    JSON.stringify(
      {
        name: "drop-it",
        version: "0.1.0",
        description: meta.longDescription,
        author: { name: settings.publisher, email: settings.supportEmail },
        mcpServers: "./.mcp.json",
        interface: meta,
        extensions: {
          "com.openai": {
            review: {
              test_cases: review,
              demo_recording_url: settings.demoRecordingUrl,
              commerce: false,
            },
            publication: {
              countries: settings.countries,
              release_notes:
                "Initial release of a private saved-for-later library.",
            },
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(directory, ".mcp.json"),
    JSON.stringify(
      { mcpServers: { "drop-it": { url: `${origin}/mcp` } } },
      null,
      2,
    ),
  );
  // Archive only the three explicitly prepared files; never the repository.
  const outputDir = resolve("dist");
  await mkdir(outputDir, { recursive: true });
  if ((await lstat(outputDir)).isSymbolicLink())
    throw new Error("Output must not be a symlink.");
  const output = join(outputDir, "drop-it-plugin.zip");
  await rm(output, { force: true });
  execFileSync(
    "zip",
    ["-q", output, ".codex-plugin/plugin.json", ".mcp.json", "assets/icon.svg"],
    { cwd: directory, stdio: "pipe" },
  );
  console.log(
    "Created dist/drop-it-plugin.zip. Run the review cases in ChatGPT before submission; packaging does not verify the hosted service.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
