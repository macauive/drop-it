# Drop It for Chrome

A Manifest V3 companion for the existing Drop It library. The toolbar captures the current page's title and URL, plus selected text when available. Right-click menus capture a page, a selection (including its frame URL), or a link's destination. Every capture opens an editable review form before saving. This version does not extract full articles, fetch source pages, invoke AI, or capture screenshots.

Version 0.2 adds account-bound drafts and retries, **New capture / Discard draft**, existing pool/tag suggestions, an assigned-key display, and account-labelled connection/reconnect status. The suggested capture shortcut is **Command+Shift+Y** on macOS and **Ctrl+Shift+Y** elsewhere; assign or change it at `chrome://extensions/shortcuts` if Chrome reports a conflict.

Version 0.2.7 uses a compact 380-pixel popup with Connect at the top, optional notes, and a pinned Save button. The extension name, toolbar tooltip, and popup title are **Drop It**. Right-click reviews open in normal extension tabs. Draft replacement/discard uses an HTML confirmation overlay with keyboard focus containment and Escape cancellation, without requiring browser-window or native-dialog support.

Toolbar capture reads the last-focused tab's URL/title alongside selected text when metadata is unavailable. Reopening restores an owned draft before requesting renewed page access; title, text, source link, notes, and frozen retries remain intact. If a fresh capture cannot obtain a page address, an editable manual form opens and requires a valid source link before saving. Field-level input/change/blur handlers and popup lifecycle events persist changed values, skip identical snapshots, and surface storage errors. Permissions remain unchanged. After rebuilding, reload the installed extension on `chrome://extensions` and reconnect.

## Build and install locally

From the repository root:

```sh
npm ci
npm run build:extension
```

The unpacked extension is `dist/chrome-extension`; the distributable archive is `dist/drop-it-chrome.zip`. In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `dist/chrome-extension`. Pin Drop It to the toolbar. Only the generated folder is installable; the source folder intentionally has no generated PNG icons.

The default build connects to the public Drop It service. Its backend must include the new extension routes and OAuth scope before sign-in works. In that service's environment, append the exact callback printed by the build to the existing comma-separated `OAUTH_REDIRECT_URIS`. Preserve the ChatGPT and other existing callback entries. The current development identity uses:

```text
https://aiaflcebjdegligolapfpgdplbofplbo.chromiumapp.org/drop-it
```

Deploy/restart the backend after its configuration and code are ready. Connect in the extension, sign in through the ordinary Drop It website, approve capture access, and reopen the toolbar popup if Chrome closed it during sign-in. No password or OpenAI API key is entered into the extension.

For an isolated local backend, build with its origin instead:

```sh
npm run build:extension -- http://localhost:4317
```

Append the same callback to that local backend's redirect allowlist. The build permits HTTP only on loopback and gives the extension host permission for exactly that build's service. Rebuild without arguments to restore the public-service package.

## Capturing

- Click the toolbar icon for a page or the current selection. Right-click selected text or an HTTP/HTTPS link for the corresponding capture action.
- Review the title, original text, source link, pool, tags, and notes. Save creates an unbookmarked item in **All drops**, using the same library as the website and plugin.
- Pool autocomplete and comma-aware tag suggestions use bounded metadata from the connected account's active drops. You can always enter new labels manually. Suggestions never request full library-read permission.
- **New capture** replaces a draft with the current selection/page after a local discard confirmation. **Discard draft** removes only the local review. If a save's result is uncertain, the confirmation reminds you to check the library before discarding. These controls work in right-click review windows using the original source tab; a closed or restricted source tab produces an actionable error.
- Existing-source warnings link to matching owned drops. An explicit checkbox permits another drop from that source.
- Interrupted saves preserve the exact request and show **Retry save**. Retrying confirms the original save without creating another item. Drafts survive popup closure and service-worker restarts within the current browser session; retain at most 12 drafts for one hour. Browser restart, extension reload/update, or disabling the extension clears session storage.
- Restricted browser pages, non-web links, URLs containing credentials, and selections longer than 50,000 characters are rejected. Toolbar capture reads the top frame's selection; use the right-click selection action inside an iframe.
- The **Capture current page** action after saving also works in a right-click review window while its source tab is still open.

## Auth, privacy, and permissions

The extension uses the existing authorization-code/PKCE provider with random state, exact callback validation, rotating refresh tokens, revocation, and the new `capture:write` scope. That scope is available only to a client with one explicitly allowlisted Chrome callback and cannot be combined with the broader library scopes. It cannot use MCP library reading, editing, or deletion tools. The consent screen describes capture access and pool/tag suggestions. No database migration or additional provider is required.

