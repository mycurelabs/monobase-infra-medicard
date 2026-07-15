# hapihub-migrator — Adversarial Review (Findings)

**Date:** 2026-07-15 · **Mode:** read-only, code + config. Live prod DB/cluster sampling was **blocked by the auto-mode classifier** (nested SSH into the prod bastion needs explicit user approval naming the prod target) — every data-dependent claim below is marked and queued in "Checks queued for approval." Code claims are grounded in `~/Projects/mycure/mono/services/hapihub-migrator/src` at the checked-out commit.

Axis: **CORRECTNESS** (loses/corrupts data) | **EFFICIENCY** (wastes time/mem/conn/money).
Severity: CRITICAL (loss/corruption/mixing) / HIGH / MEDIUM / LOW.
Confidence: CONFIRMED (root cause cited) / PLAUSIBLE / UNCERTAIN.

---

## Findings table (NEW before KNOWN; then Severity, then Confidence)

| # | Finding | Axis | N/K | Sev | Conf | Root cause (file:line) | Trigger / cost driver | Impact |
|---|---|---|---|---|---|---|---|---|
| TYPE-5 | Coercion-null drops are never counted as errors | CORR | NEW | CRITICAL | CONFIRMED | transformer.ts:74/83/89; worker.ts:287,306 | Non-PK value fails coercion → NULL; PK coerces null → row swallowed by dedup map | Silent per-row/-field loss invisible to `maxErrorRate` — same failure class worker.ts:252-258 was hardened against for decryption |
| CDC-N2 | Delete-then-recreate reordered within a batch | CORR | NEW | HIGH | HIGH | changelog-replayer.ts:177-190 | Same `_id` gets delete(seqN) + insert(seqN+2) in one `cdcBatchSize` window | Upserts all applied before deletes → recreated row wrongly deleted; row exists in Mongo, absent in PG |
| CRYPTO-1 | `PG_ENCRYPTION_KEY` injected but never read → PII plaintext at rest | CORR | NEW | HIGH | HIGH | deployment.yaml:126-131; absent in src/ (grep) | Any bulk run | Decrypted PII (personal-details, medical-records, billing-*) written to PG in cleartext; the configured key is false assurance |
| CRYPTO-4 | All 5 enc secrets `optional:true` → missing key silently drops encrypted docs | CORR | NEW | HIGH | HIGH | deployment.yaml:113/119/125/137/143; encryption.ts:69 | Typo/omitted/rotated-not-synced secret | Partially-encrypted collection: PII rows vanish under 1% error ratio; fully-encrypted collection fails (loud) |
| CONT-5 | No leader election / lease / lock anywhere | CORR | NEW | HIGH | CONFIRMED | coordinator.ts (whole); checkpoint.ts:106-146 | Two live pods share a run_id (HPA, rolling deploy overlap, dup RUN_ID) | Interleaved `last_id`/`markCompleted` races → cursor rewind, false completion; safety rests only on replicaCount:1 |
| CONT-7 | Hard-kill leaves collections permanently `in_progress` (no reaper) | CORR | NEW | HIGH | CONFIRMED | worker.ts:214/233; checkpoint.ts:106-146 | SIGKILL/OOM mid-`for await` (e.g. medical-records) | Perpetual in_progress; that orphan row is what keeps a stale run winning resume election |
| CONT-6 | `recordPhase1Complete` fires despite skipped/failed collections | CORR | NEW | HIGH | PLAUSIBLE | index.ts:481; coordinator.ts:93-107,155-175; worker.ts:87-95 | Resumed run with missing PG table / wrong key / thrown worker | `__phase1_complete` marker written though incomplete → CDC gating & "is bulk done?" read as finished |
| TYPE-4 | Per-document field-type variance → silent NULL | CORR | NEW | HIGH | CONFIRMED | transformer.ts:50-105 | Same field varies BSON type across docs | Docs whose value shape is unexpected get NULL, no error, no counter — silent field loss |
| CDC-N4 | Failed replay event skipped, cursor advanced, changelog row purged | CORR | NEW | HIGH | PLAUSIBLE | changelog-replayer.ts:109,122,281-287,329-335 | Any per-event throw caught+logged inside a batch | Event lost forever, no retry/dead-letter; cursor moves past it and `deleteMany` removes it |
| CDC-N5 | Unknown / missing-table collection events dropped + cursor advanced | CORR | NEW | HIGH | HIGH | changelog-replayer.ts:164-173,342-345,109,122 | Collection in stream match-list but not in COLLECTION_MAP, or PG table not yet created | Events silently discarded, cursor advanced, changelog purged — unrecoverable |
| EFF-1 | GridFS→S3 non-idempotent, no per-file checkpoint | CORR | NEW | HIGH | HIGH | gridfs-to-s3.ts:100,169-301 | Any re-run (OOM restart, evict, RESUME) | Re-downloads+re-PUTs every file from byte 0; under 32Gi ceiling it livelocks (OOM→restart→OOM), never converges |
| EFF-2 | GridFS fileId keyed by `_id` in Part-3 vs app `id` in Part-2 → dup/orphan S3 | CORR | NEW | HIGH | MED-HIGH | gridfs-to-s3.ts:218,250-253,257 | `files.files._id` ≠ `storage.files.id` | Existence guard compares wrong keys → same file re-migrated under a second S3 key; orphan/dup objects, PG rows point at wrong key |
| CONT-2 | Completed-skip is run-scoped → resume re-scans everything not in this run | EFF | NEW | HIGH | CONFIRMED | worker.ts:103-104; checkpoint.ts:86-90 | Auto-resume lands on a low-progress run | ~97/127 collections re-scanned each resume; the engine behind "37 runs, never converges" |
| CONT-11 | Resume election + completed-skip are O(re-scan-all-not-in-run) at scale | EFF | NEW | HIGH | CONFIRMED | worker.ts:103-115; checkpoint.ts:54-68 | Every failed run adds orphan rows (now 1201/37) | Unbounded `_migration_checkpoints`; each restart does O(total data) work, near-zero convergence — a scaling wall |
| EFF-4 | GridFS loads 4 full `.toArray()` materializations | EFF | NEW | HIGH | HIGH | gridfs-to-s3.ts:186,213,247,251 | Part-3 startup | O(all storage docs) resident before a single file byte; compounds EFF-1 OOM |
| CDC-N8 | cdc-metrics blind to every silent-stop; dead collector reads as zero-lag | CORR | NEW | MED | HIGH | cdc-metrics.ts (whole); changelog-replayer.ts:382 | Collector dies (CDC-K2) | `lagEvents→0` as replayer drains frozen changelog → dead pipeline looks perfectly healthy |
| CDC-N9 | Collector/replayer launched fire-and-forget, unsupervised | CORR | NEW | MED | HIGH | index.ts:551-558 | Collector throws | Nothing restarts it; replayer runs forever against a static changelog |
| CDC-N1 | `clusterTime` decoded as ms (it's a BSON Timestamp) → lag metric garbage | CORR | NEW | MED | HIGH | changelog-collector.ts:286-288; changelog-replayer.ts:390-391 | Every event | Stored clusterTime lands in 1970; `lagMs` permanently huge → the one stall-detecting metric is meaningless |
| CRYPTO-9 | AES key can leak into logs via `JSON.stringify(config)` | CORR/SEC | NEW | MED | MED | encryption-core.ts:71,107; worker.ts:234; batch.ts:187 | Any entity-type guard throw that gets logged | Raw `HEXKEY-HEXIV` reaches the log stream |
| CRYPTO-5 | `_eh` hash couples to the field list → correct key silently rejected | CORR | NEW | MED | HIGH | encryption-core.ts:27; encryption.ts:70 | Migrator's `encryptedFields` ≠ legacy writer's list | Every doc "wrong key" skipped/dropped though key is correct; presents identically to a wrong key |
| MODE-4 | `/reverse-cdc/changelog` returns raw row PII unauthenticated | SEC | NEW | MED | HIGH | server.ts:390-398 | Unauth GET in a reverse-cdc pod | Bulk cleartext PII exfil (`new_row` pre-image); inert in forward pods (ctx undefined) |
| CDC-N6 | Text-id delete misses rows written by older migrator → orphan | CORR | NEW | MED | MED | cdc-delete.ts:64-68,80,102 | No pre-image + text idField + row bulk-migrated by <3.7.10 | DELETE matches only `_data->>'_id'`; older rows have none → silent no-op → PG orphan (compounds K1) |
| CDC-N3 | Deletes carry no latest-wins guard | CORR | NEW | MED | MED | cdc-delete.ts:81-108 | Stale delete replayed after a legit recreate | Unconditional DELETE removes a row it shouldn't (upsert path has the `updated_at<=` guard; delete path doesn't) |
| CDC-N7 | `saveMeta`/`insertOne` non-atomic → seq reuse → E11000 wedge | CORR | NEW | MED | MED | changelog-collector.ts:140,296-299 | Crash between insert and saveMeta | Re-delivered event re-uses seq → unique-index throw → stream error/backoff loop |
| CONT-9 | Resume `_id` type detected from ONE sample doc → mixed-`_id` drops string ids | CORR | NEW | MED | PLAUSIBLE | worker.ts:131-132,124-127 | Mixed-`_id` collection, sample returns ObjectId | Resume builds `{_id:$gt ObjectId}` matching zero string-`_id` docs → silently skipped rest of run |
| CONT-4 | `markStarted` resets `started_at` → feedback loop entrenching stale run | CORR | NEW | MED | CONFIRMED | worker.ts:117 | Crashlooping run refreshes its `started_at` each resume | Positive-feedback lock-in to the wrong run in the CONT-1 election |
| CONT-10 | Trailing partial batch `last_id`/`processed` never checkpointed | CORR | NEW | MED | PLAUSIBLE | worker.ts:182,207-214 | Kill after final partial batch, before markCompleted | `last_id` lags by ≤batchSize; final `processed` bump lost (idempotent re-scan, cosmetic drift) |
| TYPE-9 | ObjectId→text PK, `String(obj)`→`"[object Object]"` collision | CORR | NEW | MED | PLAUSIBLE | transformer.ts:19-42 | `_id` an unexpected object shape | All such docs collide on one PK → upsert-collapse to a single row, silent |
| TYPE-8 | `boolean` coercion drops truthy values to NULL | CORR | NEW | MED | CONFIRMED | transformer.ts:85-89 | Column receives `"1"`,`"yes"`,`2`,`""`,object | Loose Mongo bools → NULL, indistinguishable from real null |
| TYPE-7 | NaN/Infinity/−0 floats pass through | CORR | NEW | MED | PLAUSIBLE | transformer.ts:77 | `NaN`/`Inf` in a numeric field | Corrupts SUM/AVG silently; on a `numeric`-DDL col PG rejects → row drop via halving path |
| EFF-6 | No prepared statements; unique SQL text per batch → plan-cache miss | EFF | NEW | MED | HIGH | batch.ts:153-173,334 | Every batch + every CDC single-row upsert | PG re-parses+re-plans each batch; O(batches) parse/plan overhead |
| EFF-7 | Halving fallback re-serializes whole batch each level → O(N log N) | EFF | NEW | MED | HIGH | batch.ts:196-205,157-169,343 | One bad row in a 500-row batch | ~9 rebuild passes over shrinking slices per failure |
| EFF-11 | Triggers/indexes live during bulk load | EFF | NEW | MED | HIGH | init-pg.ts:110; pg-trigger-manager.ts (reverse-only) | Whole bulk load | Per-row `_data->>'_id'` index maintenance + FK checks over O(total docs); no drop/recreate |
| EFF-3 | GridFS crash between S3 PUT and PG upsert → untracked object | CORR | NEW | MED | HIGH | gridfs-to-s3.ts:224/275,227/278 | Crash after PUT, before upsert | S3 object with no PG row = orphan; PUT overwrite silent (no IfNoneMatch) |
| EFF-5 | GridFS Part-3 `openDownloadStream(_id)` vs Part-2 `...ByName(id)` | CORR | NEW | MED | MED | gridfs-to-s3.ts:221,267 | `files.files.filename` ≠ app id | Part-2 by-name download throws FileNotFound / fetches wrong file on real legacy data |
| EFF-14 | 32Gi limit / 1Gi request + liveness disabled | OPS | NEW | MED | HIGH | medicard.yaml:539-544,549-553 | 31Gi burst headroom only to absorb EFF-1/4 | Pod scheduled on node that can't satisfy the spike → node-level OOM; wedged migrator never restarted |
| MODE-2 | Unauthenticated DDL endpoints (trigger reinstall/teardown) | SEC | NEW | MED | HIGH | server.ts:346,361,320,328 | Unauth POST in a reverse-cdc pod | `DROP/CREATE TRIGGER` against prod PG by any cluster-local caller; inert in forward pods |
| TYPE-10 | Mixed-type JSONB: Long stringified asymmetrically | CORR | NEW | LOW-MED | CONFIRMED | transformer.ts:303-321 | Long inside an array (≤int32 number, else string) | Same logical field typed number/string across elements → inconsistent `_data->>` consumers |
| EFF-9 | Pool `max:20` vs `collectionConcurrency:1` → 19 idle conns | EFF | NEW | LOW-MED | HIGH | index.ts:73-78; medicard.yaml:558 | Bulk runs one collection at a time | Wasted Azure PG connection slots + idle-reap churn |
| EFF-13 | Dockerfile full ubuntu runtime for one static Bun binary | OPS | NEW | LOW-MED | HIGH | Dockerfile:19-23,35 | Build | Oversized image; `wget` only for a HEALTHCHECK k8s ignores (non-root correctly set) |
| CRYPTO-7 | Non-`$$enc$$` field is silent pass-through | CORR | NEW | LOW | MED | encryption-core.ts:112,76-77 | Field that should be encrypted stored unprefixed | Passed to PG as-is, no signal; another errors=0 blind spot |
| CRYPTO-8 | Malformed hex ciphertext → truncated bytes, no error | CORR | NEW | LOW | MED | encryption-core.ts:119 | Odd-length/non-hex ciphertext body | `enc.Hex.parse` silently coerces → garbage plaintext (rejoins CRYPTO-2) |
| TYPE-11 | CDC `insertSingleRow` runs with no logger, no retry | CORR | NEW | LOW | CONFIRMED | batch.ts:331-335 | Single CDC event coercion/type error | Bypasses batch retry+structured-error path; per-event asymmetry |
| TYPE-12 / EFF-8 | `estimateBatchBytes` uses `.length*2` (UTF-16 units) | EFF | NEW | LOW | UNCERTAIN | batch.ts:357,359 | Byte-guard sizing | Over-counts ASCII, under-counts astral chars; relies on reactive RangeError fallback |
| EFF-12 | GridFS upsert ON CONFLICT updates only 3 columns | CORR | NEW | LOW | HIGH | gridfs-to-s3.ts:140-143 | Re-run with changed file metadata | filename/size/contentType not refreshed; `updated_at=NOW()` breaks latest-wins |
| CONT-8 | `pending` status never written by this code — legacy-only match | CORR | NEW | LOW | CONFIRMED | checkpoint.ts:58,27,108-109 | Mixed-version 1201-row history | Resume filter's `pending` arm matches only foreign-version rows → widens non-determinism |
| EFF-10 | Per-table `CREATE INDEX IF NOT EXISTS` serially on every startup | EFF | NEW | LOW | HIGH | init-pg.ts:121-141 | Startup | O(tables) DDL probes even when all exist |
| MODE-5 | `correct-overflow` interpolates identifiers from generated map | SEC | NEW | LOW | MED | correct-overflow.ts:42,162 | Only via `MODE=correct-overflow`, trusted input today | Injection surface if the generated map is ever built from untrusted schema; not HTTP-reachable |
| CONT-1 | `findLatestInProgressRunId` picks oldest-incomplete, not most-complete | CORR | KNOWN | CRITICAL | CONFIRMED | checkpoint.ts:56-61; index.ts:105-108 | RESUME=true, RUN_ID unset | Resumes 30/127 run over 85/127; completed collections get zero deltas |
| TYPE-1 | Decimal128 → NULL on monetary fields | CORR | KNOWN | CRITICAL | CONFIRMED | transformer.ts:76-83; pg-introspect.ts:20-23 | Any Decimal128 (driver serializes as object, not `$numberDouble`) | All money in `real`/float8 (rounding) or NULLed; `numeric` DDL downgraded to float at introspection |
| TYPE-2 | BigInt columns mislabeled `integer`; precision lost before range guard | CORR | KNOWN | CRITICAL | CONFIRMED | pg-introspect.ts:16-19; transformer.ts:62-74; :183-190 | Mongo Long > 2^53 | `bsonLongToSafe` computes `high*2^32+low` in float64 — rounds *before* the range test; string sent to int column |
| CRYPTO-2 | CBC decrypt has no MAC → garbage plaintext, errors=0 | CORR | KNOWN | HIGH | HIGH | encryption-core.ts:118-122 | Corrupted/truncated ciphertext with valid `_eh` | Valid-UTF-8 → garbage in PG; invalid-UTF-8 → uncaught throw fails whole collection |
| CRYPTO-3 | Wrong/missing key skips whole collection, errors:0 | CORR | KNOWN | HIGH | HIGH | worker.ts:82-96,194 | `WrongEncryptionConfigurationError` | `maxErrorRate` divides by processed=0 → never trips; invisible to failedCollections |
| TYPE-3 | Date → `timestamp` not `timestamptz`; `date` cols get datetimes | CORR | KNOWN | HIGH | CONFIRMED | pg-introspect.ts:29-31; transformer.ts:142-171; migrations-bundle DDL | Any tz-bearing Date | tz drift; day-boundary drift on `date` cols; DDL itself declares bare `timestamp` |
| TYPE-6 | NUL byte / invalid UTF-8 → whole row dropped (counted) | CORR | KNOWN | HIGH | CONFIRMED | transformer.ts:51-101; batch.ts:196-224 | ` ` in text/jsonb | Batch fails → halving → per-row → row dropped (counted, but a single byte kills the row vs sanitizing) |
| CDC-K1 | Deletes never reconciled (pre-collector deletes = permanent orphans) | CORR | KNOWN | HIGH | CONFIRMED | worker.ts; cdc-delete.ts; changelog-collector.ts | Doc deleted before stream opens | Live PG orphan row, no diff/reap pass anywhere |
| CDC-K2 | Oplog-retention exhaustion → silent stop | CORR | KNOWN | HIGH | CONFIRMED | changelog-collector.ts:238-270 | `ChangeStreamHistoryLost` (286) / `invalidate` | No branch; dead-token retry loop → throw → swallowed in cdc mode → silent permanent stop |
| CDC-K3 | Snapshot/stream handoff gap (cutoff stamped before stream opens) | CORR | KNOWN | HIGH | CONFIRMED | config.ts:121; index.ts:422-428; collector.ts:95-105,214-224 | First run, no resume token → stream from 'now' | Writes in `[cutoffDate, stream-open]` with `_cd>cutoff` excluded from bulk AND stream → permanently lost |
| MODE-1 | Reverse write-back to Mongo is one env var from forward | CORR | KNOWN | HIGH | HIGH | config.ts:88; index.ts:153,210; reverse-apply.ts:96,163,180-189 | `MODE=reverse-cdc REVERSE_APPLY=true` on same MONGO_SOURCE_URI | Hard `deleteOne`/`insertOne` back into live source-of-truth mid-migration; no runtime guard |
| EFF-KNOWN | INSERT not COPY; indexes live; oversized 32Gi | EFF | KNOWN | MED | CONFIRMED | batch.ts:173; init-pg.ts; medicard.yaml:539-544 | Whole load | (See EFF-6/11/14 for the sharpened mechanisms) |
| MODE-3 | `POST /verify` unauthenticated, LIVE in forward pods | SEC | KNOWN | MED | HIGH | server.ts:223,248-270; index.ts:418,364 | Unauth POST | Full-collection Mongo `$sample`+PG scan DoS amplifier; per-collection route has no concurrency guard |
| CONT-3 | Fresh-runId re-scans all (safe), resumed-runId skips completed | CORR | KNOWN | INFO | CONFIRMED | index.ts:99-113; worker.ts:103-145 | — | Diagnostic for the continuation verdict (below) |

