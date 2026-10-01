# Drop It

A private saved-for-later library with a React interface and a ChatGPT-compatible MCP server. Save screenshots, text and links; search them later; preserve the source while editing summaries and notes.

## Run locally

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open http://localhost:4317 and create your owner password (15–128 characters). No AI API key, cloud database, or Docker is required. The password is hashed with Node's scrypt using explicit N=32768, r=8, p=3 parameters; existing legacy hashes upgrade after a successful login. Sessions use HTTP-only cookies. Owner setup is allowed only from loopback while PUBLIC_URL is local. Public signup is disabled by default. `ACCOUNT_MODE=public` enables username-based sign-in; `ALLOW_SIGNUP=true` enables registration. See the release preparation section before exposing signup.

`npm run dev` builds the UI once and watches server files. After UI edits, run `npm run build:web` and restart the server to load the new bundle. For a normal run after building, use `npm start`.

Configuration is read from `private/.env` when present; a root `.env` is not loaded. Existing process environment variables take precedence. `.env.example` contains only safe placeholders. Keep the private directory owner-only (mode 700) and its env file owner-readable/writable only (mode 600). Data lives in `.data/postgres` by default. Back up that directory while the app is stopped. Never commit `.data`, env files, uploads, personal records, or credentials. `.gitignore` and `AGENTS.md` are deliberately local-only.

## Implemented

- Local owner setup, password login, password changes, one-time recovery codes, expiring browser sessions, individual session revocation and sign out everywhere.
- OAuth authorization-code flow with PKCE, exact redirect allowlists, rotating refresh tokens with family revocation on replay, scope checks and revocation using the official MCP SDK. Disconnecting also invalidates previously approved authorization codes.
- Text/link capture and private PNG/JPEG/WebP, PDF, TXT, Markdown, CSV and JSON uploads (10 MB per file; 250 MB per-owner attachment quota). Images are limited to 25 megapixels, PDFs to 30 unencrypted pages, and UTF-8 text files to 50,000 characters. Unsupported formats, invalid content and filename traversal are rejected.
- Original sources stored independently of editable items; multiple items may reference one source.
- All drops contains created drops outside Trash. Saved is a bookmark filter, not a lifecycle status; yellow ribbons toggle bookmarks. New drops are created unbookmarked.
- Keyword search across titles, summaries, source text, URLs, tags and notes; pool/view/tag/date filters; pagination.
- File-first capture automatically drafts a title, summary, category, tags and transcription after upload. Review before saving, or choose Enter manually to open the full text/link form and edit any draft. Website screenshots can propose a clearly visible source URL; it remains editable before saving and is never fetched automatically.
- Unified search combines literal keyword matches with meaning-based matches using owner-scoped embeddings and the same pool/view/date filters. No search-mode toggle is needed.
- Flexible owner-scoped category names with existing-category suggestions, case-insensitive reuse and filtering. Existing labels are preserved; new uncategorized saves use `Uncategorized`.
- Source/URL duplicate warnings, explicit duplicate override, idempotent saves and optimistic edit/delete revisions.
- Source image viewing, authenticated original-file downloads, collapsible transcription, notes and JSON export v2 including bookmark/Trash state and original file bytes (`imageBase64` for images, `fileBase64` for other files).
- Wipe drop moves a drop to Trash for seven days. Restore preserves its bookmark and cancels deletion; wiping it again starts a new window. Repeated wipes while already in Trash do not reset the deadline. Expired drops cannot be read, restored, downloaded or exported. Cleanup runs at startup and hourly while the server is running, permanently removing expired drops and only unreferenced sources/files. Offline cleanup resumes on next startup.
- Migration leaves existing drops unbookmarked and gives formerly archived drops a fresh seven-day Trash window. In progress and Done are removed.
- MCP tools and an inline React widget using the MCP Apps bridge. Tools remain useful without the widget.
- Expired credential and abandoned-upload cleanup.
- Standalone Settings panel with JSON export, owner-scoped connected-app count and confirmed disconnect-all, AI configuration/privacy details and the fixed seven-day Trash policy. Configuration status does not verify OpenAI credentials or credit; API keys are never sent to the browser. Embedded ChatGPT widgets do not expose browser-session settings or library export.

