# Release verification — October 1, 2026

The remaining core-flow tests now pass, including screenshot preservation.
The tested release was fast-forwarded to `main`. Both the Render Blueprint and
web service now use `main`, and post-deployment health and ChatGPT reads passed.

## Passed

- ChatGPT discovers all nine tools and displays the library widget.
- A synthetic text drop was saved once, unbookmarked, at revision 1.
- A separate ChatGPT conversation found that drop with keyword search and
  retrieved its exact original text, pool, bookmark state, and revision.
- Editing its note and bookmarking it advanced to revision 2. Retrieval
  confirmed the original text was unchanged and the item appeared in Saved.
- Moving the test drop to Trash advanced to revision 3; it was present in Trash
  and absent from All drops. Restoration advanced to revision 4, preserving
  the source, note, and bookmark. No permanent deletion was performed.
- Lint, TypeScript, production build, and all 139 automated tests passed after
  the screenshot-host repair. The preceding 137-test suite also passed both
  in the working checkout and in an archive containing only committed files
  with a fresh `npm ci`. The clean-checkout run used local Node 25.2.1;
  Render's Node 24 build also passed. This is not a completed GitHub CI run.
- ChatGPT preserved a synthetic PNG, then `draft_item` successfully used the
  configured OpenAI provider to transcribe it. The output matched the visible
  test text and left the source URL blank.
- After review, exactly one unbookmarked screenshot drop was saved in Projects
  and retrieved with `get_item`. The widget displayed the original image and
  preserved transcription. The displayed original contained 41,907 bytes;
  its SHA-256 matched the uploaded local fixture exactly.
- Render deployed commit `4299c7c` from `main` successfully. The Blueprint sync
  changed only the web service branch; no database or pricing change was applied.
  The public `/ready` endpoint returned HTTP 200 with `{"ok":true}`.
- A fresh `get_item` call in a separate ChatGPT conversation after that deployment
  displayed the original screenshot and preserved transcription, with its
  expected title, Projects pool, revision 1, and unbookmarked state.

## Repairs made during verification

- Versioned automated tests and synthetic PDF fixtures, excluding browser
  screenshots, local harnesses, credentials, and application data.
- Added a read-only-permissions GitHub Actions workflow for `npm run check`.
- Corrected the ChatGPT file descriptor to declare optional `file_name` and
  `mime_type`, requiring only `download_url` and `file_id`. Existing widgets
  using optional `filename` remain compatible.
- Added bounded metadata fallback for supported file types. The original
  bytes still pass full existing content validation and ownership checks.
  HTTPS host allowlisting, redirect rejection, and download limits remain.
- Confirmed that ChatGPT's actual tool binding supplied the exact Azure host
  `oaisdmntprcentralus.blob.core.windows.net`, which the old allowlist rejected.
  Added that exact host, with regression tests rejecting other Azure accounts,
  lookalike domains, credentials, non-HTTPS URLs, and nonstandard ports.

## Unresolved

- Earlier attempts reported `INVALID_ARGUMENT` and
  `SAFETY_STATUS_UNDETERMINED` from ChatGPT. A later ordinary, one-time-approved
  retry reached the server, identified the rejected host, and succeeded after
  its exact-host repair. No host safety setting or permission policy was changed.
- GitHub Actions run 36821767310 never started: GitHub reports failed account
  payments or a spending limit. No billing or security setting was changed.
  The user deferred CI work; leave its settings and billing alone.
- The in-app browser canceled an ordinary standalone download-link click after
  emitting `Page.downloadWillBegin` (`Page.downloadProgress` reported canceled,
  zero bytes). Its supported download helper saved the authenticated original
  successfully: 41,907 bytes and SHA-256 equal to the image displayed in ChatGPT.
  A normal-browser download-click check remains outstanding.

The synthetic rainwater-sensor drop remains restored and bookmarked, and the
synthetic screenshot drop remains unbookmarked, for inspection. The tests did
not modify pre-existing user drops.

## Next release gate

The branch transition is complete. Remaining public-launch checks are the
review scenarios in ChatGPT using the dedicated reviewer account, walkthrough
recording, normal-browser download click, and physical mobile verification.
No public submission or publication occurred.

## CSP, downloads, backup restoration, and submission draft

- Enabled ChatGPT's **Enforce CSP for custom apps** setting and left it enabled.
  The widget and original synthetic screenshot render under enforcement.
- The host iframe blocks direct download links and this ChatGPT host does not
  advertise the standard MCP download capability. Added feature detection and
  a host `openLink` fallback to the same drop on the authenticated website.
  Live verification opened the correct screenshot detail without changing it.
  The standalone download-helper result and click limitation are recorded above.