---

## Per-finding detail (leads: CRITICAL + HIGH NEW; KNOWN validated tersely)

### TYPE-5 — Coercion-null drops never counted (CRITICAL, NEW)
`coerceValue` returns `null` on any unhandled shape (transformer.ts:74 integer, :83 real, :89 boolean). worker.ts transforms **after** the drop-counting loop (259-284); only *decryption* drops increment `droppedCount`. A row that fails coercion on a non-PK field still inserts (with nulls, no error). A row whose **PK** coerces to null is dropped silently by the dedup map (`worker.ts:306 if (pk != null)`) with no `errors++`. `maxErrorRate` is blind to both. This is the exact silent-completion hazard the comment at worker.ts:252-258 was added to fix for decryption — the type path never got the same fix. **This is the single most dangerous new correctness finding.**

### CDC-N2 — Delete-then-recreate reordered (HIGH, NEW)
changelog-replayer.ts:177-190 splits a collection's events into `upsertEvents` and `deleteEvents` and applies **all upserts, then all deletes**, ignoring interleaved seq. delete(seqN)+insert(seqN+2) co-batched (default cdcBatchSize=100, poll 1s) → upsert(N+2) writes the row, delete(N) removes it. Final state: row present in Mongo, **absent in PG**. PK-dedup (:262-267) only orders upserts among themselves.

