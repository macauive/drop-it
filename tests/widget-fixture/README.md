# Local React widget verification

This fixture serves the actual `dist/web/index.html` inside an iframe and uses
the installed MCP Apps SDK `AppBridge`. Its tools and uploads are synthetic and
in memory. It loads no application configuration, credentials, account data,
database, or external AI provider. The only environment input is the explicit
test opt-in flag. Use the in-app browser.

```sh
npm run build:web
DROP_IT_BROWSER_TEST=1 node --import tsx tests/browser-widget.ts
```

The server prints a loopback `origin` and an absolute `seedPath`. Open that
origin. Select only the printed `widget-file-b.txt` when a scenario needs a file.
Stop the process with Ctrl-C to remove the temporary fixture directory.
`Reset connected widget` clears all synthetic state and reloads the iframe.
After rebuilding the application, reset the iframe to load the current built
HTML; the server reads it afresh for each iframe navigation.
The exact tool request arguments, request counts, pending requests, and current
synthetic records appear beneath the controls. Host result injection itself
does not count as a widget tool call.

## Hydration, queued results, and pagination

1. Start connected. Expect **Host initialized** and **zero tool requests**.
2. Click `Inject empty search` (`inject-empty`). Expect zero results despite six
   synthetic records. No extra search should run.
3. Click `Inject filtered page` (`inject-search`). Expect drops 3–4, limit 2,
   offset 2, Saved, pool Testing, tag fixture, and query synthetic. Click Next
   and Previous inside the widget. Verify request offsets 4 then 2 and the
   exact original date boundaries `2026-09-01T12:34:56.789Z` and
   `2026-10-01T12:34:56.789Z`.
4. Inject draft A (`inject-draft`), edit its title and transcription, then inject
   empty search. Expect the edited draft to stay open; the latest-result button
   must remain unavailable until the current draft is closed. Cancel closing
   once and verify the fields remain; then discard and open the queued result.
   Expect the supplied empty result without a new unfiltered search.

## Reconnect and cancellation

1. Click `Reset without host` (`reset-timeout`). Wait about 15 seconds for the
   widget's connection error.
2. Click `Enable host for Retry` (`enable-host`), then the widget's visible Retry.
   Expect the error to clear, initialization to succeed, and zero search calls.
3. Inject a result and check that the widget remains usable.
4. `Notify cancelled tool` (`cancel-tool`) sends a synthetic cancellation. Check
   the displayed error and recovery independently from a disconnected bridge.

## Delayed operations

1. Inject detail A (`inject-detail`) to load original bytes, or
   `inject-detail-bare` to require the explicit Load original file action.
2. Edit a field. Select the relevant tool in `delay-tool` and click Arm delay
   (`hold-next`). Submit the action in the widget.
3. While pending, try another mutation, typing, Escape, and the close button.
   Expect fields disabled, the panel retained, and exactly one tool request.
4. Release failure (`release-failure`). Expect the edited text retained and
   controls usable again. Repeat and release success (`release-success`).
5. Exercise `update_drop`, `get_drop` for reload/original, and `save_drop` in a
   draft. For restore/wipe, use only these synthetic records. The host request
   log and record state show whether any extra action ran.

## Attachment identity and reviewed transcription

1. Reset and inject draft A. Expect a visible retained original attachment and
   the original text `Immutable synthetic source A.`.
2. Correct its transcription, then select the printed file B. Cancel the
   discard prompt and verify A and the correction remain. Select B again and
   confirm discard. Metadata may remain; A's text and attachment must not.
3. Remove B. Save a manual draft and inspect `save_drop`: A must not reappear,
   and no removed attachment ID or former transcription may be sent.
4. In a fresh run attach B and type a correction. Save and inspect the request:
   `source.originalText` must be the immutable text from B and
   `reviewedTranscription` must contain the correction as a separate field.

Record observations and failures separately; this file is a checklist, not a
claim that the scenarios passed. Passing this synthetic host does not verify
ChatGPT OAuth, approvals, host file upload/download policies, physical mobile
behavior, or the release walkthrough.
