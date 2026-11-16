# Drop It audit remediation review

This report records pre-release verification. Its statements that no commit or
deployment occurred describe that phase. On November 16 the owner separately
authorized committing, deploying, and checking production, including the real
Render/Cloudflare forwarding chain. That rollout requires its own live evidence.

Prepared November 15, 2026 (America/Chicago), for the supplied audit dated November 16.

Worktree: `/Users/iver/Projects/drop-it`; baseline `6ef32d31ed0d796bee7c1bfa06606571e301845e`.
That matches the commit named by the sanitized audit report. The sanitized copy and
its `final-review.md`, `coverage.json`, and production evidence were read, not changed.
No SECURITY.md resolved for the affected server scope; the repository's owner-isolation,
untrusted-input and verification instructions apply.

## Assessment and finding-to-change mapping

The handoff's P0 label is not supported by the original report, which described its
rate-limit issue as **Low**. The source unquestionably used per-process counters.
However, a repeated client-supplied X-Forwarded-For value does not establish that
Express saw the same `req.ip`. Changing proxy addresses, process restarts, and
multiple processes are distinguishable explanations requiring deployment evidence.
The Blueprint specifies one instance; actual production process count and forwarding
chain were not established here. Shared counters remove the process-local weakness
without claiming that the old live evidence proves a particular topology.

Static triage preserves the seven handoff items below. Ranks are separate within
the confirmed and needs-review queues, not severity ratings. Runtime verification
of the changes is described separately.

| Finding | Baseline verdict / rank | Change and local result |
| --- | --- | --- |
| F1: deployment-wide limits | `needs_review` #1 for the production/multiple-instance claim; per-process source behavior verified | Added atomic database-clock counter store and migration 14; wired all ten limiter namespaces. Two apps share the exact login, API and registration budgets on PGlite and PostgreSQL16. |
| F2: export locks | `confirmed` #1, high confidence for cross-owner exclusion in source; production hold unproven | Legacy and portable exports now exclude duplicates per owner. Each path allows two owners with a distinct service-capacity error. Portable snapshots stage privately before download so slow clients also release PGlite's serialized transaction. A stalled A no longer rejects/blocks B; duplicate A and a third owner at capacity reject, abort releases A, and A retries successfully. |
| F3: MCP validation allocation | `needs_review` #2; affected dependency confirmed, application OOM unproven | SDK 1.31.0 -> 1.32.2 and explicit 10,000-element ceiling before schema traversal. The 150 KB body limit and existing scope checks remain. Oversized arrays/objects return short errors; ordinary invalid input still runs schema validation and valid unauthorized input still reaches scope denial. |
| F7: image/PDF pressure | `needs_review` #3; aggregate image-gate gap confirmed, OOM unproven | One process-wide two-decoder gate now covers upload validation, AI image previews and thumbnails. Uploads/drafts fail promptly when saturated; thumbnails retain their bounded 32-waiter queue. Sequential reads, existing 25 MP limit, and five-second native processing deadlines apply. Synthetic 6000x4000 input and decoder failure tests pass. Existing two PDF workers, 128 MB JS heap setting and timeout remain. |
| F4: registration growth | `needs_review` #4; missing retention confirmed, capacity exhaustion unproven | Added conservative 90-day unused/unreferenced-client collection. Lookups atomically refresh `last_used_at`. Preserve every token (including retained refresh replay evidence), pending consent and authorization-code reference. Existing clients get a fresh grace period on migration; missing issue timestamps are retained. |
| F6: Firecrawl re-resolution | `needs_review` #5; provider fetch is separate, SSRF unproven | Documented the exact trust boundary. Existing regression tests cover private literals, private/mixed DNS, pinned local HEAD requests, redirect-to-private and HTTPS downgrade. No provider-side SSRF remediation is claimed. |
| F5: pending OAuth capability | `not_actionable`, high confidence for the supplied claim | Kept the pre-login capability model. The ID has 32 random bytes (43 base64url characters), expires after ten minutes and is consumed atomically. Consent binds a grant to the authenticated owner, not an owner selected by the ID. No-referrer and same-origin controls remain. A disclosed ID grants no access to another owner's library. |

The MCP advisory and fix requirements were checked against the
[upstream security advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453).
Upgrading alone does not enable the new guard. App-owned tool arrays allow only
12 tags and records are shallow; 10,000 elements leaves compatibility headroom
while bounding adversarial traversal before Zod validation.

