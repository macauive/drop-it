# Public URL capture — implementation and verification

November 13, 2026. Evidence collected before the separately authorized production release. The release candidate packages extension 0.2.8; no store submission, provider plan or billing change is included.

The website and Chrome extension use one backend retrieval/draft implementation. An explicit **Retrieve page & suggest fields** action sends only the public source link to Firecrawl, supplies a bounded fetched excerpt to the existing AI draft provider, and opens no automatic save. Original text, URL, notes and files remain separate. Page snapshots carry requested/final URLs, provider, server capture time and truncation provenance; they are immutable after saving, searchable and included in backups.

## Automated evidence

`npm run check` passed: lint, typecheck, production web build and **314 tests**, with zero failures/skips. `npm run build:extension` and the generated-package regression test also passed. The final snapshot-validation change additionally passed its focused extraction tests and a fresh typecheck/lint/web build.

- Mocked Firecrawl transport: fixed API destination, request options, HTML-only output, metadata validation, quota/HTTP/network/malformed/oversized failures, bounded snapshot and provenance.
- Destination checks: embedded credentials, signed/unknown query parameters, secret fragments, sensitive paths, IP literals, private/reserved IPv4/IPv6 and mixed public/private DNS; pinned DNS, redirect validation/downgrade/hop limits, non-HTML rejection and canceled DNS lookup.
- Synthetic database integration: extraction without saving, originals/notes preservation, owner/URL-bound references, immutable snapshots, keyword search isolation, duplicate review, idempotent retries after snapshot expiry, missing credentials/AI and provider failures, concurrency/durable daily admission limits, cleanup and portable backup round trip.
- Real local HTTP endpoints with mocked providers: website/extension parity, origin/session/bearer/client/scope/account checks, no attachment or arbitrary source-ID access, save/retry/read behavior and cross-owner rejection.
- Shipped extension controller through its Chrome API seam: edits arriving during retrieval, cancellation, changed source, disconnect, original selection/notes, and frozen save retries. Existing capture, OAuth, duplicate, account isolation and packaging tests remain in the required suite.
- `npm run build:extension` succeeded. ZIP inspection found exactly the 13 allowlisted manifest/config/JavaScript/HTML/CSS/icon files, unchanged permissions (`activeTab`, `scripting`, `contextMenus`, `storage`, `identity`), and only the configured Drop It service host. No env files, server credentials, private data or dependencies are packaged.

## Live-provider and in-app browser evidence

Follow-up verification on November 13, 2026 completed the earlier blocked checks. The Firecrawl key was entered through the ignored local hidden-input helper, saved only in owner-only `private/.env` (mode 600, directory mode 700), and loaded by a newly started **disposable loopback test server**. Other secret settings were preserved. No key value was entered in chat, printed in tool output, copied from MCP credentials, or placed in source. A direct comparison found no key matches in tracked files, the generated web bundle or any extension ZIP entry.

The unmodified production extractor passed live requests using that runtime credential:

| Public input                                              | Result                                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://docs.firecrawl.dev/authentication`               | HTML documentation retrieved; 30,000-character snapshot; truncation flag set                                                                               |
| `https://firecrawl.dev/blog/firecrawl-vercel-marketplace` | Public article retrieved; validated redirect to `https://www.firecrawl.dev/blog/firecrawl-vercel-marketplace`; 7,166-character snapshot without truncation |

The in-app browser then exercised the real website and shipped popup/controller through the local Chrome API adapter, with real Firecrawl retrieval and the existing real OpenAI draft provider:

- Article capture in the popup produced an editable factual summary, an existing Reading pool and suggested tags. The original URL retained its fragment and original hostname; snapshot provenance separately recorded the final `www` URL. Selected synthetic text stayed unchanged. Explicit Save created the drop.
- Website documentation capture retained the original typed text, personal note, manually entered summary and title revised during the live request. Suggested pool/tags and a separate snapshot appeared for review; the UI marked the snapshot as an excerpt. Explicit Create saved it, and detail view preserved the separate originals and note.
- A keyword query for `fcr_`, present only in the fetched documentation, found the saved drop. Switching the disposable fixture to account B exposed only B's own pool/drop and no result for that query. The final preview was restored to account A.

Controlled failures used the default mocked-provider fixture, rather than exhausting a real account's quota:

- Both popup and website ignored canceled results; changing the website source URL invalidated the old result. No late snapshot or field replacement appeared.
- Both clients showed the quota notice and allowed manual saving without a snapshot. The website also warned about an existing normalized URL and required **Create another copy** before the synthetic duplicate save.
- A popup save committed but deliberately lost its response. Fields and the exact retry remained frozen after a simulated controller/worker restart and popup reload. Retry confirmed the same saved drop; the website count increased once, from four to five.
- The website at 390 × 844 had a 390-pixel content width with no horizontal overflow. The popup's actual intrinsic body measured 380 × 580. These are browser layout checks, not physical-device evidence.

Screenshots are local-only artifacts under `dist/firecrawl-verification/`, including `live-website-review.jpg`, `live-saved-capture.jpg`, `live-extension-review.jpg`, `extension-review-380.jpg`, `website-originals.jpg` and `website-mobile-fallback.jpg`. They contain public/synthetic content and are excluded from packages and Git.

**Native follow-up:** installed-extension sign-in, real identity-window consent, URL capture, live retrieval/review/save, offline draft preservation, an observed inactive service worker, reconnect and exactly-once save were subsequently verified directly in Brave’s native Chromium runtime on November 13. See [the native record](../extension/VERIFICATION.md). Stock Google Chrome was not installed; physical mobile share sheets remain unverified.

## Remaining release checks

1. The requested installed native Chromium smoke test passed in Brave; see the native record above. Verify stock Google Chrome/minimum-version compatibility and the remaining store/context-menu/iframe/update gates before distribution.
2. For a hosted release, configure `FIRECRAWL_API_KEY` in the platform secret manager, rehearse migration 13 on a restored database, deploy the approved commit, and verify the live retrieval/save flow. The extension release candidate is 0.2.8. The local PostgreSQL 16 dump/restore rehearsal now applies migrations through 13 twice and verifies unchanged source/file data and active connections.
3. Native fixture mode uses `DROP_IT_NATIVE_CAPTURE=1` alongside the optional live-provider flag. It derives the real callback from the existing public extension key, writes only a private temporary synthetic sign-in file, and supports `SIGUSR2` to toggle its loopback listener without changing system networking. Build/copy a test package for the printed loopback origin; keep the public build separate. Reproduce default mocked UI checks with `node --import tsx tests/extension-preview.ts`. To use the existing server-side Firecrawl/OpenAI configuration with a fresh temporary database and synthetic account, explicitly run `DROP_IT_LIVE_CAPTURE=1 node --import tsx tests/extension-preview.ts`. This flag never reuses the configured production database, origin, email transport or sessions. Real provider requests incur their normal usage; no plan or billing settings are changed.

## Production release rehearsal — November 13, 2026

Created a fresh managed logical export at 19:51 UTC and restored it into an isolated local PostgreSQL 16 cluster using a private Unix socket, with external database access still disabled. Migration 12 to 13 passed twice. Row fingerprints for all 18 existing non-migration tables matched exactly, including original attachment bytes and credential records; existing sources acquired only a null snapshot and the new retrieval table was empty. No live data was modified by the rehearsal. The temporary restored cluster was stopped and removed. The provider dashboard showed a three-day PITR window and at least seven-day logical-export retention; this was a logical restore rehearsal, not a managed PITR cutover.