`GET /extension/v1/connection` validates the bearer connection and returns its account identifier and a username label (or a short account identifier). `GET /extension/v1/suggestions` returns up to 100 pool names and 200 tags from that account's active drops; it accepts no query parameters and never returns item contents. Suggestions are cached for up to one minute in browser-session memory and cleared on account changes. `POST /extension/v1/capture` accepts bounded, strictly validated capture fields and a required `accountId` precondition, then returns only the created drop's ID, title, and retry status. Ownership comes exclusively from the token: an account mismatch rejects the save before any mutation, even with a stale or tampered client. Cookies do not authorize these routes. A supplied Origin must match the enabled extension and its registered client; privileged requests without Origin still require a token for an enabled extension client. Existing website CSRF and MCP origin policies stay in place.

Access/refresh tokens and drafts are kept in `chrome.storage.session`, restricted to trusted extension contexts. Tokens are never returned through the popup message bridge, written to local/sync storage, or logged. Browser restart requires reconnecting. Expired/revoked authentication and network interruptions preserve local drafts for reconnecting to the same account. Bound drafts, frozen retries, saved confirmations, and suggestions are cleared when a different account connects; open review windows immediately clear the old account's source text and labels. Explicit **Disconnect** revokes the token family and clears credentials and local captures; if the service is unreachable, it still clears local data and directs the user to website Settings to confirm revocation. Legacy drafts without provable account ownership are discarded during initialization. Password changes, sign out everywhere, and disconnect-all retain their existing server-side revocation behavior.

The extension account is the one shown in its connection status. Signing into a different account on the website does not silently change the extension's OAuth connection. The website still requires its own matching account session to open an owned drop.

Permissions are `activeTab` and `scripting` for user-invoked capture, `contextMenus` for right-click capture, `identity` for website sign-in, `storage` for browser-session memory, and a host permission for the single Drop It service origin. There is no persistent page observer, broad browsing permission, analytics, sync, cookie access, remote executable code, or exposed content-script message bridge. Only the reviewed link/text/metadata is submitted when Save is clicked. Saved content follows the existing service privacy and retention policies.

## Verification and store release

Run `npm run check` and `npm run build:extension`. Regression tests cover capture validation, full HTTP OAuth/consent/token/refresh/revoke flow, owner isolation, cookie/origin/scope enforcement, duplicate override, idempotent retries after a lost response and worker restart, canceled sign-in, state/PKCE validation, refresh failure, and the archive's explicit file allowlist.

The additional suites cover account changes with frozen retries, same-account reconnect, failed offline revocation, stale review windows, separate tab captures, concurrent duplicate saves, discard/reset, expired and legacy drafts, capture retention limits, large Unicode selections, suggestion-cache expiry/isolation, and identical website/MCP retrieval. See [verification evidence and remaining native checks](VERIFICATION.md).

For reproducible browser checks, first build the web UI and extension, then run `node --import tsx tests/extension-preview.ts`. It prints a loopback popup URL and creates disposable synthetic accounts/data in a temporary directory. Its Chrome API adapter uses the real extension controller, OAuth endpoints, and backend, with bounded fixture scenarios for failures. No real account, third-party send, or production data is used. Stop the process to remove the temporary database. The preview helper is excluded from all packages.

The in-app browser can verify the real popup with a local Chrome API adapter and temporary backend. It cannot load Chrome's extension APIs. Before distribution, smoke-test the generated package in Chrome: toolbar and right-click actions, iframe selection, Chrome's identity window with popup closure, session expiration/reconnect, duplicate review, server revocation, and a real interrupted save. Local adapter tests do not prove native Chrome behavior or live-service readiness.

Upload the ZIP as a draft in the Chrome Web Store developer dashboard. Obtain the store-assigned public key and replace `extension/public-key.txt` with that one-line public key, rebuild, compare the unpacked and store IDs, and append the resulting exact callback to the server allowlist. The included key provides a stable development identity; it is public and no private signing key is retained. Preserve any development callback still needed. Prepare the listing, screenshots, permission justifications, reviewer access, and privacy disclosures, then submit for review when authorized. This build does not submit or publish an extension.

Official references: [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [identity](https://developer.chrome.com/docs/extensions/reference/api/identity), [session storage](https://developer.chrome.com/docs/extensions/reference/api/storage), [consistent extension identity](https://developer.chrome.com/docs/extensions/reference/manifest/key), and [Chrome Web Store publishing](https://developer.chrome.com/docs/webstore/publish).