- Production widgets declare the canonical UI domain and use versioned resource
  `ui://drop-it/library-v3.html` to invalidate cached widgets. CSP resource and
  connection allowlists remain empty; no broad external allowance was added.
- `npm run check` passed lint, TypeScript, build, and all **145 tests**, including
  download-capability/fallback validation and draft-package regression tests.
  GitHub CI settings and billing were left alone.
- Render reports `49a7818` from `main` as its live deployment. The public `/ready`
  returned `{"ok":true}` after deployment. The live privacy page reports backup
  retention of up to seven days, matching logical-export retention rather than
  the shorter three-day point-in-time recovery window.
- Restored Render's October 1 16:05 UTC logical export into disposable local
  PostgreSQL 16 with no TCP listener. Application-level reads preserved both
  synthetic drops, revision/bookmark/note/source state, and the original PNG.
  All restored attachment hashes matched and no attachments were missing.
  The temporary database was stopped and removed; production was unchanged.
  This verifies logical-export restoration, not a managed PITR cutover.
- Created and uploaded `dist/drop-it-plugin-draft.zip` using the public metadata
  and the three-file allowlist. Portal metadata checks report **No Issues**, and
  domain verification passed. The draft is neither submitted nor published.
- The user completed the dedicated reviewer account and confirmed that the
  owner's recovery code was saved. Reviewer sign-in succeeded with an initially
  empty library, separate from the owner's existing drops.

### Reviewer handoff

Use only the reviewer account's synthetic sample library for the five positive
and three negative cases in `release/review-cases.json`.
Record sign-in, text save/search, screenshot transcription and original retrieval,
edits, and Trash/restore. Verify desktop and mobile behavior, supply the recording
URL, build the full package, finish the portal's MCP connection and review fields,
and resolve any scan findings before requesting final submission approval.

## Dedicated reviewer setup and live checks

- Seeded two synthetic samples through the standalone UI: a bookmarked desk
  cable organizer idea and a rainwater checklist screenshot. No private owner
  content was copied into the reviewer library.
- Standalone sign-in, text creation, search, note editing, bookmarking,
  Trash/restore, image upload, AI draft review, and original-image display passed.
  The text sample returned from Trash with its note and bookmark preserved.
- Downloaded the reviewer's original screenshot through the browser download
  helper: 41,907 bytes with SHA-256 equal to the uploaded synthetic fixture.
- A direct link to an owner-account test drop showed only "This item is no
  longer available" when signed in as the reviewer. No owner content appeared.
- With explicit user approval, connected the reviewer account to OpenAI's
  submission setup. The portal reports Authorized, Configured, Domain verified,
  and discovered all nine tools. This does not replace the owner's existing
  developer-plugin connection in ChatGPT.
- With separate explicit approval, saved the dedicated login and sign-in
  instructions in OpenAI's reviewer-credentials fields. The portal confirmed
  "Progress saved." No password was added to source, docs, or the ZIP. If the
  password changes, the portal credentials and affected OAuth connection must
  be updated before review.
- The scan identified external-system annotations on AI drafting and file
  import; search also initially needed review. Corrected `openWorldHint` for
  `draft_item`, `search_items`, and `upload_source`. Private-only tools remain
  bounded; file-host restrictions, scopes, and owner checks are unchanged.
  Lint, typecheck, build, and all 145 tests passed after the final correction.
- Render deployed `d393272` from `main` and `/ready` returned `{"ok":true}`.
  The final portal rescan reports **No issues found in the latest MCP scan**.
  This is successful automated scanning, not approval for publication.
- Five positive and three negative review scenarios are present in the draft.
  The supporting-content page explicitly requires a walkthrough recording URL
  in a newly uploaded ZIP. The user instructed us to leave the app unsubmitted.

These standalone checks and successful MCP discovery do not establish that all
eight model-driven review scenarios have passed using the reviewer account.

## Pre-launch tool naming

The public MCP identifiers now use drops consistently: `search_drops`,
`draft_drop`, `get_drop`, `save_drop`, `update_drop`, `wipe_drop`, and
`restore_drop`. `upload_source` and `get_profile` retain their names. Earlier
sections record the tool names used at the time of those historical checks.

`wipe_drop` still moves one owned drop to seven-day Trash using its current
revision. The rename changes no stored data, HTTP routes, ownership checks,
OAuth scopes, annotations, or retention behavior. The widget uses resource
`ui://drop-it/library-v4.html`; refresh the installed plugin's tools and reopen
old widgets after deployment. Review scenarios and the draft ZIP use the new
identifiers. No duplicate legacy tools are exposed.