### CRYPTO-1 — `PG_ENCRYPTION_KEY` dead → PII plaintext at rest (HIGH, NEW)
Chart sets `PG_ENCRYPTION_KEY` (deployment.yaml:126-131); no reference exists in `src/` (grep exit 1), no `pgEncryptionKey` in config.ts. The migrator **decrypts** source fields (worker.ts:279) and writes the plaintext straight into PG — no re-encryption. personal-details (`id`,`email`), medical-records (`account`/`facility`/`patient`/`encounter`), billing all land cleartext. The configured-but-unused key reads as "PG is encrypted at rest" when it is not.

### CRYPTO-4 — Optional enc secrets → silent PII drop (HIGH, NEW)
All 5 `enc-*` secretKeyRefs are `optional:true`. `buildEncryptionMap` (encryption.ts:69) `continue`s past a falsy env → collection gets `encConfig=undefined` → every encrypted doc hits the drop path (processBatch:263-269). Fully-encrypted collection fails loudly (ratio=1.0); a **partially** encrypted one keeps its plaintext docs and silently loses the encrypted PII rows if their fraction < maxErrorRate. Security-critical keys should never be optional. (personal-details-history 0/271k is the documented precedent, worker.ts:255-258.)

### CONT-5 — No leader election / lock (HIGH, NEW)
coordinator.ts has no advisory lock / lease / `SELECT…FOR UPDATE` / ownership column; `runWithConcurrency` is in-process only; checkpoint writes are unconditional upserts. Two pods on one run_id → interleaved `updateProgress`/`markCompleted` → a slower cursor clobbers `last_id` (rewind + re-scan), or pod B marks completed while pod A scans. Two auto-resumed pods can also elect the *same* stale run. Correctness is silently delegated to `replicaCount:1` + no-overlap deploys; nothing in code enforces either.