The standalone UI supports AI-assisted drafting and manual entry. Inside ChatGPT, the host model can supply metadata directly or request `draft_item`. Saving or drafting a URL does not fetch its page. Source content is untrusted data, never instructions.

### Account security and recovery

Open Settings to change your password, generate a recovery code, review active browser sessions, or sign out everywhere. Each change requires your current password. New passwords must have 15–128 characters; existing shorter passwords remain usable for login and reauthentication. This follows [OWASP's guidance for password-only authentication and sensitive account changes](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

Save your recovery code in a password manager or another secure offline location. The app shows it once and stores only its hash. Generating another code immediately invalidates the previous one. If you forget your password, select **Forgot password?** on the login screen and enter your code with a new password. Recovery does not require email. The code works once; there is no recovery without either a valid code or your password.

Changing or recovering your password revokes every browser session, connected-app token and approved OAuth code, and invalidates the recovery code. Sign in again and generate a new recovery code afterward. **Sign out everywhere** also revokes browser sessions and app connections but preserves your recovery code. These actions preserve saved library data. An individual session can be ended without affecting other sessions or connected apps.

The session list shows a coarse browser/device label and creation, last-active and expiration times. Labels are informational and do not establish device identity. Raw user agents and IP addresses are not stored. Browser sessions expire after seven days. The list shows the current browser and up to 49 other active sessions; each login retains at most 50 sessions. Older installations keep existing sessions during migration, and sign out everywhere also revokes any older sessions beyond the displayed limit. Account-security controls are available only in the standalone browser app, not through MCP tools or the ChatGPT widget. Sensitive requests recheck the current session under the same database lock used for credential changes. Sign-in/recovery attempts and authenticated security changes have separate rate limits; the in-memory limiters apply per server process.

### AI configuration and privacy

Set `OPENAI_API_KEY` in the ignored `private/.env` and restart the server to enable AI. The key stays server-side. Drafts use the Responses API with `store: false`, strict structured output and `gpt-5.6-luna` by default (`OPENAI_MODEL` can override the draft model). A draft processes up to the first 16,000 source-text characters, the URL without query/fragment, up to 100 existing category names, and an owned image resized to fit 1536 x 1536 or the complete validated PDF via [Responses file inputs](https://developers.openai.com/api/docs/guides/file-inputs). PDF page images and text can increase API usage. No tools or URL fetches are available to the model. Treat generated summaries, transcriptions (up to a 12,000-character excerpt), and detected source URLs as suggestions to review. The original file is preserved separately. A website logo or title alone is not sufficient to infer its source URL. Supplied manual URLs take precedence. Drafting never saves an item, and typed source text is not overwritten by a draft.

Text files are decoded as UTF-8, never rendered as HTML or executed; JSON is parsed for validity. Original files download as attachments with `nosniff` and a sandbox CSP. Image validation allows at most two concurrent decodes per process. PDF.js validates PDFs in a worker with a 10-second time limit, a bounded JavaScript heap and at most two concurrent checks per process. This validation is not malware scanning; treat downloaded originals as untrusted. ChatGPT-hosted file download behavior still needs live verification after deployment.

AI search sends the submitted query and bounded text from each matching drop (title, summary, category, tags, up to 1,000 note characters and 4,000 source-text characters, with a 6,000-character combined limit) to OpenAI's `text-embedding-3-small` model at 512 dimensions. Raw screenshots are not sent for search; their reviewed transcription can be indexed. Embeddings are cached in the local database, isolated by owner, invalidated on content edits and removed on deletion. This retrieves actual saved records, not a generated answer. Semantic matches use cosine similarity with a minimum score of 0.2, a heuristic rather than a calibrated confidence score. Literal matches across full source text, metadata and URLs are always included, rank first, and are deduplicated before pagination.

Search is explicitly submitted rather than calling AI on every keystroke. The initial index may take longer; unchanged items reuse cached vectors. At most 1,000 filtered drops are considered for AI ranking. Hybrid search falls back to keyword results with a visible notice when AI is unavailable, fails, or the filtered library exceeds that limit. Indexing is batched and can resume from cached batches after a timeout. AI operations are limited to one concurrent request and 20 starts per minute per owner, per server process. Failed drafts are never saved automatically. `store: false` does not itself mean zero provider retention; the project's OpenAI data policies still apply. API calls incur usage charges. Manual entry and keyword retrieval do not require an API key. The API retains explicit `keyword` mode for clients that must avoid external AI calls; its default is `hybrid`.

The current AI setup uses Responses for drafting and embeddings for search; no Decisions API integration is needed.

## Storage

Local development uses PGlite, an embedded Postgres engine persisted on disk. Set `DATABASE_URL` to use a standard Postgres server via `pg`; use your provider's verified TLS configuration. Both adapters share parameterized SQL and transactions. PGlite is single-process: run only one app instance against a local data directory.

For this first implementation, original image bytes are stored in private Postgres `bytea` records rather than an external object-storage service. This keeps ownership checks, exports and shared-source deletion transactional and avoids an additional account. A hosted object-storage adapter is a later scaling improvement. Do not deploy PGlite on ephemeral serverless disk.

## Connect ChatGPT

The local app is usable now. An actual ChatGPT connection additionally requires a reachable HTTPS endpoint and configuration in your ChatGPT account.

1. Create your owner locally before exposing the service. Preserve the same database when changing PUBLIC_URL.
2. Choose a persistent host or development tunnel. Set `PUBLIC_URL` to its exact HTTPS origin. A reverse proxy must preserve that Host header. The app defaults to loopback; with an HTTPS public origin it listens on all interfaces.
3. Add the MCP URL `https://<your-host>/mcp` in ChatGPT's developer connection settings. Choose OAuth with dynamic registration and a public client (`token_endpoint_auth_method: none`).
4. Copy the exact OAuth callback URI shown by ChatGPT into `OAUTH_REDIRECT_URIS` in your local/deployment environment. Multiple exact callback URIs can be comma-separated. Unconfigured callbacks are rejected; there are no wildcard redirects.
5. Restart, complete account linking, sign in with your owner password, and approve the requested read/write scopes.
6. Ask ChatGPT to save an item, then retrieve it from a new conversation. For a screenshot, preserve it with `upload_source`, then pass its returned `attachmentId` to `save_item`. The model supplies the transcription/summary separately.

Only `files.oaiusercontent.com` HTTPS file-download URLs are accepted by file import. Redirects and arbitrary external fetches are blocked. If a host supplies another legitimate file service, verify it and update the allowlist deliberately. Temporary download URLs are never saved or logged. If file transfer is unsupported in a host, the standalone UI can upload the original file directly.

The standalone Export button downloads a complete JSON library; export is not exposed as a model tool. JSON v2 repeats file bytes for each source referencing an attachment. Exports are rejected before loading file bodies if the conservative serialized-size estimate exceeds 384 MiB. Only one export can run per process, with at most five export requests per owner per minute; a disconnected client still holds the slot until generation finishes. The connection icon revokes all MCP tokens without deleting saved items.

Live ChatGPT account linking and its file-transfer path must be verified in the user's account after an HTTPS endpoint is configured. Local protocol tests do not substitute for that final integration check.

## MCP tools

| Tool            | Purpose                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `search_items`  | Search/filter the authenticated owner's library                                                                                         |
| `draft_item`    | Propose editable metadata, file transcription and a visible source URL through OpenAI; requires read and write scopes but does not save |
| `get_item`      | Read an item and immutable source; original file bytes are widget-only metadata                                                         |
| `save_item`     | Create an unbookmarked drop; requires a retry-stable UUID (tool name retained for compatibility)                                        |
| `update_item`   | Edit title, summary, tags, notes, category or isSaved bookmark using current revision                                                   |
| `delete_item`   | Move a drop to Trash for seven days using current revision                                                                              |
| `restore_item`  | Restore a drop before its Trash deadline, preserving its bookmark                                                                       |
| `upload_source` | Preserve an explicitly supplied supported ChatGPT file                                                                                  |
| `get_profile`   | Return the stable authenticated owner ID                                                                                                |

The `save_item`, `update_item`, `restore_item`, and `draft_item` tools require both `library:read` and `library:write` because they return or process existing content. `upload_source` and `delete_item` require write scope; read tools require read scope.

## Development and checks

The `tests/` directory and its fixtures are kept locally and excluded from version control. Fresh clones do not include them, so `npm test`, `npm run check`, and the additional checks below require a local copy of that directory. Lint and build can be run independently with `npm run lint` and `npm run build`.

```sh
npm run check
npm run format
```

Checks include ESLint, TypeScript, the production widget build, real HTTP API tests, password changes, one-time recovery, browser-session revocation, OAuth token exchange, an official SDK MCP client, durable database reopening, input/file validation, cross-owner isolation, shared-source cleanup, retries and exports. Tests use temporary databases and generated credentials; they never read your library.

Use the in-app browser for visual verification. Check desktop and mobile layouts, setup/login, screenshot upload, source display, editing, search, export, deletion and keyboard focus.

Additional pre-commit checks:

- `tests/uploads.test.ts` includes encrypted PDFs (including an empty viewing password), image-only scans, simulated parser timeout recovery, concurrent validation limits and exact page/text boundaries. Synthetic PDF fixtures are kept locally; regenerating them with `tests/generate-pdf-fixtures.py` requires Pillow, ReportLab and pypdf with AES support, not production runtime dependencies.
- `DROP_IT_LIVE_AI=1 npx tsx tests/live-ai-checks.ts` runs paid, opt-in checks with the configured project key against synthetic screenshots and a scanned PDF. It checks missing, brand-only, truncated and ambiguous URLs, address-bar precedence and scan transcription. A passing sample is not a guarantee against model errors; source URLs still need review.
- `DROP_IT_BROWSER_TEST=1 node --import tsx tests/browser-recovery.ts` starts a separate loopback-only, automatically authenticated test instance with a temporary database and mocked AI. It never loads your environment or library. Its first draft fails with a rate limit, second with a simulated timeout, third succeeds, and fourth times out for manual-save verification. `GET /__test/state` shows only test counts. Stop it gracefully with Ctrl-C to remove the temporary data. Never deploy this test harness.

When local PostgreSQL binaries are installed, `node --import tsx tests/postgres-security.ts` additionally tests the `pg` adapter in a disposable cluster with TCP disabled.

## Deliberate limits

- Defaults to private, single-owner onboarding. Public username accounts are implemented but a public deployment and live ChatGPT review are still required. No billing, shared collections or team invitations.
- No browser extension, Apple Notes import, reminders or automatic webpage scraping.
- No MFA, passkeys or email-based recovery. Keep your password and offline recovery code secure.
- Backups may retain deleted content until you rotate them; export files contain your original private content.
- OAuth and password accounts have local protocol/security coverage. Public HTTPS/proxy behavior, abuse controls at the chosen hosting tier, backup restoration and live ChatGPT integration must be verified before launch.

## Design references

The MCP transport and resource wiring follow OpenAI's small to-do quickstart, adapted to authenticated durable storage and a React widget. The official example collection was inspected; no showcase app was copied wholesale.

- https://developers.openai.com/plugins/build/app-quickstart
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/reference
- https://github.com/openai/openai-apps-sdk-examples

## Release preparation

The public-account and release code is prepared locally. This is not a deployment or evidence of ChatGPT approval. Existing data directories and secrets are not modified by build or test commands.

### Accounts and migration

- Default `ACCOUNT_MODE=private` preserves password-only local owner access.
- `ACCOUNT_MODE=public` enables private usernames (3–40 ASCII letters/numbers/underscores/hyphens, normalized to lowercase). The original owner signs in as `owner` with the existing password. That name cannot be registered. Existing ownership UUIDs, sessions and library records survive database migration 8.
- `ALLOW_SIGNUP=false` is the default. Existing public accounts can still sign in when signup is closed. A new empty hosted database has no accounts until signup is deliberately enabled; the local-only setup endpoint remains unavailable remotely.
- Recovery codes work across accounts and remain one-time. There is no email verification or email recovery; usernames are not email addresses. Users should generate a recovery code in Settings immediately after signup.
- Permanent account deletion requires a live session, the current password, same-origin POST and exact `DELETE` confirmation. It removes only that owner's active database content and credentials in one transaction. If any step fails, the transaction rolls back. Existing external exports and backup copies are unaffected.
- Moving from embedded PGlite to hosted PostgreSQL is a separate data migration. Do not point `DATABASE_URL` at a new database and assume the local library transferred. Keep the local instance and an offline backup until an explicit migration and reconciliation have passed. Never upload the `.data` directory as application source.

### Hosting proposal

`render.yaml` prepares one managed Node service (2 GB) and a private-network PostgreSQL 16 database with 5 GB disk. Signup, automatic deploys and disk autoscaling start disabled. Provisioning these resources costs money and has not been performed. The September 30, 2026 pricing lookup indicated approximately $32.50/month before AI, domain, taxes, bandwidth/build overages and other usage ($25 server + $6 database + $1.50 storage). Verify the actual checkout price before provisioning; capacity under production load is unverified.

- Render supplies `RENDER_EXTERNAL_URL` for initial HTTPS operation. Set `PUBLIC_URL` to the final exact origin when adding a custom domain. Configure only the canonical custom domain so health checks use the expected Host header.
- `DATABASE_URL` is supplied from the managed database; public production mode refuses embedded ephemeral storage. Use the internal connection string in the same region, and keep external database access disabled. For any external database connection use verified TLS, never disable certificate verification.
- `TRUST_PROXY_HOPS=1` is prepared for the managed ingress. Verify the forwarding chain with synthetic requests before launch; do not expose the Node port directly or trust arbitrary client forwarding headers.
- Existing per-owner AI concurrency/rate limits and HTTP limits are process-local. The deployment intentionally uses one instance. Add shared enforcement and load testing before horizontal scaling. Limits are not a dollar spending cap: configure an OpenAI project budget and monitor usage before opening signup.
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
```

Preflight reports configuration presence only, without secret values or live API calls. It exits unsuccessfully while release settings are missing. Copy `release/settings.example.json` to a local file and enter the real public origin, verified publisher name, support address, walkthrough recording URL and desired country codes. The example intentionally cannot produce a package.

The package command creates `dist/drop-it-plugin.zip` from an explicit three-file allowlist: the manifest, remote MCP configuration and icon. It excludes server source, env files, credentials and library content. Reviewer credentials are entered separately in the OpenAI dashboard, never added to this JSON or ZIP. The package command is not evidence that the endpoint, pages, video or publisher verification are ready.

`release/review-cases.json` contains five positive and three negative review scenarios, not completed test results. Run them in ChatGPT against a dedicated sample account, including cross-conversation retrieval, screenshot transfer, edits and Trash/restore. Verify desktop and mobile, record the walkthrough, complete publisher/domain verification, upload the ZIP, resolve scan findings, then submit. Only publish after approval. Do not use the real owner's private library for review.

Official references: [OpenAI submission](https://developers.openai.com/plugins/deploy/submission), [Render Blueprint](https://render.com/docs/blueprint-spec), [Render pricing](https://render.com/pricing), [Render backups](https://render.com/docs/postgresql-backups).