## Changed implementation locations

Locations below identify the resulting source, not the old audit line numbers.

- `server/rate-limit-store.ts:8`: express-rate-limit v8 Store; atomic upsert, hashed client key, namespace isolation, database-clock windows, decrement and reset.
- `server/db.ts:401`: idempotent migration 14; `(key,window_start)` primary key, counter cleanup index, and `oauth_clients.last_used_at` with a migration-time default.
- `server/app.ts:167`, `server/extension.ts:49`: OAuth authorize/token/register/revoke, API, login, reauthentication, legacy export, MCP and extension stores. Existing windows and limits remain; authenticated owner keys remain owner keys. IP limiters use express-rate-limit's default `req.ip` handling and IPv6 normalization.
- `server/app.ts:689`: owner-scoped legacy export state; retains both build-complete and response-complete release conditions and the five-minute deadline.
- `server/portability.ts:958`, `server/export-file.ts:39`: owner-scoped portable export state and shared private staging; abort/error cleanup, bounded reads and backpressure preserved. Portable staging uses the existing 512 MiB portable-archive size ceiling; legacy staging retains 384 MiB. Oversized portable exports now fail before starting a download rather than emitting an archive the importer cannot accept.
- `server/mcp.ts:31`, `package.json`, `package-lock.json`: explicit element bound and SDK upgrade.
- `server/image-decode.ts:1`, `server/uploads.ts:104`, `server/library.ts:369`, `server/thumbnails.ts:5`: shared Sharp admission boundary and decode options; release in `finally` on failure.
- `server/auth.ts:179`, `server/maintenance.ts:32`: last-use refresh, counter expiry and unused OAuth metadata retention.
- `server/page-extraction.ts:207`: provider-resolution trust-boundary comment; local preflight guarantees are not overstated.
- `server/config.ts:135`, `README.md` deployment notes: numeric proxy trust, counter/store-outage and retention behavior.

## Counter failure and proxy policy

Store failure is **fail closed**, returning a generic 503 with no RateLimit success
claim. One log per limiter/store per minute contains only a fixed error code and
limiter namespace. Provider errors, IPs and owner keys are not logged. This deliberately
differs from the handoff's fail-open preference: authentication already requires the
same database, and an outage must not silently disable brute-force protection.

