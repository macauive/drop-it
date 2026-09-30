# Drop It

A private saved-for-later library with a React interface and a ChatGPT-compatible MCP server. Save screenshots, text and links; search them later; preserve the source while editing summaries and notes.

## Run locally

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open http://localhost:4317 and create your owner password (at least 12 characters). No AI API key, cloud database, or Docker is required. The password is hashed with Node's scrypt; sessions use HTTP-only cookies. Owner setup is allowed only from loopback while PUBLIC_URL is local. There is no public signup.

`npm run dev` builds the UI once and watches server files. After UI edits, run `npm run build:web` and restart the server to load the new bundle. For a normal run after building, use `npm start`.

Configuration is read from `private/.env` when present; a root `.env` is not loaded. Existing process environment variables take precedence. `.env.example` contains only safe placeholders. Keep the private directory owner-only (mode 700) and its env file owner-readable/writable only (mode 600). Data lives in `.data/postgres` by default. Back up that directory while the app is stopped. Never commit `.data`, env files, uploads, personal records, or credentials. `.gitignore` and `AGENTS.md` are deliberately local-only.

## Implemented

- Local owner setup, password login, expiring browser sessions, logout.
- OAuth authorization-code flow with PKCE, exact redirect allowlists, rotating refresh tokens, scope checks and revocation using the official MCP SDK.
- Text/link capture and private PNG/JPEG/WebP, PDF, TXT, Markdown, CSV and JSON uploads (10 MB per file; 250 MB per-owner attachment quota). Images are limited to 25 megapixels, PDFs to 30 unencrypted pages, and UTF-8 text files to 50,000 characters. Unsupported formats, invalid content and filename traversal are rejected.
- Original sources stored independently of editable items; multiple items may reference one source.
- Keyword search across titles, summaries, source text, URLs, tags and notes; category/status/tag/date filters; pagination.
- File-first capture automatically drafts a title, summary, category, tags and transcription after upload. Review before saving, or choose Enter manually to open the full text/link form and edit any draft. Website screenshots can propose a clearly visible source URL; it remains editable before saving and is never fetched automatically.
- Unified search combines literal keyword matches with meaning-based matches using owner-scoped embeddings and the same category/status/date filters. No search-mode toggle is needed.
- Flexible owner-scoped category names with existing-category suggestions, case-insensitive reuse and filtering. Existing labels are preserved; new uncategorized saves use `Uncategorized`.
- Source/URL duplicate warnings, explicit duplicate override, idempotent saves and optimistic edit/delete revisions.
- Source image viewing, authenticated original-file downloads, notes, status changes, item deletion and JSON export including original file bytes (`imageBase64` for images, `fileBase64` for other files).
- MCP tools and an inline React widget using the MCP Apps bridge. Tools remain useful without the widget.
- Expired credential and abandoned-upload cleanup.

The standalone UI supports AI-assisted drafting and manual entry. Inside ChatGPT, the host model can supply metadata directly or request `draft_item`. Saving or drafting a URL does not fetch its page. Source content is untrusted data, never instructions.

### AI configuration and privacy

