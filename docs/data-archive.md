# Full snapshot archive and read retry

Approved by the user on 2026-10-11: a separate private `bibi45c/papertrade-monitor-data` repository, hourly GitHub Actions pull, full minute snapshots in UTC gzip JSONL shards, initial D1 history backfill, counts/gaps/SHA-256 checks and publication of this Worker change. D1 remains the primary minute collector with 90-day retention. No database schema change is needed.

## Read retries

Public HTTP queries, Hyperliquid information POSTs and EVM read-only JSON-RPC queries make at most three attempts. Per-attempt timeout is 3 seconds; a read has a 10-second total budget with exponential backoff (250/500 ms plus jitter). Retry-After is respected; a delay exceeding the remaining budget stops the read. Latest-block and pinned BBO reads share one 10-second budget, preventing nested retries from multiplying attempts. The same block stays pinned across BBO retries.

Retryable conditions: network errors/timeouts, HTTP 408/429/500/502/503/504, temporary RPC failures, a missing latest EVM block and an incomplete RPC batch. Permanent HTTP errors, invalid RPC arguments and incompatible data schemas fail without repeated requests. After exhaustion, normal per-source failure/null reporting remains intact. No stale value is substituted as a successful current read. The WebSocket execution queue continues to use its existing one-shot read and 8-second timeout.

## GET /api/archive

Query: `after` is an exclusive database minute timestamp (default 0); `through` is an inclusive upper bound (default server time); `limit` is 1-120 (default 120). All values must be safe nonnegative integers and `through >= after`. Invalid arguments return 400. Non-GET requests return 405. Storage outages return 503.

Response: `version`, fixed `through`, `available` (`oldestAt`, `latestAt`, `count`), `rows` (`collectedAt`, full original `snapshot`), `nextAfter`, `complete`. The cursor uses D1's minute key, preserving the payload's original precise collection timestamp separately. This exposes only the same public market payload already exposed by `/api/latest`, extended to stored historical rows. No credentials or private account data are included.

The archive fixes `through` for a complete paginated run, rechecks the preceding 48 hours, refuses conflicting same-minute payloads and verifies its record count against D1. It records upstream failures and missing minutes separately; count equality cannot prove upstream completeness. A full recheck can recover older gaps while D1 retains those rows. Archived files survive D1's retention expiry.

## Publication and recovery

Only this task's retry, archive API, documentation and tests are included in this publication. Existing local hourly earnings and page changes remain pending separately.

Acceptance: local collector/storage tests; syntax/build checks; Worker dry run; remote repository privacy; deployed pagination and D1 count equality; deterministic repeated archive; successful manual Actions run. Hourly scheduling is best effort, so a successful manual run confirms the pipeline, not future scheduling punctuality.

To recover, disable the data repository's archive workflow and roll this Worker back to the preceding version. Keep existing D1 and GitHub data. No account token or billing setting is added; commits in the data repository use its built-in scoped GITHUB_TOKEN.