### CONT-7 — Hard-kill → permanent `in_progress`, no reaper (HIGH, NEW)
`in_progress`→`completed` only via cursor exhaustion (worker.ts:214); →`failed` only via catch (:233). SIGKILL/OOM mid-`for await` runs neither → row stuck `in_progress` forever. No timeout/heartbeat/reaper. medical-records / personal-details-history OOM reliably before exhaustion. Consequence chain: (1) the stuck row is exactly what wins the CONT-1 resume election; (2) the 1201-row/37-run litter is orphan `in_progress`/`pending` rows, each a resume candidate → history-wide non-determinism.

### CONT-6 — False phase-1 completion (HIGH, PLAUSIBLE)
`recordPhase1Complete()` (index.ts:481) runs whenever `runMigration` returns without throwing. `runWithConcurrency` swallows thrown workers into `errors:1` and never rejects the phase; missing-PG-table (coordinator.ts:93-107) and wrong-key (worker.ts:87-95) return `skipped`. So a resumed run with skipped/failed collections still writes `__phase1_complete` (checkpoint.ts:178-188). Any operator/CDC gate reading `getPhase1CompleteTime` concludes bulk finished when it did not.

### TYPE-4 — Per-field type variance → silent NULL (HIGH, CONFIRMED)
Column type is schema-fixed (not first-doc-wins — good), but any doc whose value doesn't match the hardcoded shape for that PG type returns NULL with no error/counter (transformer.ts:50-105). A field that's a number in 99% of docs and an object in 1% → those rows get NULL, invisible to `maxErrorRate`.

