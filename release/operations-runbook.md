# Drop It operations and recovery

This is an operator runbook, not evidence that provider-side alerts, load tests, or recovery cutover have passed. Use synthetic accounts in an isolated staging service for drills. Production configuration, billing, signup, deployment, submission, and publication require a separate authorized operation. Never put connection strings, passwords, recovery codes, originals, or full exports in logs, tickets, recordings, or this file.

## Admission and capacity

The intended deployment remains one process / one service instance. The configured database has 5 GB nominal storage with autoscaling disabled; verify the current provider dashboard before any launch decision. No resources were resized by this implementation.

| Environment variable           |             Default | What it bounds                                                                                        |
| ------------------------------ | ------------------: | ----------------------------------------------------------------------------------------------------- |
| `MAX_OWNER_ATTACHMENT_BYTES`   | 262144000 (250 MiB) | All originals for an owner, including Trash and abandoned uploads                                     |
| `MAX_OWNER_DROPS`              |               10000 | All owned drops, including Trash and expired drops awaiting cleanup                                   |
| `MAX_OWNER_TEXT_BYTES`         |   26214400 (25 MiB) | UTF-8 bytes of drop metadata, reviewed transcription, source text/URLs, and extracted attachment text |
| `MAX_SERVICE_ATTACHMENT_BYTES` |  3221225472 (3 GiB) | Original-file bytes across the service                                                                |
| `MAX_AI_CONCURRENT`            |                   4 | Concurrent AI operations across owners in the running Library instance                                |
| `MAX_AI_STARTS_PER_MINUTE`     |                 120 | AI operation starts per minute across owners in that instance                                         |

Per-owner AI limits remain one active operation and 20 starts per minute. AI search is off by default and requires an explicit account choice. A keyword-only request never starts AI. Drafting remains a separately requested operation using the existing server provider configuration.

The attachment aggregate check takes a shared database lock before the owner lock. Import uses the same order. AI limits are process-local, reset on restart, and count operations rather than tokens or money; they are not a spending cap. Keep one instance until shared AI enforcement is implemented. Capacity defaults do not guarantee the remaining database headroom: indexes, WAL, text, credentials, temporary work, and database overhead consume disk too.

Before enabling public signup, choose an admitted-account ceiling and verify representative mixed saves, 10 MiB originals, searches/indexing, preview/import, exports, and deletion while staying below planned concurrency. Record peak memory, disk/WAL growth, database wait time, error rate, and p95 latency using synthetic content. Start with low concurrency and stop on growing queues or low disk space. Do not run stress tests against production. Raising limits requires fresh evidence and deliberate configuration, not simply changing a UI label.

## Alerts and response

Configure an actual operator destination, then generate a harmless staging event and record receipt and time-to-notice for each alert:

- External `/ready` failure, repeated process restarts, and elevated HTTP 5xx.
- Database storage at 70% and 85%, plus abnormal growth. Do not wait for the application's attachment limit; it is not a total-disk limit.
- Sustained pool/acquisition wait or database CPU/memory pressure.
- `DATABASE_CONNECTION_ERROR`, `MAINTENANCE_ERROR`, repeated `SERVICE_CAPACITY`, and abnormal AI failure/rate-limit volume. Send identifiers/counters only.
- Provider AI usage thresholds and unusual changes, without changing billing or security settings during a code verification task.

`/health` proves only that the process answers. `/ready` also queries PostgreSQL and has a response deadline. A successful readiness response does not verify OpenAI credit, backups, email support delivery, or end-to-end user flows. Avoid body/content logging and never include request Authorization/Cookie headers.

For a capacity event, preserve reads and exports where possible; stop new admissions, diagnose the actual disk/memory consumer, and request an authorized capacity change. Do not delete user data to relieve pressure. For a provider outage, manual capture and keyword search remain the fallback. For maintenance failure, expired drops must remain inaccessible even while physical cleanup is delayed; retry cleanup only through the normal server lifecycle or a reviewed operation.

## Database interruption and shutdown

The PostgreSQL adapter catches both idle pool errors and checked-out transaction connection errors with a stable sanitized code, discards failed clients, and preserves the original failure if rollback also fails. It limits acquisition to 5 seconds, query/statement work to 15 seconds, lock waits to 5 seconds, and idle transactions to 15 seconds. The process allows up to 20 seconds for graceful shutdown before exiting unsuccessfully. Portable export holds a read-only snapshot while streaming; a download stalled beyond the idle-transaction budget fails without its archive completion marker. Retry the download; the process and export slot remain available.

