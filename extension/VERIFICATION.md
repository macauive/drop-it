# Chrome extension verification

## Version 0.2.10 automatic capture preparation — November 16, 2026

The extension automatically fills the title, summary, pool and tags during capture review. It uses captured text when present, retrieving a public page automatically when only a link is available. The retrieval/suggestion button and separate snapshot controls are removed; retrieved text is available in the editable page-text field. Original selections, source links, notes and user-edited metadata are preserved. The website's explicit retrieval flow remains available.

- `npm run check` passed lint, typecheck, production web build and **341 tests**, zero failures/skips. New controller tests cover text-based drafting without a duplicate fetch, automatic link retrieval, once-per-source preparation across worker restart, shared in-flight requests, concurrent edits, source invalidation, unavailable providers and account changes. HTTP tests cover the optional strict boolean `fetchPage`, required text when retrieval is disabled, owner isolation and compatibility with older extensions.
- In-app browser checks used the shipped popup/controller and a disposable synthetic backend with deliberately slow drafting. Preparation started without another action. Editing the title and choosing Save during preparation preserved that title and saved the automatically filled summary, Reading pool and documentation tag. The library showed one created item.
- A forced AI failure showed a concise notice while retaining the captured text and summary; ordinary Save still succeeded without a retry/suggestion button. A link-only capture automatically retrieved editable source text and populated metadata; reloading its review retained the completed fields. Untrusted HTML/source instructions remained literal textarea content.
- Public extension build 0.2.10 passed. Permissions, OAuth scopes, source ownership checks, immutable save retries and database schema are unchanged. The backend accepts older clients' retrieval requests; the new extension should be installed after the backend update. Privacy/feature descriptions now disclose automatic extension preparation.

Local review screenshot: `dist/automatic-review-0.2.10.jpg`. These are local browser/adapter checks; production/native verification follows release.

## Version 0.2.9 page-content capture — November 16, 2026

Local release candidate: toolbar and page context captures now include bounded readable text and an editable source-derived summary by default. Selected passages remain exact; linked destinations require explicit retrieval. Page text is visible in review and saved as original source text. Hidden decoration, forms/editable fields, navigation and large symbol-only animation rows are excluded. Unavailable content is explicitly labelled link-only. No permissions, OAuth scopes, dependencies or database schema changes were added.

- The in-app browser exercised the shipped reader on synthetic DOM fixtures with more than 100,000 characters of decoration, CSS/ARIA-hidden content, a hidden main ancestor, form/editable fields, source code and multilingual prose. Useful later sections remained, code was preserved, hidden/form data was excluded, 50,000-character truncation was explicit, and selected text remained exact (including symbols and Unicode). Explicit page mode also read page content when a selection existed.
- The shipped popup/controller with the loopback Chrome API adapter produced page text and a summary before retrieval. Ordinary **Save drop** succeeded; website detail exposed the same original text and source-derived summary. The final popup/save check was repeated after review refinements. This is adapter/browser evidence, not a native installed-extension test.
- The updated production extractor, running locally with the existing server-side credential, retrieved `https://macdigital.ai/#services`: **3,082 characters**, no truncation, zero decorative rows, and all five checked sections present: Customer inquiries, Documents, Team knowledge, Drop It and Amountly. No production drop was created or modified.
- Final `npm run check` passed lint, typecheck, production web build and **336 tests**, with zero failures or skips. Regression coverage includes original-text saving without provider retrieval, frame scoping, navigation mismatch rejection, payload bounds, preserved code/Markdown/languages, and filtering before snapshot limits. `npm run build:extension` passed; the allowlisted public extension package now includes `read-page.js`, with unchanged permissions and identity.

Local screenshots: `dist/page-capture-review-0.2.9.jpg` and `dist/page-capture-saved-0.2.9.jpg` (synthetic account/content only). No store submission or website SEO changes were made.

### Native Brave release checks — November 16, 2026

Ran 0.2.9 through Brave's real extension APIs and identity window using a new disposable loopback account/database, with the existing public extension identity. The installed unpacked assets were backed up before the test and restored afterward to production 0.2.9 assets. The installed folder retains its existing `drop-it-chrome-0.2.8` name, while the loaded manifest is 0.2.9. The public ZIP and `dist/drop-it-chrome-0.2.9` target only `https://dontdropit.app`.

