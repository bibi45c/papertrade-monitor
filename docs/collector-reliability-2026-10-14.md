# Collector reliability and history recovery

Implementation scope approved on 2026-10-14: improve collection without a paid-plan upgrade, recover available history, stop Binance requests, remove HYPE from the market snapshot, remove the directional-loss path, and retain the HL hedge comparison in grey with a strike-through.

## Evidence

Cloudflare logs identify scheduled `exceededCpu` on deployed version `33ad052f-a69e-4d28-a879-1e2bfbb550fb`. D1 stopped advancing at 2026-10-14 07:01 UTC while later Cron invocations continued to fail. CPU termination can interrupt the collector before its final database write. Successful observed invocations used more than the Free plan's 10 ms budget; occasional allowance is not a reliable operating budget.

The live public queue on 2026-10-14 still supplies aggregate counts, gas and chain data but omits `queuePreview`. The old parser rejected this optional omission. Unknown preview and an empty aggregate queue are different states.

## Implementation

- `* * * * *`: core protocol summary, trading parameters, payout debt, distribution event, BTC/ETH context, books, BBO and aggregate execution queue. Core snapshots remain immutable at their original database minute.
- `*/5 * * * *`: independent auxiliary invocation for governance coverage and hourly protocol statistics. Web bundles are checked approximately hourly. State is kept in an additive `auxiliary_state` table. Migration 0002 seeds known operations from the last existing governance snapshot and inventories distinct pending intervals across all stored snapshots, including intervals omitted from the old ten-range limit.
- No Binance requests or HYPE book requests. Existing columns and archived payloads are preserved; future `hype_mid` and jump columns remain null. `sources.jumps.disabled` distinguishes an intentional stop from an outage.
- Cloud core/live collection omits the expensive LP risk calculation. The browser derives it from the current snapshot; historical export fields stay null for these new snapshots rather than carrying forward a stale risk estimate. Node's standalone full collector can still compute the model.
- Core records include the last auxiliary values and their original times, marked retained. `/api/live` and `/api/latest` may attach newer auxiliary state for display, with `auxiliaryAt`; `/api/archive` always returns the original stored payload.
- Missing queue preview preserves valid aggregate statistics, sets `previewAvailable=false` and keeps manual two-leg planning blocked. Malformed preview, stale publications, invalid gas totals and inconsistent chain blocks still fail validation.
- Governance reads one recent block chunk then oldest pending chunks, with a bounded number of RPC calls. Coverage gaps are merged without truncation and removed only after a successful read and decode. Failed reads remain pending. Old events are deduplicated and sorted by block before retaining recent events.
- `collection-start`, `collection-saved` and `collection-failed` structured logs identify task type, scheduled time, saved sample and source failures. Runtime CPU kills still require Cloudflare's invocation outcome; JavaScript cannot catch that termination reliably.

## Display

MARKET SNAPSHOT shows BTC/ETH only, including when displaying older snapshots. The directional-loss path is removed. HL hedge calculations remain present, grey and struck through. Growth greater than 100 (including numeric overflow) displays `回本门槛过高（>100 倍）`; missing input instead displays `样本不足 / 不可用`. Finite original values are retained in the model and the table tooltip. The threshold changes presentation, not the underlying economic calculation or its validity.

## Recovery

`node scripts/repair-history.mjs --public-dns` writes `data/recovered/protocol-hours.json`, `governance-checkpoint.json` and `governance-progress.jsonl`. It fetches full public hourly history and resumes bounded log backfill from the last checkpoint; rate limits wait before another bounded attempt. Reconstructed data has explicit provenance and never overwrites D1 or original gzip shards. The initial gap inventory comes from the latest persisted governance record; gaps discarded by an older collector need an additional inventory from historical archived records before claiming full event coverage.

Historical minute books, live execution queues and complete unsaved snapshots have no verified replay source. Hourly history or log reconstruction must not be promoted to an original minute snapshot.

## Acceptance and rollback

Local checks: JavaScript syntax, complete Node tests, asset build, Wrangler dry run, current-schema public queue read, independent core/auxiliary persistence tests and desktop/mobile browser inspection.

Observed local results on 2026-10-14: 51 Node tests passed; syntax and asset build passed; Wrangler dry-run compiled the Worker (53.96 KiB, gzip 16.90 KiB), without publishing. A first run could not write the default external log directory; rerunning with `WRANGLER_LOG_PATH` inside ignored local `data/` passed without that warning. Browser verification showed only BTC/ETH market rows, an HL row with grey text and `line-through`, a dynamically updated 1,000 U minimum-notional heading, and no document overflow at a 390 px viewport. The local history endpoint and browser displayed nine minute samples from 15:52 through 16:00 Singapore time; this is local evidence only.

Recovery retrieved 90 public hourly rows. The latest governance checkpoint still contains nine gap intervals totaling 90,465 blocks and a public RPC rate-limit error. These files are reconstructed local evidence, not repaired production snapshots; complete historical governance coverage is not yet verified.

Production publication requires separate approval: apply additive migration 0002, deploy this Worker with the two Cron triggers, verify core samples and separate source status, then inspect `exceededCpu` and minute coverage. A local pass does not prove the Free plan CPU issue is resolved. Target a monitored 24-48 hour acceptance period with fresh core records, no continuing CPU-failure bursts and explicit remaining source errors. No plan or billing change is included.

Rollback: restore the preceding Worker version and its single Cron trigger. Leave `auxiliary_state`, D1 snapshots and reconstructed local files intact; the previous Worker ignores the additional table. Never rewrite historical shards to force count equality.

## Approved production release

The user approved the migration and deployment on 2026-10-14. Migration `0002_auxiliary.sql` applied successfully (three statements, existing snapshots retained). Worker version `4ed4756a-f8b5-4722-9dd5-8f928273b815` deployed with both Cron triggers. Read-only production verification passed: live core sources succeeded, two new minute records appeared at 08:10 and 08:11 UTC, CSV returned data, and POST returned 405. Persisted new rows mark Binance disabled. Auxiliary data initially came from the migration seed and is not yet proof that the new auxiliary Cron ran successfully.

The first version-specific Cloudflare metrics showed two invocations, zero errors, and CPU median 29.01 ms. This is an early, small snapshot; CPU remains above the nominal Free-plan 10 ms budget, so the release is not evidence that quota-related failures are permanently resolved. Longer observation and separate auxiliary invocation evidence remain necessary.

At 08:20 UTC the auxiliary invocation wrote fresh state to D1: public hourly history succeeded; governance RPC was rate limited and eight gap intervals remained explicitly recorded. The core snapshot for 08:20 UTC also persisted, demonstrating that this auxiliary source failure did not erase or prevent that minute's core record. Cloudflare's Cron history showed successful minute invocations from 08:10 through 08:16; the later observed CPU times were 13.611–18.527 ms. Both Cron definitions were also verified in the production settings. Long-term Free-plan reliability and full governance recovery remain unverified.
