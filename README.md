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

Configuration is read from `private/.env` when present; a root `.env` is not loaded. Existing process environment variables take precedence. `.env.example` contains only safe placeholders. Keep the private directory owner-only (mode 700) and its env file owner-readable/writable only (mode 600). Data lives in `.data/postgres` by default. Back up that directory while the app is stopped. Never commit `.data`, env files, uploads, personal records, or credentials. `.gitignore` is deliberately local-only and ignores itself.

## Implemented

- Local owner setup, password login, expiring browser sessions, logout.
- OAuth authorization-code flow with PKCE, exact redirect allowlists, rotating refresh tokens, scope checks and revocation using the official MCP SDK.
- Text/link capture and private PNG/JPEG/WebP uploads (10 MB and 25 megapixel limits; 250 MB per-owner attachment quota).
- Original sources stored independently of editable items; multiple items may reference one source.
- Keyword search across titles, summaries, source text, URLs, tags and notes; category/status/tag/date filters; pagination.
- Flexible owner-scoped category names with existing-category suggestions, case-insensitive reuse and filtering. Existing labels are preserved; new uncategorized saves use `Uncategorized`.
- Source/URL duplicate warnings, explicit duplicate override, idempotent saves and optimistic edit/delete revisions.
- Source image viewing, notes, status changes, item deletion and JSON export including original image bytes.
- MCP tools and an inline React widget using the MCP Apps bridge. Tools remain useful without the widget.
- Expired credential and abandoned-upload cleanup.

The standalone UI accepts manually entered metadata. Inside ChatGPT, the host model interprets your screenshot and proposes metadata before calling the tools. There is no separate OCR or model API in the backend, and saving a URL does not fetch its page. Source content is untrusted data, never instructions.

### Categorization API status

The [September 29 Decisions API announcement](https://openai.com/index/devday-2026-recap/) describes a limited preview with broad release planned in the coming days. It accepts text/images and returns finite predefined answers. That is a potential fit for selecting among the authenticated owner's existing categories, but not generating new names directly. A future integration should include an explicit no-match result and a separate new-category proposal step. Endpoint schemas and project access must be verified against published API documentation before implementation; no speculative Decisions endpoint is called today. The standalone UI remains manual, while the ChatGPT host can supply categories through `save_item`.

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

Only `files.oaiusercontent.com` HTTPS file-download URLs are accepted by screenshot import. Redirects and arbitrary external fetches are blocked. If a host supplies another legitimate file service, verify it and update the allowlist deliberately. Temporary download URLs are never saved or logged. If file transfer is unsupported in a host, the standalone UI can upload the original screenshot directly.

The standalone Export button downloads a complete JSON library; export is not exposed as a model tool. The connection icon revokes all MCP tokens without deleting saved items.

Live ChatGPT account linking and its file-transfer path must be verified in the user's account after an HTTPS endpoint is configured. Local protocol tests do not substitute for that final integration check.

## MCP tools

| Tool            | Purpose                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------- |
| `search_items`  | Search/filter the authenticated owner's library                                           |
| `get_item`      | Read an item and immutable source; image preview is widget-only metadata                  |
| `save_item`     | Save a source or add an item referencing an existing source; requires a retry-stable UUID |
| `update_item`   | Edit title, summary, tags, notes, category or status using current revision               |
| `delete_item`   | Delete an item using current revision, clean up unshared sources/images                   |
| `upload_source` | Preserve an explicitly supplied ChatGPT image file                                        |
| `get_profile`   | Return the stable authenticated owner ID                                                  |

## Development and checks

```sh
npm run check
npm run format
```

Checks include ESLint, TypeScript, the production widget build, real HTTP API tests, OAuth token exchange, an official SDK MCP client, durable database reopening, input/file validation, cross-owner isolation, shared-source cleanup, retries and exports. Tests use temporary databases and generated credentials; they never read your library.

Use the in-app browser for visual verification. Check desktop and mobile layouts, setup/login, screenshot upload, source display, editing, search, export, deletion and keyboard focus.

## Deliberate limits

- Private, single-owner onboarding; no public launch, billing, shared collections or team invitations.
- No browser extension, Apple Notes import, reminders, automatic webpage scraping or vector search.
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