### CDC-N4 / CDC-N5 — Captured events dropped with cursor advance (HIGH)
N4: a per-event throw inside `processCollectionEvents` is caught+logged (replayer:281-287, 329-335); the batch loop still advances `maxSeq` (:109) and `deleteMany`s the changelog rows (:122) → the event is gone, no retry, no dead-letter. N5: same fate for a collection missing from COLLECTION_MAP or whose PG table doesn't exist yet (:164-173, 342-345). These lose data the stream **did** capture — worse than K1.

### EFF-1 / EFF-2 / EFF-4 — GridFS→S3 (HIGH)
EFF-1: no checkpoint, no `HeadObject` before PUT (gridfs-to-s3.ts:100) → every re-run re-downloads+re-PUTs from byte 0; the only collection with zero resume support → OOM→restart→OOM livelock under the 32Gi ceiling. EFF-2: Part-3 keys by `files.files._id` (:257) but Part-2 and the existence set key by app `id` (:218,250-253) → guard compares wrong keys → duplicate S3 objects + orphans + PG rows pointing at the wrong key. EFF-4: four full `.toArray()` materializations (:186,213,247,251) resident before any file byte.

### CONT-2 / CONT-11 — Run-scoped skip = non-convergence engine (HIGH, CONFIRMED)
`getCheckpoint` is `WHERE run_id=$1` (checkpoint.ts:88); completed-skip fires per (run_id, collection) (worker.ts:104). A resumed old run has no rows for ~97 collections → re-scans them even if a newer run already migrated all 127. Completion never crosses run_id. Each failed run adds orphan rows; `findLatestInProgressRunId` re-scans an unbounded, ever-growing table each startup (already 1201/37). O(total data) per restart, near-zero convergence — the concrete mechanism behind "never completed."