- Toolbar capture of Mac Digital saved readable text and its source-derived summary without retrieval. Native **Open drop** and original-source read-back retained the service/product content without ASCII decoration.
- Native right-click selected-text capture preserved the chosen sentence. Duplicate review required an explicit **Save another drop from this source** before saving. Native right-click page capture populated the full readable page text and summary. Right-click **Save link to Drop It** captured the Amountly destination, explicitly labelled it link-only, and saved without text from the parent page.
- A documentation capture exposed syntax-highlighted code fragments being separated by inserted newlines. The reader now joins fragments from the same code element with their original whitespace. The native retest retained the curl example's arguments, continuation characters and indentation. The DOM fixture now also checks highlighted spans and indentation.
- Edited a documentation draft's title, tag and note, closed the popup, and observed **service worker (Inactive)**. Reopening while the disposable service was offline reported that the draft was preserved. Reconnecting restored the edited fields, captured page text and formatted code.
- Took only the disposable listener offline while the connected popup remained open. **Save drop** failed safely at its connection check. Closed/reopened, restored the listener and saved successfully. Native read-back retained the exact note, tag, URL fragment and code. Searching for the unique test tag showed **1 - 1 of 1**. This tests service unavailability; committed-response loss remains automated coverage.
- Final `npm run check` after the code-whitespace fix passed lint, typecheck, production build and **336 tests**, zero failures/skips. The public extension build passed. Local evidence: `dist/native-default-page-0.2.9.png` and `dist/native-offline-retry-0.2.9.png`. No production library data was changed by these native checks. The disposable backend was stopped and its temporary data/sign-in file removed.

## Version 0.2.8 release preparation — November 13, 2026

Version 0.2.8 packages the Firecrawl capture update for the public service. The native evidence below was collected immediately before the version bump; no extension runtime code changed during release preparation. Permissions and the stable OAuth callback are unchanged. Reloading or updating clears browser-session drafts, so finish pending captures first.

## Native installed-extension verification — November 13, 2026

Verified the current unpacked 0.2.7 implementation directly through native app controls in **Brave Browser**, bundle version `157.1.99.55` (build `199.55`), using Chrome's real extension APIs. Stock Google Chrome was not installed. This is native Chromium evidence, separate from the earlier Owl/user-reported checks and the in-app Chrome API adapter.

The user enabled Developer mode. Loaded `dist/native-chrome-test` with the existing extension identity `aiaflcebjdegligolapfpgdplbofplbo`. Its only service host was the disposable loopback backend. The standard public build and ZIP were left pointed at the public service; production and the existing Owl installation were untouched. No extension permissions or OAuth scopes were broadened.

Observed directly:

- A toolbar invocation on a public article captured its real page title and exact URL, including `#native-test`.
- **Connect Drop It** opened a real native identity/sign-in window. Signed into a newly seeded synthetic account, reviewed capture-only consent, and connected. The identity window closed; reopening the real `chrome-extension://…/popup.html` restored the original draft and showed `@capture-a`.
- Edited title, tag and personal synthetic note, then retrieved the article through live Firecrawl and generated suggestions through the existing live AI provider. Manual edits remained intact; the snapshot showed its final source URL and capture time. Explicit Save showed **Saved to your library**. Authenticated read-back confirmed exactly one saved drop, original URL fragment, the chosen tag/note and a separate 7,166-character Firecrawl snapshot.
- Captured a documentation URL with `#native-offline`, added a different title/tag/note, and retrieved its 30,000-character bounded snapshot. Took only this loopback backend offline by closing its listener; other network access was not changed.
- Saving while the backend was unreachable showed **Connection unavailable** and that the draft was preserved. This outage failed at the pre-save connection check, before the capture POST; it was not a successful-response-loss injection.
- Closed the popup. The real extension manager showed **service worker (Inactive)**. Reopened the popup on the original source tab while still offline: **Restored your draft** displayed the edited offline-test title.
- Restarted the same disposable backend on the same origin/database, then used **Check connection again**. The same account connection recovered, retaining the title, exact URL, tag, note and snapshot. Save showed success. Read-back found exactly one offline-test drop, its original fragment, preserved note/tag, and the 30,000-character snapshot. **Open drop** opened that saved item in the native browser's authenticated website.

The initial fixture exited when its final listener closed. Its native mode now holds an explicit keep-alive timer; an additional mocked-provider lifecycle smoke test verified offline refusal, process survival, online readiness recovery and temporary-state removal. The interrupted test above was recovered from its original temporary database, without resetting the owner or OAuth connection.

After verification, disabled only the temporary Brave test extension, stopped its backend, and removed its disposable database/sign-in file. Developer mode was left as the user selected it. Local screenshots under `dist/firecrawl-verification/` include `native-reviewed-draft.png`, `native-offline-restored.png`, `native-worker-inactive.png` and `native-retry-saved.png`; these contain public/synthetic data and are excluded from Git and packages.

Final `npm run check` passed lint, typecheck, web build and **314 tests** with zero failures/skips. `npm run build:extension` passed. The native copy's JavaScript/HTML/CSS/icons matched the standard generated build byte-for-byte; only its generated service configuration and manifest pointed to loopback. The additional fixture lifecycle smoke check passed process survival while offline, restored readiness and disposable-state cleanup.

Remaining release coverage: stock Google Chrome and minimum-version compatibility, store-assigned identity, native context-menu/iframe/OS-shortcut cases, browser restart/update lifecycle, and publication. Successful-response-loss/idempotency remains covered by automated tests and the in-app adapter test; the native offline check above establishes unavailable-service recovery.

## Version 0.2.7 follow-up — November 12, 2026

`npm run check` passed lint, typecheck, web build, and **303 tests**, with zero failures or skips. `npm run build:extension` passed with the existing extension identity and service origin. No extension permissions or OAuth scopes were added.