In a disposable database drill, establish an idle pooled connection, stop the database, verify the app process survives and database work fails within its budget, restart the same database, and verify a new query plus an authenticated synthetic read. Also verify lock contention rolls back cleanly and releases capacity. Do not assume a green startup health check covers this failure mode.

Retained opt-in checks use only a newly initialized local PostgreSQL 16 cluster, a private Unix socket, synthetic owners/files and private temporary staging. They never load application environment files. On this machine they require the Homebrew PostgreSQL binaries at `/opt/homebrew/bin` and permission for local sockets/shared memory:

```sh
node --import tsx tests/postgres-security.ts
node --import tsx tests/postgres-reliability.ts
node --import tsx tests/postgres-portability.ts
```

The portability check includes a real 17-second export stall in a separate Node process; service capacity contention between import and upload; and `SIGKILL` immediately before commit and after commit before the apply response. Independent restarted processes verify atomic rollback or durable receipt replay with no duplicate rows. The test checks staging directory/file permissions and cleanup after advancing only the abandoned synthetic directory's modification time beyond the 20-minute crash cleanup threshold. This verifies restart cleanup logic without claiming a 20-minute wall-clock observation. The helper `tests/postgres-portability-worker.ts` must accompany the harness. All three harnesses stop and remove their own temporary clusters.

## Backup and recovery

Recorded evidence already exists: the October 1 logical export was restored into isolated PostgreSQL, application-level state was reconciled, and original-file hashes matched. See `verification-2026-10-01.md`. That is different from a completed managed point-in-time recovery and service cutover.

Render's current documented logical-backup retention is seven days. PITR retention depends on workspace plan; verify the dashboard and public retention disclosure together. References: [Render recovery and backups](https://render.com/docs/postgresql-backups), [node-postgres pool errors and timeouts](https://node-postgres.com/apis/pool).

Before a real incident, record an agreed maximum acceptable data-loss window (RPO), target time to restore service (RTO), who can authorize a cutover, and how to contact that person. These values remain unverified until a timed drill passes.

A recovery drill or incident follows this order:

1. Record the incident time, last known good time, affected release, and recovery point without recording content or credentials. Keep the original database intact.
2. Restore into a separate database with external access disabled or an isolated local socket. Do not overwrite the active database. Prevent restored services from accepting public traffic or sending AI requests.
3. Verify schema/migrations, account and drop counts, source relationships, revisions, bookmarks, Trash deadlines, and attachment hashes using designated synthetic samples. Check for dangling sources/files and cross-owner relationships. Run cleanup against the isolated restore so already-expired Trash cannot return.
4. Reconcile actions after the recovery point. A historical backup can resurrect deleted accounts/content and roll back changed passwords, recovery codes, and revoked connections. Maintain a secure, access-controlled incident record of known deletion/security requests outside the database being restored. Never populate that record with password or recovery-code values.
5. Before reconnecting traffic, invalidate restored browser sessions, approved OAuth codes, OAuth access/refresh tokens, pending authorizations, and recovery-code hashes. Increment authentication versions. This is a reviewed operation on the restored database, not an automatic command in this document.
6. Reapply verified account/content deletions and handle credentials changed after the recovery point. Bulk token revocation alone does **not** fix a rolled-back password hash. If the affected accounts cannot be identified and safely reconciled, keep the recovered service closed and establish an authorized recovery process; do not silently reactivate historical access. There is currently no automatic post-backup deletion journal or password-reset delivery channel.
7. Confirm provider/network/access settings and canonical origin, then authorize the connection-string cutover. Test readiness, sign-in using disposable credentials, save/read/edit/Trash/restore, original hashes, and OAuth reconnect. Recheck isolation with a second synthetic owner. Keep the original database until reconciliation succeeds.
8. Record observed recovery duration, recovery point/data-loss interval, reconciliation totals, alerts received, and remaining limits. Update public retention wording if the actual configuration changed. Remove isolated drill resources only after confirming their identity and retaining non-sensitive evidence.

## Release evidence still requiring human/provider access

- Delivery and response test for the published support mailbox; a `mailto:` link is not proof of delivery.
- Provider alert receipt, representative capacity/load results, and a timed managed recovery/cutover drill.
- Physical mobile/browser verification, including original downloads and supported share-sheet behavior.
- Reviewer model-driven cases and walkthrough recording, followed by an explicit submission decision. Keep the app unsubmitted until that decision.

GitHub CI billing remains intentionally deferred. Local tests and the recorded release verification are separate evidence; do not label them a successful GitHub CI run.
