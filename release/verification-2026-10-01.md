# Release verification — October 1, 2026

The remaining core-flow tests now pass, including screenshot preservation.
The release configuration targets `main`; verify the Render service and Blueprint
sources and a post-deployment read before declaring the transition complete.

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
- ChatGPT showed "CSP off" during these developer-mode tests; widget behavior
  under enforced CSP still needs verification before public submission.
- The embedded download-link click did not emit a browser-automation download
  event. Original-image display and exact byte preservation were verified
  independently; do not claim the download interaction was verified.

The synthetic rainwater-sensor drop remains restored and bookmarked, and the
synthetic screenshot drop remains unbookmarked, for inspection. The tests did
not modify pre-existing user drops.

## Next release gate

Merge to `main`, switch both Render source branches, and verify health and
ChatGPT retrieval after deployment. Broader public-launch checks
(review account, submission walkthrough, enforced CSP, and backup restore)
remain separate from the branch transition.
