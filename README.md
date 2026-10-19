# Drop It

A private saved-for-later library with a React interface and a ChatGPT-compatible MCP server. Save screenshots, text and links; search them later; preserve the source while editing summaries and notes.

## Run locally

Requires Node.js 22.13.0 or newer.

```sh
npm ci
npm run dev
```

Open http://localhost:4317 and create your owner password (15–128 characters). No AI API key, cloud database, or Docker is required. The password is hashed with Node's scrypt using explicit N=32768, r=8, p=3 parameters; existing legacy hashes upgrade after a successful login. Sessions use HTTP-only cookies. Owner setup is allowed only from loopback while PUBLIC_URL is local. Public signup is disabled by default. `ACCOUNT_MODE=public` enables username-based sign-in; `ALLOW_SIGNUP=true` enables registration. See the release preparation section before exposing signup.

`npm run dev` builds the UI once and watches server files. After UI edits, run `npm run build:web` and restart the server to load the new bundle. For a normal run after building, use `npm start`.

Configuration is read from `private/.env` when present; a root `.env` is not loaded. Existing process environment variables take precedence. `.env.example` contains only safe placeholders. Keep the private directory owner-only (mode 700) and its env file owner-readable/writable only (mode 600). Data lives in `.data/postgres` by default. Back up that directory while the app is stopped. Never commit `.data`, env files, uploads, personal records, or credentials. `.gitignore` and `AGENTS.md` are deliberately local-only.

## Implemented

This inventory describes the current source. Deployment and live-host evidence are recorded separately in [release verification](release/verification-2026-10-01.md), the [ChatGPT checklist](release/chatgpt-verification-checklist.md), and the [operations runbook](release/operations-runbook.md).

- Local owner setup, password login, password changes, one-time recovery codes, expiring browser sessions, individual session revocation and sign out everywhere. The library reminds users who have no recovery code; dismissal lasts until the next sign-in.
- OAuth authorization-code flow with PKCE, exact redirect allowlists, rotating refresh tokens with family revocation on replay, scope checks and revocation using the official MCP SDK. Disconnecting also invalidates previously approved authorization codes.
- Text/link capture, clipboard-image paste, and private PNG/JPEG/WebP, PDF, TXT, Markdown, CSV and JSON uploads (10 MiB per file; 250 MiB per-owner attachment quota by default). Images are limited to 25 megapixels, PDFs to 30 unencrypted pages, and UTF-8 text files to 50,000 characters. Unsupported formats, invalid content and filename traversal are rejected.
- Original sources stored independently of editable drops; multiple drops may reference one source. Source URLs retain their fragments and hash routes. A separate normalized URL, without its fragment, is used to warn about duplicate sources.
- All drops contains created drops outside Trash. Saved is a bookmark filter, not a lifecycle status; yellow ribbons toggle bookmarks. New drops are created unbookmarked.
- Keyword search across titles, summaries, effective transcription, URLs, tags and notes; visible pool/view/tag/creation-date controls; pagination and match labels/snippets. Search options offer keyword-only and AI retrieval methods. AI search is off until the account explicitly enables it in Settings.
- File-first capture automatically drafts a title, summary, category, tags and transcription after upload when AI is configured. Review the transcription and source link before creating the drop, or choose Text or link / Enter manually to enter details yourself. Website screenshots can propose a clearly visible source URL; it remains editable before saving and is never fetched automatically.
- Optional hybrid search combines literal and meaning-based matches using owner-scoped embeddings and the same filters. It can index excerpts from every eligible drop in those filters, including content that does not match the query; see AI privacy below.
- Flexible owner-scoped category names with existing-category suggestions, case-insensitive reuse and filtering. Existing labels are preserved; new uncategorized saves use `Uncategorized`.
- Source/URL duplicate warnings with links to the owner's existing drops, explicit duplicate override, idempotent saves and optimistic edit/delete revisions. Dirty capture/detail forms ask before discarding work. Conflicts retain local edits while the user loads and compares the latest saved version; bookmarking does not close metadata editing.
- Source image viewing, authenticated original-file downloads, collapsible original transcription, notes, and a separate editable reviewed transcription with its update time. Retrieval uses the reviewed text when present; resetting it restores use of the preserved original text. Original file bytes and original source text remain unchanged.
- Portable streaming v3 backups and preview-before-apply import of v3 or legacy v2 exports, including original bytes, source relationships, timestamps, bookmarks and unexpired Trash. See Backup and restore below.
- Wipe drop moves a drop to Trash for seven days. Restore preserves its bookmark and cancels deletion; wiping it again starts a new window. Repeated wipes while already in Trash do not reset the deadline. Expired drops cannot be read, restored, downloaded or exported. Cleanup runs at startup and hourly while the server is running, permanently removing expired drops and only unreferenced sources/files. Offline cleanup resumes on next startup.
- Migration leaves existing drops unbookmarked and gives formerly archived drops a fresh seven-day Trash window. In progress and Done are removed.
- MCP tools with structured result schemas and a React widget using the MCP Apps bridge. The widget initializes from the model's actual search, detail or unsaved draft result, retains filters for paging, and queues incoming results while a form is open. It adapts to host theme, inline/fullscreen capabilities and reconnect errors. Tools remain useful without the widget; file-upload/profile results do not open an unrelated library widget.
- Expired credential and abandoned-upload cleanup.
- Light and dark themes: the standalone app follows the system preference on first paint and updates while open; the ChatGPT widget follows its host's theme. Both use the same near-black dark palette.
- Standalone Settings with backup/import, attachment/text/drop usage, an active/Trash/unattached/expired-original breakdown, owner-scoped connected-app count and confirmed disconnect-all, account-wide AI search preference, capture/help links and the fixed seven-day Trash policy. Configuration status does not verify OpenAI credentials or credit; API keys are never sent to the browser. Embedded widgets do not expose browser-session settings, backup/import or account-preference controls.
- A web app manifest and a text/link share target prepare an unsaved draft on supporting installed browsers. The optional service worker does not cache private pages, responses, files or drafts; this is not offline library support.

