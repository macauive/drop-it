# Release verification — October 1, 2026

Production remains on `codex/render-launch`. The requested transition to `main`
is conditional on the remaining live tests passing; screenshot preservation has
not passed, so neither branch nor deployment source has been switched.

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
- Lint, TypeScript, production build, and all 137 automated tests passed both
  in the working checkout and in an archive containing only committed files
  with a fresh `npm ci`. The clean-checkout run used local Node 25.2.1;
  Render's Node 24 build also passed. This is not a completed GitHub CI run.

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

## Unresolved

- Screenshot import first failed on the old file schema. After the repair,
  the live tool reached the server but returned `FILE_HOST`: the actual
  transport download host is outside the exact current allowlist.
- Subsequent attempts encountered `INVALID_ARGUMENT`, then a newly attached
  synthetic PNG was blocked by ChatGPT with `SAFETY_STATUS_UNDETERMINED`.
  The hostname could not be established. Do not broaden the allowlist based
  on guesses, bypass that block, or claim original-file preservation passed.
- No screenshot attachment ID or saved screenshot drop was confirmed.
  Live `draft_item`/OpenAI processing remains unverified.
- GitHub Actions run 36821767310 never started: GitHub reports failed account
  payments or a spending limit. No billing or security setting was changed.
- ChatGPT showed "CSP off" during these developer-mode tests; widget behavior
  under enforced CSP still needs verification before public submission.

The synthetic rainwater-sensor drop remains restored and bookmarked for
inspection. The tests did not modify pre-existing user drops.

## Next release gate

Resolve the ChatGPT file-transfer block, identify and verify its actual download
host, then safely support it and rerun upload, draft review, save, and original
retrieval. Once that flow passes, merge to `main`, switch both Render source
branches, and verify health and ChatGPT retrieval after deployment. Resolve the
GitHub runner billing limit to enable ongoing CI. Broader public-launch checks
(review account, submission walkthrough, enforced CSP, and backup restore)
remain separate from the branch transition.
