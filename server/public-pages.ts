import type { Express } from "express";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { renderAboutPage } from "./about-page.js";
import { renderInformationPage } from "./public-brand.js";

export const publicSiteSchema = z
  .object({
    publisher: z.string().trim().min(1).max(80),
    supportEmail: z.string().email().max(254),
    backupRetentionDays: z.number().int().min(0).max(365),
  })
  .strict();
export type PublicSite = z.infer<typeof publicSiteSchema>;
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const measurementChoice = `<aside class="wrap" aria-label="Optional ad measurement" id="ad-measurement" hidden>
  <div id="ad-measurement-choice" hidden>
    <p>Allow OpenAI ad measurement? If you complete a signup, we share the event and an ad-click reference with OpenAI. Your choice is optional and expires after seven days.</p>
    <button id="allow-ad-measurement" type="button">Allow measurement</button>
    <button id="skip-ad-measurement" type="button">Skip</button>
  </div>
  <button id="stop-ad-measurement" type="button" hidden>Turn off ad measurement</button>
</aside><script src="/ad-measurement-consent.js" defer></script>`;

export function addPublicPages(app: Express, site?: PublicSite, measurementEnabled = false) {
  if (measurementEnabled) {
    app.get("/ad-measurement-consent.js", (_req, res) => {
      res.sendFile(fileURLToPath(new URL("./ad-measurement-consent.js", import.meta.url)));
    });
  }
  // Only these fixed synthetic-data review assets are public, never library uploads.
  for (const filename of [
    "walkthrough-2026-10-03.mp4",
    "walkthrough-0.1.1-2026-10-16.mp4",
  ]) {
    app.get(`/review/${filename}`, (_req, res, next) => {
      if (!site) {
        res.status(404).end();
        return;
      }
      res
        .set("X-Robots-Tag", "noindex, nofollow")
        .sendFile(
          fileURLToPath(
            new URL(`../release/review/${filename}`, import.meta.url),
          ),
          { maxAge: "1d", dotfiles: "deny" },
          (error) => {
            if (error) next(error);
          },
        );
    });
  }
  const paths = ["/about", "/support", "/privacy", "/terms"];
  app.get(paths, (req, res) => {
    if (!site) {
      res
        .status(503)
        .type("text")
        .send("Public product information is not configured yet.");
      return;
    }
    const publisher = escape(site.publisher),
      email = escape(site.supportEmail);
    if (req.path === "/about") {
      res.type("html").send(renderAboutPage(publisher, measurementEnabled ? measurementChoice : ""));
      return;
    }
    const contact = `<a href="mailto:${email}">${email}</a>`;
    const pages: Record<string, { title: string; body: string }> = {
      "/support": {
        title: "Support",
        body: `<p>Contact ${publisher}: ${contact}.</p><p>Describe the issue and any non-sensitive error message. Do not email your password, recovery code, API key, private files or full library export.</p><p>To recover an account, use your saved recovery code on the sign-in screen. If you have a verified email, request a password reset code on the sign-in screen. Existing accounts without a verified email can still use their saved offline recovery code.</p><p>Settings provides library export and previewed import, storage usage, AI search preferences, password changes, recovery codes, session controls, app disconnection and permanent account deletion. All drops contains your created drops; Saved is a bookmark filter. New accounts verify an email before signing in. Existing users can add a verified email in Settings without changing their library or connected apps. When registration is closed, contact support to request access.</p>`,
      },
      "/privacy": {
        title: "Privacy",
        body: `<p>${publisher} operates Drop It. For privacy questions or requests, contact ${contact}.</p><h2>Information processed</h2><p>Drop It stores your username (for existing accounts), verified email if configured, password hash, sessions and connected-app credentials, recovery-code hash if enabled, and the material you explicitly save: text, links, original files, titles, summaries, tags, notes, bookmarks and associated dates. Passwords and recovery codes are not stored in readable form.</p><h2>How information is used and shared</h2><p>Your data provides your private library, search, account security and requested actions. The hosting and database providers process data to run the service. Infrastructure providers may process connection information and operational logs under their own policies. The application stores coarse browser labels for session management, not raw user agents or IP addresses.</p><p>When AI is enabled, drafting sends supplied content and supported files to OpenAI. AI search is off by default. If you enable it in Settings, a search can send your query and bounded text from up to 10,000 drops matching the selected view, pool, tag and dates to OpenAI for embeddings, including drops that do not contain the query words. Indexing for those filters can continue in the background after you leave the page; disabling AI search cancels queued work. This includes titles, summaries, tags, notes and source, retrieved page snapshots or reviewed transcription text; original images are not sent for search. Your preference also applies to connected apps. Manual capture and keyword-only retrieval do not require AI. OpenAI's applicable API retention policies govern its processing; disabling response storage does not itself guarantee zero retention.</p><p>The browser extension automatically drafts fields from the text you capture and retrieves a public page when readable text is unavailable. On the website, choosing Retrieve page &amp; suggest fields starts that retrieval. Public-page retrieval sends the public link to Firecrawl for readable page text and metadata. A bounded excerpt is sent to the configured AI draft provider to suggest fields. User cookies, authorization and private uploads are not sent to Firecrawl. Retrieved snapshots are stored separately from your originals and AI summaries, with source and capture time, and included in search and backups. Unsaved retrieval references expire after 24 hours. Manual link capture through the website and connected apps remains available without retrieval. Firecrawl processing follows its provider policies; disabling its cache does not promise zero retention.</p><p>When you connect ChatGPT, requested library results are shared with ChatGPT to fulfill your requests. Disconnecting revokes future access but does not erase material already present in a conversation or downloaded elsewhere.</p><p>If you link ChatGPT for sign-in, Drop It stores the verified OpenAI account identifier. If ChatGPT plan usage is available and you authorize it, Drop It stores encrypted access and refresh credentials server-side to perform your requested drafts. It does not receive your ChatGPT conversation history. Plan limits apply; these accounts use keyword search and do not fall back to the site API key. Disconnect the link in Settings and manage remote permissions in ChatGPT Settings. Password changes, recovery and sign-out-everywhere remove the local ChatGPT link; remote permissions can also be removed in ChatGPT.</p><h2>Retention and deletion</h2><p>Saved content remains until you remove it or delete your account. Trash becomes inaccessible after seven days; scheduled cleanup permanently removes expired drops and unreferenced originals. Account deletion removes account-owned content and credentials from the active database immediately. Configured database backups may retain deleted data for up to ${site.backupRetentionDays} days. Previously downloaded exports and copies outside Drop It remain under their holders' control.</p><h2>Your controls</h2><p>Use Settings to export your library, preview an import, disable AI search, manage sessions, disconnect apps, or permanently delete your account. Exports include original content; keep them private. Pending import previews are temporary and expire after 15 minutes. Review AI drafts before saving. Transcription corrections are stored separately from the original source. Contact support for other privacy requests. On a visit from a ChatGPT ad, you can choose to let Drop It share a completed registration event and the ad-click reference with OpenAI. If you opt in, a first-party cookie holds that reference for up to seven days. You can turn measurement off on the About page or clear the cookie. Your name, email, library content and credentials are not part of the event.</p><h2>Content limits</h2><p>Do not submit passwords, access keys, payment-card details, government identifiers or protected health information. Share only content you are entitled to provide. The service is not intended for children under 13.</p>`,
      },
      "/terms": {
        title: "Terms of use",
        body: `<p>Drop It is operated by ${publisher}. Questions: ${contact}.</p><p>Use Drop It only for lawful purposes and content you have permission to store and process. Keep your password and recovery code secure. Do not attempt to access other accounts, bypass limits or disrupt the service.</p><p>You retain your rights in your content. You permit the processing necessary to store it and perform actions you request, as described in the privacy policy.</p><p>AI-generated summaries, transcriptions, tags and source URLs may be inaccurate. Review them before relying on them. The browser extension can automatically retrieve public links as part of capture. Links saved manually through the website or connected apps are fetched only when retrieval is requested. Drop It is not a substitute for professional advice.</p><p>Uploaded originals are validated for supported formats, not certified malware-free. Keep independent copies of important material. Limits and supported features are described in the app; the service may be interrupted for maintenance or unavailable.</p><p>You may stop using the service, export your library, disconnect apps, and delete your account from Settings. These terms do not limit rights that cannot lawfully be waived.</p>`,
      },
    };
    const page = pages[req.path];
    res
      .type("html")
      .send(renderInformationPage(page.title, page.body, publisher, req.path));
  });
}