The standalone UI supports AI-assisted drafting and manual entry. Inside ChatGPT, the host model can supply metadata directly or request `draft_drop`. Saving or drafting a URL does not fetch its page. Source content is untrusted data, never instructions.

In New drop, use **Text or link**, select/drop a supported file, or paste an image from the clipboard. To avoid automatic file drafting, enter manual mode before choosing the file. **Settings → Prepare mobile sharing** registers the minimal service worker; use the browser's Install app or Add to Home Screen control if available. Share targets depend on browser and operating-system support and accept text/links, not shared files. A share only prepopulates a draft: sign-in and an explicit create action are still required. Physical-device share-sheet behavior remains a release verification task.

### Account security and recovery

Open Settings to change your password, generate a recovery code, review active browser sessions, or sign out everywhere. Each change requires your current password. New passwords must have 15–128 characters; existing shorter passwords remain usable for login and reauthentication. This follows [OWASP's guidance for password-only authentication and sensitive account changes](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

Save your recovery code in a password manager or another secure offline location. The app shows it once and stores only its hash. Generating another code immediately invalidates the previous one. If you forget your password, select **Forgot password?** on the login screen and enter your code with a new password. Offline recovery does not require email. The code works once. Accounts with a verified email can also request an email password reset from the sign-in screen.

Changing or recovering your password revokes every browser session, connected-app token and approved OAuth code, and invalidates the recovery code. Sign in again and generate a new recovery code afterward. **Sign out everywhere** also revokes browser sessions and app connections but preserves your recovery code. These actions preserve saved library data. An individual session can be ended without affecting other sessions or connected apps.

The session list shows a coarse browser/device label and creation, last-active and expiration times. Labels are informational and do not establish device identity. Raw user agents and IP addresses are not stored. Browser sessions expire after seven days. The list shows the current browser and up to 49 other active sessions; each login retains at most 50 sessions. Older installations keep existing sessions during migration, and sign out everywhere also revokes any older sessions beyond the displayed limit. Account-security controls are available only in the standalone browser app, not through MCP tools or the ChatGPT widget. Sensitive requests recheck the current session under the same database lock used for credential changes. Sign-in/recovery attempts and authenticated security changes have separate rate limits; the in-memory limiters apply per server process.

### AI configuration and privacy

The app reuses its existing server-side OpenAI configuration; no new key, project or provider is needed for these features. For a fresh local installation only, configure `OPENAI_API_KEY` in the ignored `private/.env` and restart. The key stays server-side. Drafts use the Responses API with `store: false`, strict structured output and `gpt-5.6-luna` by default (`OPENAI_MODEL` can override the draft model). A draft processes up to the first 16,000 source-text characters, the URL without query/fragment, up to 100 existing category names, and an owned image resized to fit 1536 x 1536 or the complete validated PDF via [Responses file inputs](https://developers.openai.com/api/docs/guides/file-inputs). PDF page images and text can increase API usage. No tools or URL fetches are available to the model. Generated summaries, transcriptions (up to a 12,000-character excerpt), and detected source URLs are suggestions to review. The complete original file is preserved separately. A website logo or title alone is not sufficient to infer its source URL. Supplied manual URLs take precedence. Drafting never creates a drop, and typed source text is not overwritten by a draft.

Text files are decoded as UTF-8, never rendered as HTML or executed; JSON is parsed for validity. Original files download as attachments with `nosniff` and a sandbox CSP. Image validation allows at most two concurrent decodes per process. PDF.js validates PDFs in a worker with a 10-second time limit, a bounded JavaScript heap and at most two concurrent checks per process. This validation is not malware scanning; treat downloaded originals as untrusted. The widget uses host-mediated downloads when supported; otherwise it opens the same drop on the standalone website, where normal login and ownership checks apply. The October 1 ChatGPT host required this fallback. See the release verification report for browser-download limitations.

AI search is **off by default**, including for existing accounts migrated to the new preference. Enable it explicitly in the standalone account's Settings. That choice applies to the website and connected MCP clients. A semantic/hybrid request while it is disabled returns keyword results with a notice. Turning it off clears the owner's cached embeddings; it cannot recall content already processed by the provider. Drafting is a separate operation and is not disabled by the search preference.

When enabled, AI search sends the query and may index bounded excerpts from **all drops eligible under the selected view, pool, tag and date filters**, not just drops that contain the query. These excerpts can include unrelated private notes and transcription. Each indexed text contains the title, summary, category, tags, up to 1,000 note characters and 4,000 effective-transcription characters, capped at 6,000 characters total. The model is OpenAI's `text-embedding-3-small` at 512 dimensions. Raw screenshots are not sent for search. Reviewed transcription replaces original transcription for indexing when present. Embeddings are cached in the database, isolated by owner, invalidated on content edits and removed on deletion. Retrieval returns actual saved records, not a generated answer. Semantic matching uses cosine similarity with a minimum score of 0.2; this is a heuristic, not calibrated confidence. In hybrid mode literal matches rank first and results are deduplicated before pagination. Result labels distinguish text and related-meaning matches.

Query text is explicitly submitted; changing an applied search filter can rerun the search. The initial index may take longer; unchanged items reuse cached vectors. At most 1,000 filtered drops are considered for AI ranking. Hybrid search falls back to keyword results with a visible notice when AI is unavailable, fails, or the filtered library exceeds that limit. Indexing is batched and can resume from cached batches after a timeout. AI operations allow one concurrent request and 20 starts per minute per owner, plus defaults of four concurrent operations and 120 starts per minute across the running service instance. These process-local operation counts are not a dollar or token budget. Failed drafts are never saved automatically. `store: false` does not itself mean zero provider retention; the project's OpenAI data policies still apply. API calls incur usage charges. Manual entry and keyword-only retrieval make no OpenAI request. The API still defaults to `hybrid`, subject to the account's explicit opt-in; clients can always request `mode: "keyword"`.

The current AI setup uses Responses for drafting and embeddings for search; no Decisions API integration is needed.

## Storage

Local development uses PGlite, an embedded Postgres engine persisted on disk. Set `DATABASE_URL` to use a standard Postgres server via `pg`; use your provider's verified TLS configuration. Both adapters share parameterized SQL and transactions. PGlite is single-process: run only one app instance against a local data directory.

Original file bytes are stored in private Postgres `bytea` records. This keeps ownership checks, import and shared-source deletion transactional and avoids an additional account. Do not deploy PGlite on ephemeral serverless disk.

Default admission limits are 250 MiB of original attachments, 10,000 drops and 25 MiB of stored UTF-8 text per owner, plus 3 GiB of original attachments across the service. Text accounting includes metadata, reviewed transcription, source text/URLs and extracted attachment text. Limits count Trash and expired content awaiting cleanup; attachment limits also count unattached uploads. Shared originals count once. Settings exposes the owner's usage and breakdown, and capture checks remaining attachment space. Discarding a standalone capture attempts to release its unreferenced upload immediately; otherwise abandoned uploads expire after 24 hours. Moving a drop to Trash does not immediately free its file bytes.

Database-backed capacity checks serialize imports/uploads across owners. Aggregate attachment capacity is not a total database-disk limit: indexes, WAL, text and database overhead still need headroom. AI limits remain process-local. Configuration names, concurrency assumptions, alerts, bounded PostgreSQL waits and recovery procedures are in the [operations runbook](release/operations-runbook.md). The intended deployment stays at one service instance until shared AI enforcement and representative load verification are available.

### Backup and restore

**Settings → Backup & restore → Download portable backup** streams a v3 `.ndjson` archive through the browser's normal download flow. It includes drop/source metadata, original creation/update and transcription-review times, revisions, notes, bookmarks and unexpired Trash. Each distinct attachment is exported once in chunks of at most 64 KiB, with its byte count and SHA-256 hash. A final completion record checks the archive's preceding records. The server emits bounded records and the UI uses a native download instead of loading the complete archive into a JavaScript blob. This avoids the old JSON export's source-sharing amplification limit. Export reads a consistent database snapshot and excludes expired Trash; one portable export runs at a time per instance. The five-minute response budget and database deadlines still apply. If a client stalls or the connection fails, retry the download; an incomplete archive is rejected during import.

Upload that `.ndjson`, or an older v2 `.json` export, and select **Preview import**. The server parses incrementally, validates the format and supported original-file contents, verifies v3 checksums, checks references and owner/service capacity, and shows counts, existing-source warnings and expired-Trash exclusions. The transfer limit is 512 MiB, sufficient for the default permitted library; raising library limits does not raise this archive limit automatically. Preview uses private temporary files, not a write to the library. At most two previews are retained per instance and one per owner, each for 15 minutes. Cancel discards it. Expired leftovers after a crash are cleaned when the server is running again. Legacy v2 lacks stored integrity checksums; it is content-validated and new checksums are computed, without claiming historical integrity verification.

Only **Import … drops as copies** applies a preview. Apply remaps ownership and record IDs to the signed-in account, rechecks capacity, and commits files, sources, drops and its retry receipt in one transaction. Existing drops are never overwritten; apparent duplicates are explicitly imported as copies. Original bytes, safe source URLs, metadata, timestamps, bookmark state and reviewed transcription survive. Unexpired Trash retains its original seven-day deletion deadline; drops that have expired by apply time are skipped with their otherwise-unreferenced sources/files. A failed transaction rolls back completely. Retrying the same confirmed preview/request ID returns the earlier result without adding copies, including after a server restart. Uploading the archive again creates a new preview and is a separate import.

Legacy `/api/export` remains available as JSON v2 for compatibility, with its conservative 384 MiB serialized-size cap and repeated file bytes per source. It writes paged metadata and bounded file chunks to a private temporary file instead of buffering the complete archive. The consistent read-only snapshot finishes before the file is streamed to the browser with backpressure; a five-minute deadline covers preparation and delivery. Temporary files are removed on completion or failure. Files abandoned by a process crash are cleaned on a subsequent legacy export after twenty minutes. It is no longer the Settings backup flow. Neither format includes account credentials, sessions, connected-app tokens or AI embeddings. Treat downloaded archives as private originals. This self-service import restores library content; it does not replace an operator's database/account disaster-recovery procedure.

## Connect ChatGPT

The local app is usable now. An actual ChatGPT connection additionally requires a reachable HTTPS endpoint and configuration in your ChatGPT account.

1. Create your owner locally before exposing the service. Preserve the same database when changing PUBLIC_URL.
2. Choose a persistent host or development tunnel. Set `PUBLIC_URL` to its exact HTTPS origin. A reverse proxy must preserve that Host header. The app defaults to loopback; with an HTTPS public origin it listens on all interfaces.
3. Add the MCP URL `https://<your-host>/mcp` in ChatGPT's developer connection settings. Choose OAuth with dynamic registration and a public client (`token_endpoint_auth_method: none`).
4. Copy the exact OAuth callback URI shown by ChatGPT into `OAUTH_REDIRECT_URIS` in your local/deployment environment. Multiple exact callback URIs can be comma-separated. Unconfigured callbacks are rejected; there are no wildcard redirects.
5. Restart, complete account linking, sign in with your owner password, and approve the requested read/write scopes.
6. Ask ChatGPT to save a drop, then retrieve it from a new conversation. For a screenshot, preserve it with `upload_source`, then pass its returned `attachmentId` to `save_drop`. The model supplies the transcription/summary separately.

File import accepts HTTPS downloads only from the exact hosts `files.oaiusercontent.com` and `oaisdmntprcentralus.blob.core.windows.net` (observed in ChatGPT's live file binding). Other Azure accounts, redirects, and arbitrary external fetches are blocked. If a host supplies another legitimate file service, verify it and update the allowlist deliberately. Temporary download URLs are never saved or logged; a rejected-host error includes only its hostname. If file transfer is unsupported in a host, the standalone UI can upload the original file directly.

Backup/import are standalone account features and are not exposed as model tools. Settings can disconnect all MCP app connections without deleting saved drops. The current widget applies model search/detail/draft results directly and preserves pending edits when later results arrive. It stores only the non-sensitive library-view choice as host widget state; queries, draft/source text, record IDs, files and credentials are not persisted there.

Live ChatGPT account linking and its file-transfer path must be verified in the user's account after an HTTPS endpoint is configured. Local protocol tests do not substitute for that final integration check.

## MCP tools

| Tool            | Purpose                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `search_drops`  | Search/filter the authenticated owner's library                                                                                    |
| `draft_drop`    | Propose editable metadata, transcription and a visible source URL through OpenAI; requires read and write scopes but does not save |
| `get_drop`      | Read a drop and immutable source; original file bytes are widget-only metadata                                                     |
| `save_drop`     | Create an unbookmarked drop; requires a retry-stable UUID                                                                          |
| `update_drop`   | Edit title, summary, tags, notes, category, bookmark or reviewed transcription using the current revision                          |
| `wipe_drop`     | Move a drop to Trash for seven days using the current revision                                                                     |
| `restore_drop`  | Restore a drop before its Trash deadline, preserving its bookmark                                                                  |
| `upload_source` | Preserve an explicitly supplied supported ChatGPT file                                                                             |
| `get_profile`   | Return the stable authenticated owner ID and private account nickname when available                                               |

The `save_drop`, `update_drop`, `restore_drop`, and `draft_drop` tools require both `library:read` and `library:write` because they return or process existing content. `upload_source` and `wipe_drop` require write scope; read tools require read scope.

The pre-launch tool rename uses the drop names above without exposing duplicate legacy tools. After an authorized deployment, refresh tools in the existing ChatGPT plugin and start a fresh tool call. The current widget resource is `ui://drop-it/library-v5.html`; older rendered widgets may need to be reopened. Tool/output-schema tests and synthetic-host checks do not establish that the new resource passed the real host. Follow the [ChatGPT verification checklist](release/chatgpt-verification-checklist.md) using the dedicated reviewer account, preserving its existing samples and the owner's separate connection.

## Development and checks

The automated `tests/*.test.ts` suite, its PDF helper, and synthetic PDF fixtures are versioned so a fresh clone can run `npm ci` and `npm run check`. GitHub Actions runs the same checks on pull requests and release-branch pushes without production credentials. Optional browser harnesses, live-AI checks, and screenshots remain local-only; those additional commands require their local scripts. The local `.gitignore` remains untracked.

```sh
npm run check
npm run format
```

Checks include ESLint, TypeScript, the production widget build, real HTTP API tests, password changes, one-time recovery, browser-session revocation, OAuth token exchange, an official SDK MCP client, durable database reopening, input/file validation, cross-owner isolation, shared-source cleanup, AI preference/capacity boundaries, reviewed transcription, MCP output/host-state contracts and portable import/export integrity, rollback and retries. Tests use temporary databases and generated credentials; they never read your library. `npm run check` runs `tests/*.test.ts`; optional browser harnesses and actual ChatGPT/device checks are separate evidence.

Run `npm run test:postgres-auth` after building for the additional PostgreSQL 16 auth checks. Install PostgreSQL 16 and, when needed, set `DROP_IT_PG_BIN` to its binary directory. The suite creates a temporary cluster with a private Unix socket, no TCP listener and an unprivileged application role. It never loads environment files or connects to a hosted database. It tests concurrent signup/link/reset claims across pools, durable attempt limits across restart, deletion, process termination during mail delivery, dump/restore and repeated migration, preserved legacy libraries and credentials, and startup/login/shutdown through the production entry point. The normal suite also tests certificate-validated loopback HTTPS ingress, secure cookies, origin/host enforcement and preserved MCP access.

Use the in-app browser for visual verification. Check desktop and mobile layouts, setup/login, screenshot upload, source display, editing, search, export, deletion and keyboard focus.

Additional pre-commit checks:

- `tests/uploads.test.ts` includes encrypted PDFs (including an empty viewing password), image-only scans, simulated parser timeout recovery, concurrent validation limits and exact page/text boundaries. Synthetic PDF fixtures are versioned; regenerating them with `tests/generate-pdf-fixtures.py` requires Pillow, ReportLab and pypdf with AES support, not production runtime dependencies.
- `DROP_IT_LIVE_AI=1 npx tsx tests/live-ai-checks.ts` runs paid, opt-in checks with the configured project key against synthetic screenshots and a scanned PDF. It checks missing, brand-only, truncated and ambiguous URLs, address-bar precedence and scan transcription. A passing sample is not a guarantee against model errors; source URLs still need review.
- `DROP_IT_BROWSER_TEST=1 node --import tsx tests/browser-recovery.ts` starts a separate loopback-only, automatically authenticated test instance with a temporary database and mocked AI. It never loads your environment or library. Its first draft fails with a rate limit, second with a simulated timeout, third succeeds, and fourth times out for manual-save verification. `GET /__test/state` shows only test counts. Stop it gracefully with Ctrl-C to remove the temporary data. Never deploy this test harness.

When local PostgreSQL binaries are installed, `node --import tsx tests/postgres-security.ts` additionally tests the `pg` adapter in a disposable cluster with TCP disabled.

For legacy export changes, `node --import tsx tests/postgres-legacy-export.ts` checks pagination, original bytes and ownership after a stalled download. After building, `node --import tsx tests/legacy-export-http-memory.ts` checks a near-limit JSON v2 export through HTTP and measures the separate server process's peak resident memory. Both use disposable PostgreSQL 16 fixtures and synthetic content without loading environment files or your library; the memory check measures its host process rather than imposing Render's container memory limit.

## Deliberate limits

- Defaults to private, single-owner onboarding. A public deployment and earlier core-flow evidence are recorded, but the current changes still need their own deployment and live-host verification. Signup remains deliberately closed; no billing, shared collections or team invitations.
- No browser extension, Apple Notes import, reminders, automatic webpage scraping or offline library cache. The text/link share target depends on actual installed-browser support; it is not a native mobile share extension.
- No MFA or passkeys. Keep your password, verified email account and offline recovery code secure.
- Backups may retain deleted content until you rotate them; export files contain your original private content.
- OAuth/password accounts have local protocol/security coverage and earlier hosted evidence. Fresh reviewer scenarios, walkthrough recording, ordinary download clicks, physical mobile/share-sheet behavior, provider alerts/load evidence, support-mail delivery and managed recovery/cutover remain explicit release gates. See the [ChatGPT checklist](release/chatgpt-verification-checklist.md) and [operations runbook](release/operations-runbook.md). GitHub CI/billing remain deferred; the app must stay unsubmitted and unpublished until separately authorized.

## Design references

The MCP transport and resource wiring follow OpenAI's small to-do quickstart, adapted to authenticated durable storage and a React widget. The official example collection was inspected; no showcase app was copied wholesale.

- https://developers.openai.com/plugins/build/app-quickstart
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/reference
- https://github.com/openai/openai-apps-sdk-examples

## Release preparation

The current changes are prepared locally. Earlier hosted verification is recorded separately; it is not evidence that this checkout is deployed or approved by ChatGPT. Existing data directories and secrets are not modified by build or test commands.

### Accounts and migration

- Default `ACCOUNT_MODE=private` preserves password-only local owner access.
- `ACCOUNT_MODE=public` enables private usernames (3–40 ASCII letters/numbers/underscores/hyphens, normalized to lowercase). The original owner signs in as `owner` with the existing password. That name cannot be registered. Existing ownership UUIDs, sessions and library records survive database migration 8.
- `ALLOW_SIGNUP=false` is the default. Existing public accounts can still sign in when signup is closed. A new empty hosted database has no accounts until an administrator provisions one or signup is deliberately enabled; the local-only setup endpoint remains unavailable remotely.
- New self-service accounts use verified email and password. Registration sends a six-digit code with a ten-minute lifetime; verification requires both the code and the chosen password. No account or session is created until verification succeeds, and users then sign in normally.
- Existing username/password and original `owner` sign-in remain valid. In Settings, an existing user can add and verify an email using their current password. Migration 11 and email linking retain ownership UUIDs, password hashes, libraries, browser sessions, OAuth grants and ChatGPT connections. Emails are not inferred from usernames or ChatGPT identities, and accounts are never automatically merged by email.
- Email reset uses a single-use code, allows three attempts, and requires a new password. Successful reset preserves library content but signs out all browsers, revokes OAuth/ChatGPT credentials and clears outstanding recovery challenges, like existing offline recovery. Linking an email does not revoke connections. Verified emails cannot currently be changed in the UI.
- Offline recovery codes remain available as a backup. Existing accounts without an email must use their password or saved recovery code; no email is fabricated for them.
- Migration 9 adds account-wide AI-search opt-in (initially off), reviewed-transcription provenance, a separate normalized source-URL key, capacity coordination and import receipts. It preserves existing original text/files and account identities. Previously discarded URL fragments cannot be reconstructed automatically.
- Permanent account deletion requires a live session, the current password, same-origin POST and exact `DELETE` confirmation. It removes only that owner's active database content and credentials in one transaction. If any step fails, the transaction rolls back. Existing external exports and backup copies are unaffected.
- Moving from embedded PGlite to hosted PostgreSQL is a separate data migration. Do not point `DATABASE_URL` at a new database and assume the local library transferred. Keep the local instance and an offline backup until an explicit migration and reconciliation have passed. Never upload the `.data` directory as application source.

### Render deployment

For the first hosted account while signup is closed, use the service's authenticated Render Shell after deploying the account command. Run `npm run account:create`, confirm the displayed site origin, then enter a new username and a password of 15–128 characters directly in the terminal. Password input is hidden; do not put it in a command, environment variable, chat or screenshot. This operator-only command creates an empty library using the service's existing database connection. It does not overwrite an existing username, issue sessions, migrate local data or enable signup. Sign in at the site and generate an offline recovery code in Settings. The command requires an interactive terminal and an already-migrated hosted database. It is provided for the native Render deployment; the Docker image does not bundle operator scripts.

`render.yaml` manages one Node service (2 GB) and a private-network PostgreSQL 16 database with 5 GB disk. These resources were provisioned on September 30, 2026; Render confirmed an estimated $32.50/month base ($25 server + $6 database + $1.50 storage), excluding AI, domain, taxes and usage overages. The canonical origin is `https://dontdropit.app`, with deployment source `main`. Public signup requires verified email; automatic code deploys and disk autoscaling are disabled. Blueprint configuration changes can still sync and trigger a deployment. Capacity under production load is unverified.

The recorded October 1 baseline passed hosted checks for HTTPS, `/ready` (including PostgreSQL), closed-signup configuration, public information pages, authenticated ChatGPT text workflows, and screenshot upload, AI transcription, save, and original-image retrieval. See [release verification](release/verification-2026-10-01.md) for tested deployments and remaining limits. That run observed external database connections blocked and a three-day point-in-time recovery window configured. A logical export was restored into isolated local PostgreSQL and application reads and attachment hashes passed. Recorded logical-export retention was seven days; the public disclosure used that longer period. Recheck actual provider settings before launch. A managed point-in-time recovery/cutover drill remains untested. The local account and library have not been migrated.

- Render supplies `RENDER_EXTERNAL_URL` for initial HTTPS operation. Set `PUBLIC_URL` to the final exact origin when adding a custom domain. Configure only the canonical custom domain so health checks use the expected Host header.
- `DATABASE_URL` is supplied from the managed database; public production mode refuses embedded ephemeral storage. Use the internal connection string in the same region, and keep external database access disabled. For any external database connection use verified TLS, never disable certificate verification.
- `TRUST_PROXY_HOPS=1` is prepared for the managed ingress. Verify the forwarding chain with synthetic requests before launch; do not expose the Node port directly or trust arbitrary client forwarding headers.
- Per-owner and aggregate AI concurrency/rate limits and HTTP limits are process-local. Attachment capacity coordination is database-backed. The deployment intentionally uses one instance. Add shared AI enforcement and load testing before horizontal scaling. Operation limits are not a dollar spending cap: verify the existing OpenAI project's usage alerts and controls before opening signup; this implementation does not change provider billing settings.
- `/health` checks the process; `/ready` also queries PostgreSQL and returns only a success/failure flag. Render uses `/ready` to gate deployment and monitor the process. Configure deployment/error alerts in the account and verify restart behavior.
- Confirm the actual backup/PITR retention and exercise restoration to a separate database before launch. Do not claim backups are working from configuration alone.
- A portable Dockerfile is included; its allowlisted build context excludes env files, private data, Git history, tests and uploads. The container itself has not been built or deployed here.

### Public pages and domain verification

Set `PUBLIC_PUBLISHER_NAME`, `PUBLIC_SUPPORT_EMAIL`, and the verified `BACKUP_RETENTION_DAYS` to enable `/about`, `/support`, `/privacy`, and `/terms`. Until then these routes return 503 instead of invented publisher details. Review the drafted policy wording against the real hosting configuration before publishing. Remote public signup requires these settings. The support address must actually receive mail; buying a domain does not create a mailbox.

Copy the exact OpenAI portal challenge to `OPENAI_APPS_CHALLENGE` when requested. `/.well-known/openai-apps-challenge` serves it as plain text, or returns 404 when unset. Configure exact `OAUTH_REDIRECT_URIS` from ChatGPT; the repository does not guess them.

### Preflight and submission package

```sh
npm run release:preflight
npm run release:package -- private/release-settings.json
# Prepare an explicitly named draft before the walkthrough video is ready:
npm run release:package -- private/release-settings.json --draft
```

Preflight reports configuration presence only, without secret values or live API calls. It exits unsuccessfully while release settings are missing. Copy `release/settings.example.json` to a local file and enter the real public origin, verified publisher name, support address, walkthrough recording URL and desired country codes. The example intentionally cannot produce a package.

The package command creates the next plugin version, `0.1.1`, in `dist/drop-it-plugin.zip` from an explicit six-file allowlist: the manifest, remote MCP configuration, icon and three skill entrypoints. Skill inputs must be regular files with no symlinked path components. Draft mode writes `dist/drop-it-plugin-draft.zip` and permits an omitted walkthrough video; the full package still requires it. Both modes exclude server source, env files, credentials and library content. Reviewer credentials are entered separately in the OpenAI dashboard, never added to this JSON or ZIP. The package command is not evidence that the endpoint, pages, video or publisher verification are ready.

The manifest declares `skills: "./skills/"` and bundles three workflows around the existing MCP tools:

- [Capture content](skills/capture-content/SKILL.md): preserve supplied originals, check duplicates, review optional AI metadata, and save or bookmark when requested.
- [Research your library](skills/research-library/SKILL.md): retrieve relevant drops and synthesize a brief with source citations and explicit evidence gaps.
- [Organize your library](skills/organize-library/SKILL.md): inspect pools, tags and bookmarks, propose broad changes, and apply authorized edits using current revisions.

Verify the skills in a fresh chat after installing or uploading the updated package. Representative requests include “Save this idea in Drop It,” “What does my saved research say about gardening?” and “Review my pools and suggest a simpler structure.” Also check duplicate capture, URL-only sources, unavailable file contents, paginated research, tag preservation, concurrent-edit conflicts, and cleanup requests that do not authorize deletion. Local validation and ZIP inspection do not prove host activation or live workflow behavior. These skills are packaged files; deploying the backend alone does not install them. See [OpenAI skills guidance](https://developers.openai.com/plugins/build/skills).

`release/review-cases.json` contains five positive and three negative review scenarios, not completed test results. The [ChatGPT checklist](release/chatgpt-verification-checklist.md) adds current widget, privacy and reliability cases. Run authorized checks using the dedicated reviewer account, preserving its existing samples and keeping the owner's separate connection intact. Use synthetic content for cross-conversation retrieval, screenshot transfer, edits and Trash/restore. Physical desktop/mobile interaction, the walkthrough, current publisher/domain and tool-contract verification, and a fresh scan for the intended release remain separate evidence. Keep the app **unsubmitted and unpublished**; preparing or uploading a package is not permission to submit. Submission requires an explicit later decision, and publication requires approval. Do not use the real owner's private library for review.

Official references: [OpenAI submission](https://developers.openai.com/plugins/deploy/submission), [Render Blueprint](https://render.com/docs/blueprint-spec), [Render pricing](https://render.com/pricing), [Render backups](https://render.com/docs/postgresql-backups).

## Sign in with ChatGPT (approval-gated)

The optional integration is **disabled by default**. It is implemented for an
OpenAI-provisioned commercial OAuth client; it does not use the open-source
`dynamic_agent_client` registration flow. Request access at
[OpenAI's client application page](https://developers.openai.com/siwc/request-client-id).
Sign-in approval and permission to use a customer's ChatGPT plan are separate.
The hosted plan grant must be confirmed by OpenAI before enabling it; mocked
verification does not establish commercial account eligibility or live access.

After approval, register the exact `PUBLIC_URL/auth/chatgpt/callback` URL for each
environment. Configure `CHATGPT_ENABLED=true`, the issued `CHATGPT_CLIENT_ID`,
`CHATGPT_TOKEN_AUTH_METHOD` (`none` or `client_secret_basic`), and the secret for
confidential clients. Store a separate random 32-byte encryption key as 64 hex
characters in `CHATGPT_ENCRYPTION_KEY`. Put real values only in the deployment's
secret manager or ignored local configuration. Keep this key across restarts;
losing or replacing it requires users to reconnect. Credentials and pending
PKCE transactions are encrypted with AES-256-GCM and bound to their account or
transaction. Provider endpoints are discovered from OpenAI and restricted to
`https://auth.openai.com`; signed ID tokens are validated with `jose`.

Existing users link ChatGPT in Settings after entering their current Drop It
password. They can then use **Continue with ChatGPT** on the sign-in page.
Unlinked users first register or obtain a Drop It account through the existing
signup policy; ChatGPT does not bypass closed registration, create a second
library, or merge accounts by email. Keep a Drop It password and recovery code
for account controls. Ordinary browser logout retains the link. Password change,
recovery and sign-out-everywhere remove local ChatGPT links and tokens; users
can additionally revoke remote permission in ChatGPT Settings. Account deletion
cascades through local identity, token and pending-transaction records. Disconnect
attempts remote refresh-token revocation and reports when it cannot confirm it.
Provider-side permission removal cannot erase requests already in flight.

Only after OpenAI separately approves the hosted plan integration, configure
`CHATGPT_PLAN_ENABLED=true` and `CHATGPT_PLAN_SCOPES` with the **exact approved
scope set**, including `offline_access` and `resource.invoke` plus the provisioned
plan permission. Do not assume the OSS direct scope is approved for this hosted
client. The adapter uses the public model catalog and streaming Responses API;
validate this contract against the commercial grant during activation. It selects
the first visible model in the account's catalog. A live acceptance test must
confirm that this model accepts strict JSON-schema output and image/PDF input.

With plan mode enabled, all accounts must connect their own plan to draft, both
on the website and via MCP. No draft or embedding request falls back to the site
API key. Search uses keyword matching; this integration does not claim embeddings
are covered by ChatGPT plans. Accounts that have selected plan usage remain
protected from site-key fallback after disconnection or a configuration rollback.
Reconnect to restore drafting. Identity-only mode preserves existing server-funded
AI for accounts that have never selected plan usage. Manual capture remains
available in every mode. Usage and limits are managed in
[ChatGPT Settings](https://chatgpt.com/settings/usage).

Before activation, test with the issued client: exact callback matching, linking
and sign-in, denied consent, granted scopes, text/image/PDF drafting, refresh,
quota exhaustion, disconnect and existing MCP consent continuation. Check provider
and reverse-proxy logs redact `/auth/chatgpt/callback` query strings; authorization
codes must not be retained in request logs. The app redirects callbacks to a clean
URL, sends `Referrer-Policy: no-referrer`, and never returns OpenAI tokens to the
browser. This feature does not submit the plugin or change production settings.

Run `node --import tsx tests/postgres-chatgpt.ts` for the opt-in PostgreSQL
checks before release. It uses a disposable local cluster and mocked OpenAI
responses to verify concurrent refresh across two pools, durable rotated tokens,
disconnect and sign-out races, and invalid refresh without site-key fallback.
It does not load environment files or connect to production.

### Email authentication configuration

Email is submitted through the fixed Resend HTTPS API, using Node's built-in `fetch`. Set `EMAIL_AUTH_ENABLED=true` and supply the following in ignored `private/.env` or the platform secret manager:

- `EMAIL_AUTH_SECRET`: at least 32 random characters. Keep the existing value when switching providers; rotating it invalidates pending verification codes.
- `RESEND_API_KEY`: a Resend sending-only key restricted to the verified sending domain.
- `RESEND_FROM`: the sender's plain email address on that verified domain. A dedicated transactional subdomain is recommended; replies/support can stay in Proton.
- `EMAIL_DELIVERY_KEY`: an independent random 32-byte key encoded as exactly 64 hexadecimal characters. Keep it stable across restarts and all instances, and protect it with database backups. Changing or losing it makes pending encrypted emails unreadable; drain the queue before rotating it.

`SMTP_FROM`, `SMTP_USERNAME` and `SMTP_PASSWORD` are no longer read. Existing credentials do not need to be revoked until a separately authorized cutover has been verified. These source files do not configure DNS, provider accounts or production settings automatically. On an existing Render service, the Blueprint's `sync: false` entries do **not** populate new secrets during later syncs: supply the new keys explicitly through the secret configuration before the eventual deployment. Do not sync or deploy this Blueprint until the cutover is authorized.

`ALLOW_SIGNUP=true` requires email authentication, `ACCOUNT_MODE=public` and the existing public-site settings. Closed signup does not disable verified-email login or recovery. With email auth disabled, legacy accounts, offline recovery and ChatGPT still work; queued mail stays in the database without a running sender. No self-service username registration is exposed.

Requests are limited per IP, per email (one per minute and five per hour), and across the service (100 per hour). Per-email and service budgets persist in the database. Signup and reset requests return the same response whether an address exists or is throttled. Provider requests run only in the background worker, outside HTTP responses and database transactions. The browser retains passwords and challenge IDs only in component memory, never browser storage.

Migration 12 adds `email_outbox` without changing existing accounts, libraries or connection credentials. Verification challenges and their encrypted email jobs commit atomically. Settings password changes, email resets and offline recovery atomically queue a password-change notification with the credential rotation. A queue-write failure rolls back the related operation; a later provider failure cannot undo an already committed change. Notifications contain no password or recovery code.

The web process polls durable jobs every second, claiming up to four per pass sequentially with PostgreSQL `FOR UPDATE SKIP LOCKED` and a sixty-second lease. Interrupted jobs resume after the lease expires. A fifteen-second API deadline bounds each submission. Network errors, 429s, 5xx responses and concurrent-idempotency conflicts retry with exponential backoff and jitter (five seconds up to one hour), respecting `Retry-After` up to an hour. Other provider rejections stop immediately. Jobs stop after twenty attempts; codes stop at their original ten-minute expiry (no new submission in the final thirty seconds), and notifications expire after twenty-three hours. This keeps every retry inside Resend's twenty-four-hour idempotency window. Shutdown stops claiming new jobs and waits for the current submission; unclaimed work survives in the database.

Each job has one stable Resend idempotency key and an immutable encrypted message, including its original sender and rendered text. AES-256-GCM protects recipients and codes at rest with the job ID as authenticated data. Acceptance, expiry and terminal failure erase the encrypted payload. Completed metadata is purged seven days after job expiry. Replacing, consuming, revoking or deleting a challenge cascades to its job; deleting an account removes that owner's jobs. A submission already in flight cannot be recalled. Logs contain only generic status codes and random job IDs, never recipient addresses, verification codes, credentials or provider response bodies.

`accepted` means Resend accepted the submission, not that it reached an Inbox. Inspect provider delivery/bounce status in Resend; this change does not add webhook handling or open/click tracking. For local queue health, use aggregate queries such as `SELECT status,failure_code,count(*) FROM email_outbox GROUP BY status,failure_code;` and `SELECT count(*) FROM email_outbox WHERE status='pending' AND next_attempt_at<now()-interval '5 minutes';`. Investigate terminal failures before asking users to request a fresh code. Failed payloads are erased and cannot be manually replayed.

Before an authorized cutover: verify the sending domain in Resend, supply the sending-only key and stable encryption key, restore a backup into an isolated database and rehearse the additive migration, then verify actual signup/reset/notification delivery to authorized mailboxes. Existing SMTP challenges retain their validity if `EMAIL_AUTH_SECRET` is preserved; they are not resent automatically because their plaintext codes were never stored. Local synthetic tests do not prove provider delivery or Inbox placement.


Local setup and real delivery verification on October 19, 2026: `auth.dontdropit.app` is verified and sending-enabled in Resend (`us-east-1`), with receiving, open tracking and click tracking disabled. Its DKIM TXT, return-path MX/SPF TXT and additional provider CNAME records are verified; `_dmarc.auth.dontdropit.app` has a monitoring policy (`v=DMARC1; p=none`). The existing apex/`www` website records and CAA records were preserved. The sender is `security@auth.dontdropit.app`. A dedicated **Drop It authentication** API key was created with sending-only access restricted to this domain, and saved with an independent delivery-encryption key in ignored, owner-only (`0600`) `private/.env`. The existing email-auth secret and unrelated settings, including the previous SMTP credentials, were preserved. No credential values belong in this document.

The user authorized three real test messages to the controlled `info@macdigital.ai` mailbox. A disposable loopback-only application and database submitted signup verification, password-reset and password-change confirmation emails through the new Resend sender and durable worker. Resend reported all three delivered, and all three were observed in Proton Inbox. The received codes completed signup and password recovery; the old password was rejected and the new password opened the empty local library. The notification contained no password or recovery code. The test instance and database were removed afterward. This is local application plus real-provider/Proton-Inbox evidence: Render settings, the hosted database and the deployed Drop It application were untouched. Gmail/Outlook placement and hosted Resend activation remain unverified.

Migration 11 adds nullable email fields and separate challenge/limit tables without changing existing owner IDs, library rows or connection credentials. Before release, restore a current backup into isolated PostgreSQL and compare the original tables before and after migration. The previous username-based release can still read legacy accounts on the migrated schema. Once email-only accounts have been admitted, use a tested roll-forward repair: the previous release cannot sign them in. Do not drop email columns or restore over the production database as a routine rollback.

The following October 12 records describe the previous Proton SMTP release and do not validate the new Resend integration.

Local delivery verification on October 12, 2026 passed certificate-verified STARTTLS and SMTP authentication using the protected sender configuration. Two real emails (signup verification and password recovery) reached the authorized Proton Inbox. Their received codes completed both browser flows, and recovery rejected the old password while accepting the new one. The test used a disposable loopback-only app and database, which were removed afterward. Existing accounts, libraries and deployment settings were untouched; public signup remained closed. This confirms delivery to that Proton mailbox, not placement with other providers or a hosted deployment.

Additional October 12 checks delivered a password-change confirmation to Proton Inbox and all three messages (signup, recovery and confirmation) to an authorized Gmail mailbox. Gmail placed them in Spam and reported that previous messages from the sender domain had been marked as spam; SPF, DKIM and DMARC passed. Received Gmail codes completed signup and recovery, and old/new password checks passed. At a measured 390 × 844 browser viewport, signup/recovery forms fit without horizontal overflow, mismatched signup passwords were rejected and the new password signed in successfully. Mailbox labels and sender settings were not changed. Gmail Inbox placement, Outlook delivery and a physical mobile device remain unverified. Hosted HTTPS and live ChatGPT acceptance for this auth release still require a separately authorized deployment.

A current production logical export was restored into isolated local PostgreSQL 16. All 15 original public tables matched before and after migration 10 → 11, including original account fields, library/attachment bytes, sessions and connection credentials; a repeated migration was safe and no existing account received a fabricated email. Production rows and network settings were unchanged. A managed point-in-time restore/cutover remains a separate operational drill.