Set `OPENAI_API_KEY` in the ignored `private/.env` and restart the server to enable AI. The key stays server-side. Drafts use the Responses API with `store: false`, strict structured output and `gpt-5.6-luna` by default (`OPENAI_MODEL` can override the draft model). A draft processes up to the first 16,000 source-text characters, the URL without query/fragment, up to 100 existing category names, and an owned image resized to fit 1536 x 1536 or the complete validated PDF via [Responses file inputs](https://developers.openai.com/api/docs/guides/file-inputs). PDF page images and text can increase API usage. No tools or URL fetches are available to the model. Treat generated summaries, transcriptions (up to a 12,000-character excerpt), and detected source URLs as suggestions to review. The original file is preserved separately. A website logo or title alone is not sufficient to infer its source URL. Supplied manual URLs take precedence. Drafting never saves an item, and typed source text is not overwritten by a draft.

Text files are decoded as UTF-8, never rendered as HTML or executed; JSON is parsed for validity. Original files download as attachments with `nosniff` and a sandbox CSP. PDF.js validates PDFs in a worker with a 10-second time limit, a bounded JavaScript heap and at most two concurrent checks per process. This validation is not malware scanning; treat downloaded originals as untrusted. ChatGPT-hosted file download behavior still needs live verification after deployment.

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

The standalone Export button downloads a complete JSON library; export is not exposed as a model tool. The connection icon revokes all MCP tokens without deleting saved items.

Live ChatGPT account linking and its file-transfer path must be verified in the user's account after an HTTPS endpoint is configured. Local protocol tests do not substitute for that final integration check.

## MCP tools

| Tool            | Purpose                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `search_items`  | Search/filter the authenticated owner's library                                                                               |
| `draft_item`    | Propose editable metadata, file transcription and a visible source URL through OpenAI; requires write scope but does not save |
| `get_item`      | Read an item and immutable source; original file bytes are widget-only metadata                                               |
| `save_item`     | Save a source or add an item referencing an existing source; requires a retry-stable UUID                                     |
| `update_item`   | Edit title, summary, tags, notes, category or status using current revision                                                   |
| `delete_item`   | Delete an item using current revision, clean up unshared sources/files                                                        |
| `upload_source` | Preserve an explicitly supplied supported ChatGPT file                                                                        |
| `get_profile`   | Return the stable authenticated owner ID                                                                                      |

## Development and checks

The `tests/` directory and its fixtures are kept locally and excluded from version control. Fresh clones do not include them, so `npm test`, `npm run check`, and the additional checks below require a local copy of that directory. Lint and build can be run independently with `npm run lint` and `npm run build`.

```sh
npm run check
npm run format
```

Checks include ESLint, TypeScript, the production widget build, real HTTP API tests, OAuth token exchange, an official SDK MCP client, durable database reopening, input/file validation, cross-owner isolation, shared-source cleanup, retries and exports. Tests use temporary databases and generated credentials; they never read your library.

Use the in-app browser for visual verification. Check desktop and mobile layouts, setup/login, screenshot upload, source display, editing, search, export, deletion and keyboard focus.

Additional pre-commit checks:

- `tests/uploads.test.ts` includes encrypted PDFs (including an empty viewing password), image-only scans, simulated parser timeout recovery, concurrent validation limits and exact page/text boundaries. Synthetic PDF fixtures are kept locally; regenerating them with `tests/generate-pdf-fixtures.py` requires Pillow, ReportLab and pypdf with AES support, not production runtime dependencies.
- `DROP_IT_LIVE_AI=1 npx tsx tests/live-ai-checks.ts` runs paid, opt-in checks with the configured project key against synthetic screenshots and a scanned PDF. It checks missing, brand-only, truncated and ambiguous URLs, address-bar precedence and scan transcription. A passing sample is not a guarantee against model errors; source URLs still need review.
- `DROP_IT_BROWSER_TEST=1 node --import tsx tests/browser-recovery.ts` starts a separate loopback-only, automatically authenticated test instance with a temporary database and mocked AI. It never loads your environment or library. Its first draft fails with a rate limit, second with a simulated timeout, third succeeds, and fourth times out for manual-save verification. `GET /__test/state` shows only test counts. Stop it gracefully with Ctrl-C to remove the temporary data. Never deploy this test harness.

## Deliberate limits

- Private, single-owner onboarding; no public launch, billing, shared collections or team invitations.
- No browser extension, Apple Notes import, reminders or automatic webpage scraping.
- No automated password recovery yet. Keep your password in your password manager.
- Backups may retain deleted content until you rotate them; export files contain your original private content.
- Local OAuth implementation is intended for private use. A broader release needs hosted identity/provider review, deployment hardening and an account-recovery workflow.

## Design references

The MCP transport and resource wiring follow OpenAI's small to-do quickstart, adapted to authenticated durable storage and a React widget. The official example collection was inspected; no showcase app was copied wholesale.

- https://developers.openai.com/plugins/build/app-quickstart
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/reference
- https://github.com/openai/openai-apps-sdk-examples
