# Audit fixes and capabilities — October 1, 2026

Implemented locally against the existing Drop It configuration. No new provider credentials, deployment, account admission changes, production data changes, commit, push, or app submission were performed. Browser verification used disposable loopback databases and a mocked AI provider; it did not inspect the owner's library or change the retained reviewer samples.

## Implemented

- **Source retention and fidelity:** expired originals cannot be drafted or reused through retained attachment IDs before cleanup. Fresh-upload grace, shared originals and cleanup races are covered. Original URL fragments remain intact; duplicate identity uses a separate normalized URL. Per-drop reviewed transcription has its own revision-guarded value and timestamp, preserving immutable source text and file bytes.
- **Private search:** account-wide AI search defaults off and is enforced for browser and MCP callers. Keyword, hybrid and meaning-only modes are explicit. Settings explains that indexing can process all eligible filtered records, including records that lack the query words. Tag/date controls, literal snippets and match types explain results. Typed query/tag text does not invoke AI on every character.
- **Editing and capture:** unsaved-change confirmation, navigation warning, serialized detail operations, protected fields during saves, and recoverable revision conflicts. Loading the latest revision keeps edited fields and adopts other newer values. Notes/bookmark writes preserve metadata edits. Duplicate warnings open the existing drop without losing the new draft. Attachment switching cannot silently reattach a prior host file or reuse stale transcription.
- **Portability:** streamed v3 NDJSON exports deduplicate originals and avoid the former repeated-file amplification limit. Bounded v2/v3 import validates files, references, dates, limits and hashes before preview. Explicit apply adds owner-remapped copies transactionally, preserves bookmarks/dates/unexpired Trash, skips expired Trash, rechecks quotas, and records durable retry receipts. Preview cancellation, expiry and private staging cleanup are implemented.
- **ChatGPT integration:** nine tools publish validated output contracts; profile identity is recognizable. Widget v5 hydrates the initiating search, empty result, detail or draft without replacing it with All drops. It preserves exact filter timestamps/page size, queues new results while a panel is open, reconnects after a failed bridge, and supports host theme/fullscreen. Only the non-sensitive library view is retained as widget state.
- **Onboarding and capture surfaces:** recovery reminder, clear closed-registration guidance, logged-in support/privacy links, storage breakdown and early upload-discard cleanup. Clipboard image paste and a bounded text/link Web Share Target prepare unsaved captures. Manifest has fixed 192/512 PNG install icons. The service worker stores no private offline content. Physical share-sheet support remains browser dependent.
- **Reliability and capacity:** PostgreSQL pool background-error handling with sanitized logging, finite acquisition/query/lock/idle budgets, bounded readiness and shutdown. Transactional owner/service attachment limits, owner text/drop limits and service AI concurrency/rate limits. Contrast, placeholder, destructive-hover and keyboard-focus fixes retain the existing layout.

## Verification

`npm run check` passed on the final source: **187 tests, zero failures**, ESLint, TypeScript and production Vite build. `git diff --check` passed. The disposable PostgreSQL security suite passed **23/23**, and PostgreSQL interruption/reconnect/lock-timeout checks passed **3/3**. These are local checks, not a claim about GitHub CI.

Focused automated coverage includes expired-attachment boundaries, owner isolation, CSRF, preferences, quotas and races, schema migration/idempotency, corrected-text indexing, widget initialization/retry/result contracts, streamed archives, corruption/traversal/executable-URL rejection, import rollback and replay, and readiness failure/recovery. The export amplification regression successfully exports under 5 MiB where repeated-file legacy JSON exceeds its 384 MiB limit.

In-app browser checks, using synthetic data, observed:

- Pagination reached the last page; a submitted search reset to the matching first page with a literal snippet.
- Closing a dirty capture offered Keep editing/Discard; Keep editing retained the fields. Opening an existing duplicate and closing it retained the original unsaved draft.
- A real two-tab conflict preserved the first tab's edited title and adopted the second tab's newer tags before a successful save. Saving notes and toggling a bookmark left metadata editing open and intact.
- Reviewed transcription saved and became searchable while the original transcription and URL fragment remained unchanged. File capture saved a correction separately from mocked OCR text.
- A native backup download completed; preview reported 32 drops, 32 sources and one original. Explicit import added 32 copies without overwriting existing records.
- The share POST rendered literal script-like source text and the full URL as an unsaved draft. Image paste from the capture panel's initial focus produced a draft; cancellation discarded it. The pre-test browser clipboard was restored.
- Upload input keyboard focus produced a visible 2px outline. Responsive DOM checks at 320px and 390px showed no document horizontal overflow. The native screenshot helper did not reliably represent the emulated viewport, so physical-device visual behavior is not claimed.
- Final browser console inspection reported no errors or warnings. Test tabs and running disposable servers were closed; viewport overrides were reset.

Desktop evidence: [synthetic browser screenshot](../tests/launch-implementation-browser.jpg). The browser harness is `tests/browser-launch.ts`; it explicitly opts in, never loads environment files, and uses generated test credentials.

## Remaining release evidence

The new widget still needs the real ChatGPT-host scenarios and walkthrough in [the verification checklist](chatgpt-verification-checklist.md). Physical mobile installation/share sheets, downloads, and host-specific theme/fullscreen/approval behavior are not proven by local browser/protocol tests.

[The operations runbook](operations-runbook.md) records provider alert delivery, capacity/load evidence, support mailbox delivery, and managed recovery/cutover with post-restore credential/deletion reconciliation as pending operator checks. Those external operations were not performed. No paid AI call or production key/credit validation was needed for this implementation.

New regression files are present locally but match the repository's existing local `/tests/` ignore rule. A later authorized commit must explicitly include the intended test files; `.gitignore` remains local and untracked. Optional browser harnesses/screenshots and private artifacts should stay local. Existing tracked tests were updated where the new schema and public error contract required it.
