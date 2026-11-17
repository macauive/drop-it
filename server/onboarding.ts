import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Database } from "./db.js";
import type { Config } from "./config.js";
import { extensionOrigin } from "../shared/extension.js";
import {
  onboardingActionSchema,
  onboardingSchema,
} from "../shared/onboarding.js";

export const extensionArchive = fileURLToPath(
  new URL("../dist/drop-it-chrome.zip", import.meta.url),
);

export class Onboarding {
  constructor(
    private db: Database,
    private config: Config,
  ) {}

  async extensionAvailable() {
    if (!this.config.redirectUris.some((uri) => extensionOrigin(uri)))
      return false;
    try {
      const manifest: unknown = JSON.parse(
        await readFile(
          new URL("../dist/chrome-extension/manifest.json", import.meta.url),
          "utf8",
        ),
      );
      if (
        !manifest ||
        typeof manifest !== "object" ||
        !("host_permissions" in manifest) ||
        !Array.isArray(manifest.host_permissions) ||
        !manifest.host_permissions.includes(`${this.config.origin}/*`)
      )
        return false;
      await access(extensionArchive);
      return true;
    } catch {
      return false;
    }
  }

  async status(owner: string) {
    const [state, first, grants, extensionAvailable] = await Promise.all([
      this.db.query<{
        dismissed: boolean;
        found: boolean;
        websiteOnly: boolean;
      }>(
        `SELECT onboarding_dismissed AS dismissed,onboarding_found AS found,
        onboarding_website_only AS "websiteOnly" FROM users WHERE id=$1`,
        [owner],
      ),
      this.db.query<{ id: string; title: string }>(
        "SELECT id,title FROM items WHERE owner=$1 AND trashed_at IS NULL ORDER BY created_at,id LIMIT 1",
        [owner],
      ),
      this.db.query<{ redirects: unknown; scopes: string[] }>(
        `SELECT c.data->'redirect_uris' AS redirects,t.scopes FROM oauth_tokens t
        JOIN oauth_clients c ON c.id=t.client_id WHERE t.owner=$1
        AND t.kind IN ('access','refresh') AND t.expires_at>clock_timestamp()`,
        [owner],
      ),
      this.extensionAvailable(),
    ]);
    const connections = { extension: false, chatgpt: false };
    for (const grant of grants.rows) {
      if (!Array.isArray(grant.redirects)) continue;
      for (const uri of grant.redirects) {
        if (typeof uri !== "string" || !this.config.redirectUris.includes(uri))
          continue;
        if (extensionOrigin(uri) && grant.scopes.includes("capture:write"))
          connections.extension = true;
        if (
          new URL(uri).origin === "https://chatgpt.com" &&
          grant.scopes.includes("library:read")
        )
          connections.chatgpt = true;
      }
    }
    return onboardingSchema.parse({
      ...state.rows[0],
      firstDrop: first.rows[0] ?? null,
      connections,
      extensionAvailable,
      chatgptAvailable: this.config.redirectUris.some(
        (uri) => new URL(uri).origin === "https://chatgpt.com",
      ),
    });
  }

  async act(owner: string, input: unknown) {
    const { action } = onboardingActionSchema.parse(input);
    if (action === "dismiss" || action === "reopen") {
      await this.db.query(
        "UPDATE users SET onboarding_dismissed=$2 WHERE id=$1",
        [owner, action === "dismiss"],
      );
    } else {
      await this.db.query(
        "UPDATE users SET onboarding_website_only=$2 WHERE id=$1",
        [owner, action === "use-website"],
      );
    }
    return this.status(owner);
  }

  async found(owner: string) {
    // Only called after an authenticated, nonempty search returned an active
    // owned item. Clients cannot submit completion flags or another owner ID.
    await this.db.query(
      `UPDATE users SET onboarding_found=true
      WHERE id=$1 AND NOT onboarding_dismissed AND NOT onboarding_found`,
      [owner],
    );
  }
}
