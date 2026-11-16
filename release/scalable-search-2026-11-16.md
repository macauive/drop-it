# Scalable search verification — November 16, 2026

Implemented locally; this report is not production deployment evidence.

## Result

The 1,000-drop AI-search restriction is removed. Literal search uses a trigger-maintained text column and a pg_trgm GIN index. Semantic/hybrid search performs exact, filtered cosine scoring in PostgreSQL using pgvector; only page-sized result IDs and records are loaded by Node. Keyword matches stay first in hybrid mode. Original content, reviewed-transcription behavior, source snippets, filters and pagination are preserved.

Requests prepare at most 32 bounded document excerpts. A persisted job continues the requested owner's selected filters, in turns of at most eight batches, through the existing AI gate. Progress and an incomplete-results notice are exposed to the website and MCP. The widget resource advances to `library-v6.html` for the updated structured-result schema. A bounded, five-minute query-vector cache lets an existing query refresh while its indexing operation is busy. Keyword-only searches never call AI.

Cache writes lock the owner only after the provider returns, then check the current consent generation and content revision. Disabling AI cancels queued jobs and removes cached document vectors; revoked in-flight work cannot recreate them. Background jobs back off on failure and can resume after restart/lease expiry. Unchanged legacy embeddings can be reused without resending document text.

## Verification

- `npm run check` passed lint, typecheck, web build and **347/347 tests** after the final widget-resource update. `git diff --check` also passed.
- Six focused scalable-search tests cover a complete cold index of 10,000 drops, all 1,001 hybrid matches over pagination, matches beyond the first pages, owner/filter/date/tag/Saved isolation, scoped processing, stale edits/deletes, disable/re-enable races, legacy reuse, malformed vectors, extreme magnitudes, literal punctuation, long sources, source updates, failure backoff, expired leases and refresh while indexing is busy. Embedding batches never exceed 32; returned SQL rows stay page-bounded in the tested corpus.
- Native PostgreSQL consent-revocation race passed with concurrent connections: no document vectors or queued jobs survived revocation.
- Migration 14 → 15 passed on 10,001 existing synthetic drops, including a second idempotent migration call, complete text backfill and renewed-consent behavior. It took 38,612 ms on the constrained database. Backfill statements are bounded to 250 rows; ordinary database timeouts were not increased.
- In-app browser verification covered the 10,000-drop library, incomplete-index notice, refresh, complete 1,001-match hybrid result, pagination and pool filtering. Only synthetic content and mocked AI were used.

## Native timing

PostgreSQL 16.12, pgvector 0.8.1, Docker database limited to 0.1 CPU and 256 MiB. The Node benchmark ran on the host. One owner had 10,000 drops (approximately 18 MB of source text) with dense 512-dimensional synthetic vectors; another owner had an excluded private fixture. Four warm requests per mode returned the expected exact totals.

| Mode | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: |
| Keyword | 109 ms | 192 ms | 197 ms |
| Semantic | 1,000 ms | 1,150 ms | 1,295 ms |
| Hybrid | 1,099 ms | 1,205 ms | 1,208 ms |

Before the text-index optimization, the constrained run took about 5–8 seconds per warm request. EXPLAIN confirms a Bitmap Index Scan on `items_search_text` for the tested literal query. Real AI-provider latency is additional; the benchmark used deterministic embeddings without network AI calls. These checks establish controlled-corpus correctness and single-owner timing, not production load capacity or real-world relevance calibration. Initial indexing can take minutes under provider latency and the existing operation limits. Derived text/vector indexes also consume database storage beyond attachment usage.

## Release requirements

- Enable `vector` and `pg_trgm` as a database administrator before migration 15 when the application role cannot install extensions. Local PGlite loads the pinned official packages. [Render extension support](https://render.com/docs/postgresql-extensions), [PGlite extension setup](https://pglite.dev/extensions/).
- Migration 15 turns off AI search for previously opted-in accounts; they can opt in again through the updated Settings disclosure covering larger background indexing. It does not call an AI provider during migration.
- Allow a migration window for the text backfill. Keep the existing single-instance deployment; shared AI spending/concurrency enforcement and multi-user load testing remain separate work.
- No production data, provider configuration, paid plans, billing or deployment was changed. Real provider usage and production recovery/load were not retested here.

## Reproduction

Run `npm run check` and `node --import tsx --test tests/scalable-search.test.ts` locally. The opt-in `tests/search-benchmark.ts`, `tests/postgres-search-race.ts` and `tests/postgres-search-migration.ts` use only the fixed, disposable loopback fixture described in those scripts; the benchmark refuses a reused database. The browser fixture is `tests/search-preview.ts` and listens only on loopback.

Implementation references: [pgvector exact/cosine search](https://github.com/pgvector/pgvector), [PostgreSQL trigram indexing and short-pattern limitations](https://www.postgresql.org/docs/16/pgtrgm.html). Short or punctuation-only literal patterns can require a scan; their matching semantics remain covered by tests.