**KNOWN validated (fresh evidence):** TYPE-1/2/3/6 confirmed against the DDL in `migrations-bundle.ts` (all timestamp cols bare `timestamp`; `_data` jsonb + typed overflow columns; no `numeric`/`bigint`/`timestamptz`/`uuid` labels; introspection collapses real DDL into a 6-type vocab: text 1430, json 555, timestamp 450, boolean 145, real 112, integer 58). CRYPTO-2/3, CDC-K1/K2/K3, MODE-1/3 confirmed as described.

---

## Continuation-run verdict

**A second bulk run is NOT safe to converge as-is.** Not because of dup rows (upserts are idempotent — `ON CONFLICT DO UPDATE`, batch.ts:116-135; not re-litigated) but because:

1. **It resumes the wrong run.** RESUME=true + RUN_ID unset → CONT-1 elects the oldest-incomplete run (30/127), and CONT-2 makes its completed-skip run-scoped, so the 85/127 run's progress is unusable. Result: it re-scans ~97 collections and still drops the deltas on the 30 it thinks are "completed."
2. **A fresh RUN_ID is the only safe re-sync** — it re-scans every collection and re-upserts current Mongo state (catches all inserts/updates since Feb). Resuming Feb's runId skips every `completed` collection (worker.ts:104 + run-scoped getCheckpoint) → migrates **zero deltas silently**.
3. **Deletes are never caught either way** (CDC-K1 + N6): a doc deleted in Mongo since Feb leaves a permanent PG orphan; no diff/reap pass exists. A full re-scan+upsert cannot remove it.
4. **Source is wrong.** The pod crashloops on `mycure-stg-sh` (a **staging** Atlas cluster). Until the source is corrected to prod Mongo and DNS/network is reachable, forward progress is zero regardless of run semantics. **[queued: confirm intended source]**

