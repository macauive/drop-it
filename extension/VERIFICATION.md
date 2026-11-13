# Chrome extension verification

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