- Regression tests cover missing tab metadata, renewed page-access failure after editing, preservation of frozen retries, manual-source validation, navigation during capture, tab/account isolation, and context-menu review tabs without creating browser windows.
- The local preview deliberately suppressed native dialogs, omitted tab metadata, denied page access, and prevented note events from bubbling to the form. Browser checks verified the HTML confirmation overlay and keyboard focus, restoration of title/source/notes after reopening and worker restart, manual fallback capture, and note persistence after immediate closure.
- User-operated tests in the installed extension verified connecting, saving a page, selected text, and a link. Library reads confirmed the selected text and link destination in the existing account. Disconnect cleared an open review, followed by same-account reconnect. Version 0.2.7 preserved the exact note after popup closure/reopening; title and source recovery had already passed.

The installed-host screenshots identify Owl, the app's Chromium browser. These observations do not establish behavior in a separate stock Chrome installation or across supported Chrome versions. The available browser automation cannot inspect extension pages directly; installed-extension interaction results above were reported by the user.

**Deferred:** The installed-browser offline/reconnect/save smoke test remains unperformed at the user's request. It is not counted as a pass. Automated offline/idempotency coverage passed, but does not replace this manual check. Native testing with a different account was also not performed; account-isolation coverage is automated and local-preview evidence.

Current local logs and synthetic screenshots are in `dist/extension-verification/`, including `notes-0.2.7-check.log` and `note-recovery-0.2.7.png`; these artifacts are excluded from Git and distributable packages.

## Initial 0.2 build — November 11, 2026

The 0.2 build has 26 extension regression tests. The project-wide `npm run check` includes these suites, lint, typecheck, the web build, and the existing backend/widget/security tests. `npm run build:extension` creates the reviewed ZIP and unpacked folder, with exactly one configured service origin and no additional extension permissions.

Final run: **293 tests passed, zero failures or skips**; lint, typecheck and the web build passed. The extension build also passed. The full local check log is `dist/extension-verification/check.log` and is excluded from packages. Temporary preview data was removed after verification.

### Automated coverage

- Page, selected-text, iframe-URL and link capture; unsafe URL rejection; source preservation; validation and 50,000-character Unicode selections.
- Full HTTP registration, authorization, consent, PKCE code exchange, refresh and revocation; cancellation/state rejection; least-privilege scope, origin, cookie and client enforcement.
- Account A frozen retry followed by account B sign-in; stale-window save rejection; server-side account preconditions; clearing local captures and suggestions; preserving same-account drafts/retries through authentication expiry.
- Explicit disconnect while offline; local data clearing despite failed server revocation; bounded draft count/expiry and discarding legacy drafts without provable ownership.
- Separate tab captures and edits, rapid duplicate Save requests, and retry after response loss and controller restart.
- Owned metadata suggestions excluding Trash and other accounts, cache expiry, manual fallback, strict endpoint input handling, and shortcut manifest registration.
- Real website and MCP `get_drop` endpoints return the same item, original text/URL, tags, pool and notes after extension capture. Concurrent HTTP retries create exactly one item.
- ZIP allowlist, service-origin validation, manifest permissions, public development identity and absence of externally exposed scripts/bridges.

### In-app browser observations

Used the actual popup with the loopback preview adapter and temporary synthetic backend:

- Connected account A; opened two review windows; switched to B. Both windows cleared A's source and notes, hid the stale draft, and showed only B's pool suggestions.
- Verified pool suggestions and comma-aware tag suggestions; account-labelled status; new capture, explicit discard, and cancel-with-Escape behavior. Keyboard focus returns to the title after replacement and to New capture after discard.
- Simulated offline transport, then restored it without losing edits. Revoked the connection server-side, then reconnected to the same account with original text, tags, pool and notes preserved.
- Dropped a successful save's response, restarted the controller, reloaded the popup and retried. The website showed one captured item; its original text and notes matched the popup.
- Verified iframe source URL and selected Unicode text, link destination capture, restricted-page feedback, and keyboard-only navigation and save.
- Inspected dark/light themes and a 400×600 viewport. No horizontal overflow; controls below the fold remain keyboard reachable. Browser console had no errors or warnings during these checks. Temporary emulation overrides were reset.

Screenshots are local build artifacts in `dist/extension-verification/`: `capture-v2-dark.png`, `capture-v2-light.png`, and `website-source-v2.png`. They contain only synthetic fixture data and are excluded from distributable packages.

### Native gates at initial verification

The available browser automation exposes the in-app browser, without a native Chrome session or installable extension runtime. The adapter checks above do **not** prove native extension installation, Chrome identity-window behavior, actual context-menu dispatch/activeTab grants, OS shortcut registration/conflicts, or Chrome's real service-worker suspension/startup/update behavior. Those checks require loading the unpacked package in Chrome. Test both the minimum supported Chrome version and a current stable version before store submission.

At the initial 0.2 verification, backend deployment and the exact extension callback were still pending; no live-account verification or production deployment had yet been performed for that build. Subsequent installed-extension checks are recorded above. Store-assigned identity, reviewer access, privacy disclosures and store submission remain separate release work. No extension publication has been performed.