**Must change before a converging run:** (a) set RUN_ID to a fresh id (not resume); (b) fix `MONGO_SOURCE_URI` to prod Mongo + verify DNS/Private-Link reach; (c) add a delete-reconciliation/anti-join pass or accept permanent orphans; (d) make enc secrets non-optional and add a wrong-key/`errors=0`-skip alarm; (e) fix the type-coercion silent-drop (TYPE-5) so a converging run doesn't quietly lose fields. Convergence also requires CONT-7's reaper or a manual checkpoint cleanup, else the 1201-row litter keeps mis-electing.

---

## Mode assessment (Medicard = forward-only)

| Mode | Verdict | Reason | Risk if kept | Blast radius if removed |
|---|---|---|---|---|
| `bulk` | KEEP | Core forward Phase 1; default | none (required) | migration can't run |
| `cdc` | KEEP | Core forward Phase 2 | none (required) | no incremental sync |
| `verify` | KEEP | Read-only; writes only its own bookkeeping table | Unauth `POST /verify` DoS amplification (MODE-3) | lose integrity verification |
| `reverse-cdc` | **REMOVE** | Dead for forward-only; installs prod DDL triggers + optional Mongo write-back | MODE-1 (write-back), MODE-2 (unauth DDL), MODE-4 (unauth PII) | none for Medicard; loses PG→Mongo rollback |
| `reverse-bulk` | **REMOVE** | Dead; bulk Mongo write-back incl. hard deletes | MODE-1 (bulk write-back / hard deleteOne) | none for Medicard |
| `correct-overflow` | **REMOVE (or KEEP-low)** | PG-only, Mongo-safe, HTTP-unreachable; still `UPDATE`s migrated rows | MODE-5 (low, non-HTTP identifier interpolation) | loses stranded-`_data` repair tool |

Forward and reverse write paths are **code-disjoint** (reverse imports neither batch.ts nor coordinator.ts nor forward transformer.ts — grep-confirmed); they share only the read-only `collections.ts` registry + introspected schema. So a reverse mode can't corrupt forward *through shared code* — the entanglement is at the **data layer** (both write the same Mongo/PG). The entire non-forward safety model reduces to "the `MODE` env var is correct and nobody flips it," with a **write mode (`bulk`) as the silent default** (config.ts:88). Strongest single hardening: delete the three reverse/overflow modes → MODE-1/2/4/5 all evaporate.

---

## Sample-issue disposition (no forced links)