The configured Render value remains `TRUST_PROXY_HOPS=1`. That is correct only
when the verified client is the rightmost forwarding address one hop from the
Node socket on every admitted path. A two-hop chain requires `2` only after
verification and exclusion of shorter paths. The actual required production value
cannot responsibly be asserted from the words Render + Cloudflare alone. No
deployment or environment setting was changed. See
[Express's numeric-hop warning](https://expressjs.com/en/guide/behind-proxies/).
Tests prove untrusted forwarding headers cannot split a direct client's bucket
and forged earlier addresses cannot split a correctly stamped one-hop chain.
The existing HTTPS-proxy test also verifies an ingress that replaces headers.

Fixed windows align to epoch boundaries using the database clock rather than
starting separately in each process. This changes reset alignment, not the configured
budgets. Like other fixed-window policies, two adjacent windows can allow a burst
across their boundary; it is not a sliding-window guarantee.

## Verification

All tests use synthetic data, mock providers and temporary databases. No real
email, AI, Firecrawl, production account, or production HTTP request was used.
The original offline runner hardcodes the sanitized snapshot as its working
directory. To test the actual upstream worktree, the commands below instead use
its existing network guard directly with an empty inherited environment.

```sh
env -i PATH="$PATH" TMPDIR="$TMPDIR" NODE_ENV=test \
  NODE_OPTIONS='--import=/Users/iver/Projects/uncensored/security/drop-it/scripts/offline-network-guard.mjs' \
  node --import tsx --test --test-concurrency=1 \
  tests/rate-limit.test.ts tests/mcp-contracts.test.ts tests/uploads.test.ts \
  tests/thumbnails.test.ts tests/page-extraction.test.ts

env -i PATH="$PATH" TMPDIR="$TMPDIR" NODE_ENV=test \
  NODE_OPTIONS='--import=/Users/iver/Projects/uncensored/security/drop-it/scripts/offline-network-guard.mjs' \
  node --import tsx --test --test-concurrency=1 \
  tests/rate-limit.test.ts tests/image-decode.test.ts \
  tests/security-maintenance.test.ts tests/ai.test.ts

env -i PATH="$PATH" TMPDIR="$TMPDIR" NODE_ENV=test \
  NODE_OPTIONS='--import=/Users/iver/Projects/uncensored/security/drop-it/scripts/offline-network-guard.mjs' \
  node --import tsx --test --test-concurrency=1 \
  tests/portability.test.ts tests/portability-http.test.ts \
  tests/export-file.test.ts tests/legacy-export.test.ts

env -i PATH="$PATH" TMPDIR="$TMPDIR" NODE_ENV=test \
  NODE_OPTIONS='--import=/Users/iver/Projects/uncensored/security/drop-it/scripts/offline-network-guard.mjs' \
  node --import tsx --test --test-concurrency=1 \
  tests/rate-limit.test.ts tests/http-security.test.ts tests/security-maintenance.test.ts

env -i PATH="$PATH" TMPDIR=/private/tmp LC_ALL=C LANG=C NODE_ENV=test \
  node --import tsx tests/audit-postgres.ts

env -i PATH="$PATH" TMPDIR=/private/tmp LC_ALL=C LANG=C NODE_ENV=test \
  node --import tsx tests/postgres-email.ts

env -i PATH="$PATH" TMPDIR="$TMPDIR" NODE_ENV=test \
  NODE_OPTIONS='--import=/Users/iver/Projects/uncensored/security/drop-it/scripts/offline-network-guard.mjs' \
  npm run check
```

Results:

- Focused image/AI/cleanup/shared-store tests passed, as did all 29 export/staging tests and the 17 HTTP/store/cleanup regressions after the trusted-forwarding case was added.
- MCP contract tests reject both a 24,000-tag array and 12,000 unexpected object members, with short error responses and no save handler dispatch. The complete MCP authorization/contract tests pass.
- PGlite and PostgreSQL16 share increments between independent Store instances, isolate prefixes, serialize 40 competing increments without loss, reset/decrement, and roll windows. Repeated migration passes. Ten invalid login attempts split across two apps exhaust their shared budget; both apps reject the next attempt. Equivalent checks pass at API 120/minute and OAuth registration 20/hour.
- The real PostgreSQL auth suite passed all ten reported checks, including concurrent verification/reset, durable-job/restart behavior, dump/restore, repeated migration and local entry-point startup on restored data. The restore fixture now exercises migration 14.
- Loopback listeners initially failed under the filesystem sandbox; these tests were rerun with local listener access and the outbound guard retained. The new two-app HTTP fixture also initially used a canonical Host that Node fetch did not send; it now dispatches two apps behind one loopback listener with the actual origin, leaving app Host enforcement intact. PostgreSQL initially failed to start because this Mac requires an explicit valid locale; `LC_ALL=C LANG=C` resolved that. No test was silently skipped.
- Initial `npm run check`: lint/typecheck/build passed; 322/323 tests passed. The remaining test constructed an incomplete v6 schema without its original `oauth_clients` table. The fixture now includes that table and expects migration 14; its focused rerun passed 14/14 tests.
- Final `npm run check`: **PASS** — lint, typecheck, production web build and **323/323 tests**, zero failures or skips (178.6 seconds for the tests). The final PostgreSQL counter/integration rerun also passed.
- `git diff --check` passed. A separate read-only investigator and one independent bypass/regression reviewer inspected the changed boundaries; the reviewer reported no concrete surviving bypass or regression.

## Additional pre-commit verification

The subsequent release-readiness pass added HTTP-level outage coverage in
`tests/rate-limit.test.ts` and expanded `tests/audit-postgres.ts`:

- The full existing PostgreSQL security suite passed **23/23 checks**, including
  owner isolation, code-exchange/revocation races, refresh replay, export coherence,
  credential rollback and deletion boundaries.
- The HTTP outage regression checks both API and SDK OAuth registration paths:
  generic 503, no successful RateLimit header, no client registration, bounded
  redacted logging, health/readiness still available when only counter operations
  fail, and normal budgets after recovery.
- Real PostgreSQL cleanup now exercises aged unused clients, recent lookups,
  live tokens/codes/consents, malformed issue timestamps and expired counter rows.
  Stopping the disposable database causes a 503; restarting preserves the prior
  counter and the next increment resumes at two. All checks passed.
- The in-app browser loaded the built library and Settings in the existing
  loopback-only mock-provider fixture, then downloaded a portable archive.
  Independent validation confirmed its manifest, two synthetic drops/two sources,
  completion footer and SHA-256 integrity. This was synthetic data, not a personal
  library download. The fixture was then stopped.
- Aggregate `npm run check` after the added regression: **PASS**, lint/typecheck/
  production build and **324/324 tests**, zero failures/skips (182.1 seconds for
  tests). No production implementation changes were needed in this additional pass.

Additional PostgreSQL commands (the guard used for HTTP/PGlite tests disallows
Unix sockets, so these disposable clusters use a scrubbed environment instead):

```sh
env -i PATH="$PATH" TMPDIR=/private/tmp LC_ALL=C LANG=C NODE_ENV=test \
  node --import tsx tests/postgres-security.ts
env -i PATH="$PATH" TMPDIR=/private/tmp LC_ALL=C LANG=C NODE_ENV=test \
  node --import tsx tests/audit-postgres.ts
```

At that point, Node 24/Linux, proxy-chain and bounded resource checks remained.
The subsequently authorized Docker pass below closes the local Linux/runtime and
resource checks. The actual hosted ingress chain still needs rollout verification.

## Docker release verification — November 16, 2026

Docker Desktop was started at the user's request. Verification used **Linux/amd64,
Node v24.22.3 and PostgreSQL 16.16** in disposable containers on this Apple Silicon
Mac. Emulation and Docker limits make these functional/resource smoke tests, not
native hosted-service throughput benchmarks. Production was not contacted.

### Problems found and corrected during this pass

- The production Dockerfile omitted `scripts/inline-widget.ts`, so a clean image
  could not compile the Vite configuration. Added that exact helper and the two
  fixed synthetic review videos consumed by the public review routes. The
  `.dockerignore` exceptions name only those additions; no release bundle or
  private directory was admitted. The resulting non-root production image builds,
  starts, serves both review assets and contains no env/private/data/Git/credential/
  upload files in its source directories.
- A fresh npm audit surfaced a public parser exposure absent from the handoff:
  body-parser 2.3.0 was installed under Express with default decompression on
  `/mcp`, `/share` and SDK OAuth handlers. The
  [upstream compressed-stream advisory](https://github.com/advisories/GHSA-27r3-jxmh-p828)
  identifies 2.4.0 as patched. Updated to 2.4.0 within Express's existing range.
- Raised Zod to 4.6.7 and updated compatible Hono/node-server, MCP client/core,
  fast-uri, ip-address and qs resolutions. Updated Vite to 8.3.8 to remove its
  development-server advisories. No forced upgrade, override or major migration
  was used. The updated lockfile was regenerated in an empty Node 24/Linux
  workspace after npm on the Mac omitted optional cross-platform entries; clean
  `npm ci` then succeeded in both the test and production images.
- Added HTTP tests covering gzip/deflate/Brotli and, where the runtime supports
  it, Zstd on public MCP/share and SDK registration/token paths, including delayed
  corrupt trailing bytes and a subsequent healthy request. The final Node 24 run
  exercised all four encodings. Valid JSON-RPC/form behavior remains, malformed
  inputs stay bounded, and invalid 24,000-element tag collections return a short
  400 without saving; a valid retry succeeds with 201. The compressed-frame probe
  also passed against the old parser image, so this report does **not** claim a
  locally reproduced crash; affected-version removal and upstream source changes
  establish that remediation, with the new tests providing compatibility/liveness
  coverage. The Zod test is not a direct allocation measurement.
- Made the standalone PostgreSQL security runner honor `DROP_IT_PG_BIN` and use
  the platform temporary directory. Added `tests/release-runtime.ts` for the
  bounded Linux resource workload. No production behavior was weakened.

### Results

| Check | Result |
| --- | --- |
| Clean production Dockerfile install/build | PASS; Node 24/Linux/amd64, Vite 8.3.8 |
| Full Linux `npm run check` | PASS: lint, typecheck, build, **325/325 tests**, zero failures/skips; 337.4 seconds for tests, 2 CPU / 2 GiB functional container |
| Expanded parser/collection regressions | PASS, both focused cases, including SDK OAuth and Zstd |
| PostgreSQL shared counters, retention and DB stop/restart | PASS |
| Existing PostgreSQL security suite | 23/23 PASS |
| PostgreSQL dump/restore, repeated migration and actual entry-point startup | PASS, including closed-signup login and clean shutdown |
| Two actual production-image instances, one DB | PASS; shared login budget despite varying forged earlier forwarding entries |
| Actual image migration/readiness/non-root startup | PASS; migration 14, healthy session route and non-root Node process |
| App process replacement and DB restart | PASS; same-window counters retained on both instances |
| Actual image DB outage | PASS; readiness/API 503, process health 200, then recovery |
| Production dependency audit (`npm audit --omit=dev`) | 0 advisories |
| All-dependency audit | 9 moderate reports in the ESLint/typescript-eslint/minimatch development chain; 0 high or critical |
| Independent read-only review of dependency/image candidate | No concrete surviving bypass or regression reported |

The resource workload ran separately with **one CPU, 2 GiB memory, no swap, no
external network, an unprivileged user and no elevated Linux capabilities**. It
used real PostgreSQL, 24 MP uploads/draft previews, eight thumbnail requests,
simultaneous legacy/portable staging and a stalled owner's portable download.
Busy draft admission is allowed under saturation and successful retries are checked.

| Measurement | Observed |
| --- | --- |
| Peak container memory (including PostgreSQL and page cache) | 633 MiB / 2048 MiB |
| Maximum Node RSS | 394 MiB |
| Simultaneous private archive staging | 44 MiB |
| Owner B export while owner A was stalled | 424 ms; complete archive with verified integrity |
| OOM kills | 0 |
| Temporary files after abort/disposal | None remaining; private directory/file modes checked at 0700/0600 |

This is a bounded workload, not a maximum-capacity or soak test. It does not
establish a universal RSS bound for Sharp/PDF native allocations or worst-case
archive/disk behavior.

### Harness issues recorded rather than skipped

The first test image needed ownership of its working directory so an unprivileged
Vite process could write its generated config. A PostgreSQL restore/startup run
initially lacked its built web artifact; building it in that test container and
rerunning passed. The first complete Linux run passed 322 tests and failed three
packaging tests because the isolated context omitted the public `release/icon.svg`
and `release/review-cases.json` fixtures. They were added only to the test context,
and the complete suite was rerun; the production context was not broadened for
these packaging fixtures. The new collection test's valid control was corrected
to expect the existing 201 response.

A restart check initially expected 429 after a 15-minute window had rolled over.
Database inspection showed the old counter still present and a new window's
counter, as designed. The repeat uses a fresh synthetic key with at least 30 seconds
left in the window and verifies restart retention before the window ends. No
limiter state or limit was changed to make that test pass.

### Commands and retained recipes

The production image was built from the actual repository:

```sh
docker build --platform linux/amd64 --progress plain --tag drop-it-release-check:local .
```

The test image was built from a separate allowlisted source/fixture context, with
no host `node_modules`, private data, env files or Git directory. Its exact recipe
is retained as `hardening/docker-release-check.Dockerfile` in the target-bound
Codex Security artifact collection, alongside `docker-production-smoke.mjs` and
`docker-counter-restart.mjs`. The application code and lockfile match this worktree.

```sh
docker run --platform linux/amd64 --name drop-it-node24-final \
  --network none --memory 2g --memory-swap 2g --cpus 2 --pids-limit 512 \
  --cap-drop ALL --security-opt no-new-privileges \
  drop-it-linux-tests:local npm run check

docker run --platform linux/amd64 --name drop-it-resource-check \
  --network none --memory 2g --memory-swap 2g --cpus 1 --pids-limit 512 \
  --cap-drop ALL --security-opt no-new-privileges \
  drop-it-linux-tests:local node --import tsx tests/release-runtime.ts
```

The PostgreSQL runs used the same isolated test image with
`DROP_IT_PG_BIN=/usr/lib/postgresql/16/bin` and these commands, in order:

```sh
node --import tsx tests/audit-postgres.ts
node --import tsx tests/postgres-security.ts
npm run build:web
node --import tsx tests/postgres-email.ts
```

The actual-image check used an internal-only Docker network with a disposable
database and unprivileged synthetic application role. Two non-root app containers
had no published ports, real accounts, AI/email keys or production configuration.
The forwarded-header test validates a controlled one-hop chain. It cannot determine
the real Render/Cloudflare forwarding chain or justify changing `TRUST_PROXY_HOPS`
without that hosted evidence. That remains a rollout verification item.

The remaining moderate lint-chain advisories are not reached by the serving app;
the production image still retains development packages because its startup uses
tsx. No blanket claim of a vulnerability-free image or application is made. No
commit, push, deployment, production traffic or external-service write occurred.

The successful production image is `drop-it-release-check:local`, image ID
`sha256:f81f1265ce5f493904b255fdffea68b47db0827953e0f33b6ed37de492211b66`.
Both actual app containers exited cleanly with status 0. All eight disposable
containers, their anonymous data volumes and the internal test network were
removed. Docker Desktop remains running, and the tested images remain cached.
Full successful Linux and resource logs, plus the initial harness failures and
successful PostgreSQL rerun, are retained in the target's Codex Security artifact
collection under `artifacts/docker-*.log`.

## Rollout and rollback notes

Deployment was not part of the original remediation authorization; the owner
subsequently authorized it on November 16 as described above.

Before committing, live Render inspection established a 0.5 CPU / 512 MiB app
instance and a separate 0.1 CPU / 256 MiB PostgreSQL service. The same resource
harness passed with those separate Docker limits: peak app container 438 MiB,
maximum Node RSS 371 MiB, 44 MiB staging, owner B export 945 ms while A was
stalled, 138 records, staging cleanup confirmed and zero OOM kills. The optional
database override in `tests/release-runtime.ts` accepts only the fixed synthetic
Docker hostname, role and database, without passwords or URL parameters. An
initial combined app/database 512 MiB run completed the workload without an OOM
but reached the memory cap and failed the strict headroom assertion; separating
the services matches Render's topology and leaves that assertion unchanged.

1. Before a future release, confirm the database target and backup/restore readiness. Apply migration 14 once before sending traffic to the new application. The migration is additive and rerunnable; it does not rewrite users, sessions, source files or token payloads. Existing OAuth clients receive `last_used_at` at migration time.
2. Complete the rollout across all processes before claiming deployment-wide limits. Old processes continue using memory counters during a mixed-version rollout. Verify the real forwarding chain independently with synthetic requests through every admitted ingress; adjust numeric trust only with that evidence.
3. Observe 503 `RATE_LIMIT_UNAVAILABLE` events and database query latency. The store adds a database write per applicable limiter per request. Existing maintenance collects counter rows older than one day and unused OAuth clients. The counters' window index supports expiry.
4. Portable export staging now uses temporary disk; provision sufficient space for at most two 512 MiB portable archives plus up to two 384 MiB legacy archives per process. Downloads retain their owner slots until completion/abort. The existing private-directory cleanup also collects abandoned staging after a crash.
5. To roll application code back, leave the additive table/column in place. Old code ignores them and keeps using its old memory limiters. Dropping migration 14 is unnecessary and should only be considered after all new processes stop. Already collected unused OAuth registrations are not restored by a code rollback; those clients would register again. Libraries and active grants are preserved by the policy.

## Residual risks and explicit verification boundary

This is a **local implementation and verification result**, not a production
security attestation. Production parity, effective proxy addressing, instance count,
provider-side Firecrawl protections and production memory usage remain unverified.

Image/PDF OOM was not reproduced. The shared gate and native deadlines reduce
image concurrency; they do not impose a hard RSS cap on Sharp/native code. PDF
worker JS heap limits do not cap every native allocation. Those existing controls
were retained, not claimed to solve an observed production OOM.

Service-wide export capacity remains intentionally bounded, and the owner sets
are per process; the patch does not introduce distributed export locks. One owner
can still occupy one legacy and one portable slot in a process. Other page/import/AI
service-wide admission policies from the original broad F2 discussion are outside
this handoff's export fix. Firecrawl's independent resolution remains a provider
trust boundary. OAuth capabilities were documented rather than redesigned.

No production writes, deployment, real account creation, real email or AI calls,
private configuration/library reads, commits, or `.gitignore` changes occurred.
The new source/test files are marked intent-to-add for review; no contents are
staged for a commit. The original audit artifacts remain unchanged.