| Issue | Disposition | Reasoning |
|---|---|---|
| #2309 MDT V8-vs-MCX sync discrepancy | **RELATED** | Missing pre-June-23 records = incomplete/non-converged migration (CONT-1/2). "Many records with the same date/time June 25 9:29" = source timestamps overwritten with migration wall-clock — corroborates the timestamp-handling class (TYPE-3) and the `_cd`/created_at path. **[queued: sample PME rows for collapsed created_at]** |
| #2301 MDT Force Sync (online has 6/24+6/26, Maestro only 6/26) | **UNCLEAR** | Online-vs-Maestro delta points at Syncbase/Maestro local sync, a different system from the Mongo→PG migrator. Could also be CDC lag (CDC-N8/K2) if the online store is PG. Don't force a link. **[queued: confirm whether "online" store = migrator PG]** |
| #2109 Cleanup ("disable migrator, sweep dataset") | **RELATED (ops)** | Directly about operating the migrator (disable + post-fix sweep); ops tracking, not a code defect. Context, not a finding. |
| #2104 hapihub insurance_coverages missing index + N+1 | **LIKELY-UNRELATED** | Live-app query perf in `services/hapihub` (a different service). No migration path. Efficiency, but not this migrator. |
| #2101 Skin 101 queue suddenly populated with old patients | **UNCLEAR** | Consistent with delete-orphans (CDC-K1/N6) — old queue entries removed in Mongo but never reaped in PG resurface. Equally a FE queue-filter bug. Cannot confirm without data. **[queued: anti-join queue collection PG id vs Mongo _id]** |
| #2092 Skin 101 MOA V8 total-sales missing in MCX | **RELATED** | Sales data absent post-migration = incomplete/non-converged migration (CONT-1/2) and/or a skipped/failed billing collection. **[queued: which of the 13 failed collections in run-1775615785047 are billing]** |

---

## Checks queued for approval (writes/DB mutations — none write; all are read-only but need cluster/bastion approval)

All blocked by the auto-mode classifier (nested SSH into prod bastion). Each is **read-only**; the psql ones need an approval-gated ephemeral pod.

1. **Checkpoint thrash / resume election** — `SELECT run_id, status, count(*) FROM _migration_checkpoints GROUP BY 1,2 ORDER BY 1,2;` → confirm the 37-run pattern and which run auto-resume elects (validates CONT-1/2/7/8).
2. **Live pod state/logs** — `kubectl -n medicard get pods -l app…name=hapihub-migrator -o wide` + filtered logs (`grep msg/runId/collection/status`) → confirm crashloop + `mycure-stg-sh` DNS failure (validates the source-environment finding).
3. **Which 13 collections failed** in run-1775615785047, and why (#2092 disposition).
4. **medical-records** perpetual in_progress cause — row count / size / enc / cursor (CONT-7).
5. **Delete-orphan magnitude** — per-collection anti-join PG `id` vs Mongo `_id` (CDC-K1/N6; #2101).
6. **Type-corruption incidence** — sample money (Decimal128→null/float), bigint (Long>2^53), timestamp (tz/collapsed) values in PG vs Mongo (TYPE-1/2/3/5; #2309).
7. **Source confirmation** — is `mycure-stg-sh` the intended prod source, and does target PG already hold staging-derived rows (Continuation verdict #4).
8. **At-rest PII** — sample a personal-details / medical-records PG row: cleartext or ciphertext? (CRYPTO-1).

---

## Modules swept clean (no new finding above LOW on either axis)

- **collections.ts** — registry/PK-field mapping only; sound. No coercion logic.
- **schema-reader.ts** — Drizzle-import path effectively dead at runtime (pg-introspect supersedes); no coercion defect beyond the shared 6-type vocab.
- **pg-retry.ts** — retryable SQLSTATE set sound; statement-boundary retry correct for the implicit-txn path (interaction note only, EFF-15).
- **pg-introspect.ts** — schema cache correct; parallelized column+PK queries fine.
- **pg-trigger-manager.ts** — identifier validation + idempotent install/teardown correct; reverse-cdc-only (the bulk-load gap is EFF-11 at the architecture level, not a bug here).
- **coordinator.ts `runWithConcurrency`** — bounded-concurrency primitive correct (its only danger is the multi-pod CONT-5 case).
- **buildConflictClause (batch.ts:116-133)** — latest-wins `<=` tie logic correct.
- **verify.ts / verify-store.ts** — read-only; all PG queries parameterized; table names from trusted registry, not HTTP input.
- **reverse-scope.ts / reverse-transformer.ts** — pure filter / pure transform, no I/O (stale `reverse-capture` naming in reverse-scope.ts:6,12 is cosmetic — not a real mode).
- **audit.ts / synclog.ts** — best-effort advisory logging / reverse `_sl` minting; self-consistent, not on the forward correctness path (audit is *not* wired to any silent-stop condition — see CDC-N8).
- **cdc-metrics.ts** — internally correct counter store; the defect is what it omits (CDC-N8), not its logic.
- **migrations-bundle.ts** — auto-generated embedded DDL artifact; not logic. Corroborates TYPE-3 (bare `timestamp` throughout).

---

## Stop-condition note
Full SCOPE coverage achieved (every src/ file + chart + Dockerfile appears in Findings or Modules-swept-clean). Two clean passes on the low-severity tail were **not** run against live data because sampling is classifier-blocked; the queued checks (above) are the outstanding validation. Code-axis coverage is complete; data-axis validation is pending approval.
