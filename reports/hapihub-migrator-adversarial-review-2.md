# hapihub-migrator — Adversarial Review #2 (post mode-removal)

**Date:** 2026-07-15 · **Tree:** mono `chore/migrator-remove-reverse-modes` @ `278d9aac6` (the three non-forward modes `reverse-cdc`/`reverse-bulk`/`correct-overflow` removed). **Mode:** read-only, code + config. Live prod DB/cluster sampling remains **classifier-blocked** (nested SSH into prod bastion needs explicit approval) — data-dependent claims are queued below. All file:line re-anchored against the current (trimmed) tree.

This supersedes the mode-assessment axis of review #1. Findings on the unchanged forward files carry over; line numbers were re-derived, and new findings were surfaced with the mode noise gone.

Axis: **CORRECTNESS** / **EFFICIENCY** / **SEC**. Severity CRITICAL/HIGH/MEDIUM/LOW. Confidence CONFIRMED/PLAUSIBLE/UNCERTAIN.

---

## Mode-removal integrity (verified this pass)

Every axis agent independently confirmed the removal is clean:
- **Dispatch intact** — `index.ts` branches only `verify`, `bulk`, `cdc`; runId resolution and the `suppress_capture` GUC are unaffected. No dangling refs to the removed modes.
- **Server consistent** — `startServer(port, checkpoint, collector, replayer, config, logger, verifyCtx?, audit?)`; both call sites match; zero `/reverse-cdc/*` routes or `reverseCdcCtx` remain.
- **No forward dependency** on the deleted modules (`reverse-*.ts`, `pg-trigger-manager.ts`, `synclog.ts`, `correct-overflow.ts`); `audit.ts` enum correctly reduced to `migration|cdc|verification|system`.
- **Review-#1 MODE findings resolved by removal:** MODE-1 (reverse Mongo write-back), MODE-2 (unauth DDL endpoints), MODE-4 (unauth `_pg_changelog` PII read), MODE-5 (correct-overflow identifier interpolation) — all gone. The shared `_pg_changelog` DDL still ships in `migrations-bundle.ts` (hapihub-shared, idempotent), but the migrator no longer installs triggers or reads it; the `suppress_capture` GUC stays as a correct defensive no-op.

**One residual server finding survives the purge — see SEC-2.**

---

## Findings (NEW first, then KNOWN; sorted Severity, then Confidence)

| # | Finding | Axis | N/K | Sev | Conf | Root cause (file:line) | Impact |
|---|---|---|---|---|---|---|---|
| TYPE-5 | Coercion/PK-null & PK-collision drops uncounted; `processed += batch.length` unconditional so `maxErrorRate` is blind | CORR | KNOWN | CRITICAL | CONFIRMED | worker.ts:186,211,194,304-309; changelog-replayer.ts:261-266 | Batch silently shrinks and still `markCompleted`; per-row/-field loss never trips the guard |
| TYPE-1 | Decimal128 → NULL on money fields (real-case only handles `$numberDouble`; numeric/double DDL collapsed to `real`) | CORR | KNOWN | CRITICAL | CONFIRMED | transformer.ts:76-83; pg-introspect.ts:14-36,105 | Monetary columns silently NULL/rounded; `schema-map` `type` is discarded so precision is unrecoverable |
| CONT-1 | Auto-resume ranks incomplete runs by `started_at` **recency**, not completeness | CORR | KNOWN | CRITICAL | CONFIRMED | checkpoint.ts:54-68; index.ts:83-86 | Never converges on the best 85/127 run (SQL is `ORDER BY started_at DESC` — recency-ranked either direction) |
| CONT-5 | No leader election / lock anywhere | CORR | KNOWN | HIGH | CONFIRMED | coordinator.ts (whole) | Safety rests only on replicaCount:1; two pods race `last_id`/`markCompleted` |
| CONT-7 | Hard-kill leaves permanent `in_progress` (no reaper) | CORR | KNOWN | HIGH | CONFIRMED | worker.ts:117,236-238; index.ts:356-371 | OOM/SIGKILL strands the row; those rows are exactly what CONT-1 keeps re-electing |
| CONT-6 | `recordPhase1Complete` fires unconditionally despite skipped/failed collections | CORR | KNOWN | HIGH | CONFIRMED | index.ts:252-260; checkpoint.ts:178-188 | `__phase1_complete` written while collections missing → downstream reads bulk as done |
| CONT-2 | Completed-skip is run-scoped (`getCheckpoint WHERE run_id=$1`) | EFF | KNOWN | HIGH | CONFIRMED | checkpoint.ts:86-90; worker.ts:103-104 | Each resume re-scans every collection not completed under that exact run — the non-convergence engine |
| CONT-9 | Resume `_id` type inferred from ONE unsorted sample doc | CORR | KNOWN | HIGH | CONFIRMED | worker.ts:131-145 | Mixed-`_id` collection silently drops one id-class on resume; branch nondeterministic across restarts |
| NEW-1 | Resume recomputes `bulkCutoffDate = new Date()` each restart (RUN_ID unset path, no persisted cutoff) | CORR | NEW | HIGH | PLAUSIBLE | config.ts:81; coordinator.ts:133; worker.ts:155-164 | Bulk/CDC cutoff drifts forward per restart; no-gap contract broken (upsert-safe but non-deterministic, unbounded) |
| TYPE-2 | bigint mislabeled `integer`; `bsonLongToSafe` computes `high*2^32+low` in float64 before the range guard | CORR | KNOWN | HIGH | CONFIRMED | pg-introspect.ts:16-18; transformer.ts:183-190,62-74 | Long > 2^53 silently rounded/truncated |
| TYPE-4 | Per-document field-type variance → silent NULL, no counter | CORR | KNOWN | HIGH | CONFIRMED | transformer.ts:74,83,89 | Heterogeneous docs null the offending field; counted as success |
| TYPE-9 | ObjectId/object → text PK `"[object Object]"` collision (String(obj) fallback) | CORR | KNOWN | HIGH | CONFIRMED | transformer.ts:19-42,225 | Many docs collapse to one PK via the TYPE-5 dedup map; mass silent loss |
| CRYPTO-1 | `PG_ENCRYPTION_KEY` injected by chart but never read in src/ → PII plaintext at rest | CORR | KNOWN | HIGH | CONFIRMED | deployment.yaml:126-131; absent in src/ | Decrypted PII written to PG cleartext; the key is theater |
| CRYPTO-2 | CBC decrypt has no MAC; and `worker.ts:279 await decryptDocument` is **not** try/caught | CORR | KNOWN | HIGH | CONFIRMED | encryption-core.ts:118-122; worker.ts:279,232 | Garbage plaintext accepted (errors=0); OR one invalid-UTF-8 doc throws → kills the whole collection (verify.ts:225-229 catches, worker does not) |
| CRYPTO-3 | Wrong/missing key skips whole collection errors:0 | CORR | KNOWN | HIGH | CONFIRMED | worker.ts:82-96,194 | Invisible to maxErrorRate (processed=0) |
| CRYPTO-4 | All 5 enc secrets `optional:true` → missing key drops encrypted docs | CORR | KNOWN | HIGH | CONFIRMED | deployment.yaml:113-143; encryption.ts:69; worker.ts:263-269,328 | Now folded into errors (trips maxErrorRate after 1st batch) but a 100%-encrypted collection drops 100%; triggered by mere secret absence |
| CDC-K1 | Bulk deletes never reconciled; `scripts/reconcile-orphans.ts` is a manual CLI, not wired | CORR | KNOWN | HIGH | CONFIRMED | worker.ts; cdc-delete.ts; scripts/reconcile-orphans.ts:87,221,93 | Pre-collector deletes = permanent PG orphans; the reconciler is dry-run-default, hard-deletes only, excludes Better-Auth |
| CDC-K2 | Oplog/history exhaustion (`ChangeStreamHistoryLost`) treated as generic retryable → silent stop | CORR | KNOWN | HIGH | CONFIRMED | changelog-collector.ts:238-270,250; index.ts:330 | Dead-token retry loop → throw swallowed in cdc mode; `/cdc/health` (replayer-only) still green |
| CDC-N2 | Replayer applies all upserts then all deletes within a batch, ignoring seq | CORR | KNOWN | HIGH | CONFIRMED | changelog-replayer.ts:177-190,262-267 | delete→recreate in one batch leaves row deleted in PG though present in Mongo |
| CDC-N4/N5 | Failed / unknown-collection events dropped while cursor advances + changelog `deleteMany`'d | CORR | KNOWN | HIGH | CONFIRMED | changelog-replayer.ts:109,111,122,166,173,235-241,329-335 | Captured events lost permanently, no retry/dead-letter |
| CDC-N9 | Collector unsupervised in cdc mode (crash = log-only, no restart, no exit) | CORR | KNOWN | HIGH | CONFIRMED | index.ts:330-332,207-209 | Fatal collector throw never restarts the pod; replayer runs against a frozen changelog |
| EFF-1 | GridFS→S3 non-idempotent, no per-file checkpoint → OOM-restart livelock | CORR/OPS | KNOWN | HIGH | CONFIRMED | gridfs-to-s3.ts:116,169-301; index.ts:213-238 | Restart re-downloads from zero; runs parallel to bulk, failures swallowed (non-fatal) |
| EFF-2 | Part-2 vs Part-3 fileId keying mismatch → duplicate/orphan S3 objects | CORR | KNOWN | HIGH | CONFIRMED | gridfs-to-s3.ts:218,250-253,257 | `files.files._id` ≠ `storage.files.id` → re-upload under 2nd key + orphan PG row |
| EFF-4 | Four full `.toArray()` materializations | EFF/OPS | KNOWN | HIGH | CONFIRMED | gridfs-to-s3.ts:186,213,247,251 | O(all storage docs) resident; dominant OOM driver, compounds EFF-1 |
| EFF-11 | `_data->>'_id'` partial index built before bulk load → indexed inserts | EFF | KNOWN | MEDIUM | CONFIRMED | init-pg.ts:110,121-154; index.ts:65 | Write-amplification across the whole bulk load; the index only serves the CDC-delete path |
| EFF-14 | 32Gi limit / 1Gi request + liveness/readiness disabled | OPS | KNOWN | HIGH | CONFIRMED | medicard.yaml:538-544,549-553 | Pod balloons to 32Gi before OOM-kill (EFF-1/4 will); wedged process never restarted; risks evicting neighbors |
| SEC-1 | `POST /verify` + `POST /verify/:collection` = unauthenticated full-scan DoS lever | SEC | KNOWN | HIGH | CONFIRMED | server.ts:207-229,233; verify.ts:188,201 | 1 POST → O(rows) count-scan across every table + Mongo `$sample`; 409 guards concurrent only, per-collection route unguarded. In-cluster-only today (gateway off) |
| SEC-2 | Unauthenticated `POST /cdc/pause` / `/cdc/resume` | SEC | NEW | MEDIUM | CONFIRMED | server.ts:154-164 | Any in-cluster caller halts the replayer indefinitely (data-freshness DoS); survives the reverse-route purge |
| CDC-NEW-2 | `update`/`replace` with `fullDocument:null` logged "treating as delete" but never added to `deleteEvents` | CORR | NEW | MEDIUM | PLAUSIBLE | changelog-replayer.ts:202-211 | Doc deleted between change and updateLookup → PG row never removed; stated intent not implemented |
| CRYPTO-11 | `decrypt()` recurses arrays but **not** nested plain objects; `delete _eh` is top-level only | CORR | NEW | MEDIUM | PLAUSIBLE | encryption-core.ts:103-131,110,128-129 | A `$$enc$$` value nested in a sub-object is written to PG still ciphertext-prefixed, errors=0 |
| CDC-N1 | `clusterTime` decoded as ms → negative `lagMs` makes `/cdc/health` trivially green | CORR | KNOWN | MEDIUM | CONFIRMED | changelog-collector.ts:286-288; changelog-replayer.ts:391; server.ts:141 | The one stall-detecting metric is inverted/garbage; masks real lag |
| CDC-N3 | Deletes carry no latest-wins/seq guard | CORR | KNOWN | MEDIUM | CONFIRMED | cdc-delete.ts:81,103 | Stale delete after a legit recreate removes a row it shouldn't (upsert path has the guard; delete path doesn't) |
| CDC-N6 | Text-id delete misses rows lacking pre-image + `_data._id` (older-migrator rows) | CORR | KNOWN | MEDIUM | CONFIRMED | changelog-replayer.ts:309-317; cdc-delete.ts:80,102 | Silent no-op delete → PG orphan; compounds K1 |
| CDC-N7 | `saveMeta`/`insertOne` non-atomic → seq reuse → unique-index dup-key → reconnect churn | CORR | KNOWN | MEDIUM | CONFIRMED | changelog-collector.ts:281-299,140 | Crash-window replays reuse seq → E11000 → same silent-stop as K2 |
| CDC-N8 | cdc-metrics blind to collector silent-stop; dead collector reads as zero-lag | CORR | KNOWN | MEDIUM | CONFIRMED | cdc-metrics.ts; changelog-replayer.ts:380 | No heartbeat / lastEventAt-age / collector-running signal |
| CDC-NEW-1 | Better-Auth strict-schema delete has no `_data` fallback arm | CORR | NEW | MEDIUM | PLAUSIBLE | cdc-delete.ts:80,102; changelog-replayer.ts:314 | If PG id ≠ Mongo `_id` hex, single-arm DELETE silently no-ops; reconcile-orphans skips these tables |
| NEW-2 | `updateProgress` UPDATE has no monotonic guard (`WHERE last_id < $3`) | CORR | NEW | MEDIUM | PLAUSIBLE | checkpoint.ts:119-126 | Under CONT-5 races / double-resume, `last_id`/`processed` can regress; cheap defense even at replica 1 |
| NEW-4 | Phase failure doesn't abort later phases; then CONT-6 marks done | CORR | NEW | MEDIUM | CONFIRMED | coordinator.ts:73-153,143-152 | A failed early-phase parent doesn't stop dependent later-phase collections; masks referential gaps |
| TYPE-3 | Date→`timestamp` (tz-naive); `date` cols get datetimes | CORR | KNOWN | MEDIUM | CONFIRMED | pg-introspect.ts:29-32; transformer.ts:142-171 | tz-shift / day-boundary drift |
| TYPE-8 | boolean coercion → NULL for anything outside a tiny set | CORR | KNOWN | MEDIUM | CONFIRMED | transformer.ts:85-89 | Loose Mongo flags silently NULL |
| TYPE-11 | `integer`-case silently converts a Date to epoch-ms | CORR | NEW | MEDIUM | CONFIRMED | transformer.ts:68 | Date-valued field on an integer/bigint column stored as a 13-digit ms int (silent wrong semantics) |
| TYPE-6 | NUL byte (`\u0000`) / invalid-UTF-8 → row drop after halving cascade; JSONB-embedded NUL is the silent variant | CORR | KNOWN | MEDIUM | CONFIRMED | transformer.ts:51-60; batch.ts:196-266 | Row dropped (counted for text; the `_data` JSONB NUL leg is silent) |
| CRYPTO-5 | `_eh` hash couples to the hand-maintained `encryptedFields` list | CORR | KNOWN | MEDIUM | CONFIRMED | encryption-core.ts:25-32; encryption.ts:47; collections.ts | Field-list drift → correct key silently rejected, every doc dropped |
| CRYPTO-6 | Fixed-IV deterministic scheme (decrypt-side preserves legacy equality-leak) | CORR | KNOWN | MEDIUM | CONFIRMED | encryption-core.ts:80-84,115-121 | Equality leak property of the ciphertext; also underpins now-dead encrypt path |
| CRYPTO-9 | AES key can leak to logs via `JSON.stringify(config)` throw | SEC | KNOWN | MEDIUM | CONFIRMED | encryption-core.ts:107 (live), :71 (now dead); worker.ts:234 | Raw HEXKEY-HEXIV reaches the log stream |
| EFF-6 | No prepared statements; unique SQL text per batch → plan-cache miss | EFF | KNOWN | MEDIUM | CONFIRMED | batch.ts:173,327 | PG re-parses+re-plans every batch |
| EFF-7 | Halving fallback re-serializes whole batch each level → O(N log N) | EFF | KNOWN | MEDIUM | CONFIRMED | batch.ts:196-204,157-169 | Re-JSON.stringify per recursion level |
| CRYPTO-10 | Dead encrypt surface after reverse removal (`encrypt`/`encryptDocument`/`encryptMatchValue` uncalled) | SEC | NEW | LOW | CONFIRMED | encryption.ts:146,159; encryption-core.ts:67,71 | Keeps the fixed-IV/no-MAC/key-leaking primitive resident + exported; delete or gate |
| TYPE-10 | Mixed-type JSONB: Long stringified `number` if ≤int32 else `string` | CORR | KNOWN | LOW-MED | CONFIRMED | transformer.ts:183-190,297-318 | Same field type-unstable across docs in `_data` |
| CDC-NEW-3 | Cross-batch upsert/delete ordering unbounded (extends N2 beyond one batch) | CORR | NEW | MEDIUM | PLAUSIBLE | changelog-replayer.ts:104-106 | No global seq-ordered apply; insert(batch K)→delete(batch K+1) + intra-batch reorder |
| EFF-9 | pool `max:20` vs `collectionConcurrency:1` → ~18 idle conns | EFF/OPS | KNOWN | LOW-MED | CONFIRMED | index.ts:55; medicard.yaml:558 | Wastes Azure PG connection budget (shared w/ hapihub + cadence) |
| EFF-13 | Dockerfile `ubuntu:22.04` for one static Bun binary | OPS | KNOWN | LOW-MED | CONFIRMED | Dockerfile:2,19,22,34 | Oversized image; `wget` only for a HEALTHCHECK k8s ignores |
| SEC-3 | Dashboard `esc()` doesn't escape single-quote; applied inconsistently | SEC | NEW | LOW | UNCERTAIN | server.ts:844,828 | Latent stored-XSS in attribute context (all current interpolations use `"`, so not presently exploitable) |
| CRYPTO-12 | Empty/prefix-less field passes decrypt unchanged, no signal | CORR | NEW | LOW | PLAUSIBLE | encryption-core.ts:112 | No layer asserts a should-be-encrypted field actually decrypted |
| TYPE-7 | NaN/Inf pass through `real`; `Math.round(NaN)` on integer | CORR | KNOWN | LOW-MED | PLAUSIBLE | transformer.ts:77,63 | Corrupts aggregates / loud int errors |
| EFF-15 | `estimateBatchBytes` under-samples giant-blob batches; `.length*2` wrong direction | EFF | NEW | LOW | PLAUSIBLE | batch.ts:343-367,70 | Proactive split skipped for the exact case it guards → reactive RangeError path |
| GFS-1 | Part-2 records `size: buffer.length`, no assert vs stored size | CORR | NEW | LOW | PLAUSIBLE | gridfs-to-s3.ts:234 | Truncated download records wrong size; EFF-12 never repairs it |
| GFS-2 | `ensureBucket` treats HTTP 400 as "bucket absent" | OPS | NEW | LOW | PLAUSIBLE | gridfs-to-s3.ts:82 | Masks auth/malformed-request errors as missing-bucket |
| EFF-12 | GridFS upsert ON CONFLICT updates only 3 columns | CORR | KNOWN | LOW | CONFIRMED | gridfs-to-s3.ts:140-143 | filename/size/content_type/owner never re-corrected on rerun |
| NEW-3 | `totalEstimate` uses collection-wide `estimatedDocumentCount`, ignores resume offset/`_cd` window | EFF | NEW | LOW | CONFIRMED | worker.ts:71,194-195 | Misleading progress %/denominator on resume; reporting only |
| OPS-1/2/3 | Dead Dockerfile HEALTHCHECK; storage pipeline unthrottled by `collectionConcurrency`; timestamp filter disabled → full-history bulk | OPS | NEW | LOW/INFO | CONFIRMED | Dockerfile:34; index.ts:213; medicard.yaml:561-563 | Misleading health directive; storage buffers + worker batch concurrent (interacts w/ EFF-14); unbounded `.find()` amplifies memory |

---

## Continuation-run verdict (unchanged by mode removal)

A converging bulk run is **not safe as-is** — for the same reasons as review #1, now re-confirmed at current line numbers:
1. **Resumes the wrong run** (CONT-1 recency-ranked election × CONT-2 run-scoped completed-skip × CONT-7 unreaped `in_progress`). A **fresh RUN_ID** is the only safe re-sync; resuming skips completed collections and migrates zero deltas.
2. **NEW-1:** even a fresh run's `bulkCutoffDate` drifts forward on each restart (no persisted cutoff on the RUN_ID-unset path) — pin `BULK_CUTOFF_DATE` for determinism.
3. **Deletes never reconciled** (CDC-K1) and `reconcile-orphans.ts` is manual-only, hard-delete-only, Better-Auth-excluded.
4. **Source still staging** — the pod crashlooped on `mycure-stg-sh` (staging Atlas). Correct the source + verify reachability first. **[queued]**
5. **TYPE-5** silent-drop must be fixed before a converging run, else it quietly loses fields/rows under the guard.

---

## Sample-issue disposition (carried from review #1 — unchanged)

#2309 RELATED (non-convergence + timestamp collapse) · #2092 RELATED (incomplete/failed billing collection) · #2104 LIKELY-UNRELATED (hapihub app query perf) · #2301 UNCLEAR (Maestro/Syncbase vs migrator) · #2101 UNCLEAR (queue repopulation ~ delete-orphans K1/N6, or FE filter) · #2109 RELATED-ops. Each data-dependent confirmation is in the queued checks.

---

## Checks queued for approval (read-only; classifier-blocked)

All read-only; the psql ones need an approval-gated ephemeral pod (namespace `medicard` PodSecurity `restricted`).
1. `SELECT run_id, status, count(*) FROM _migration_checkpoints GROUP BY 1,2 ORDER BY 1,2;` — confirm the 37-run thrash + which run auto-resume elects (CONT-1/2/7).
2. Live pod state/logs — confirm crashloop + `mycure-stg-sh` DNS failure (source-environment).
3. Which collections `failed` in the latest run + why (#2092).
4. medical-records perpetual `in_progress` cause (CONT-7).
5. Delete-orphan magnitude — anti-join PG `id` vs Mongo `_id` per collection (K1/N6; #2101).
6. Type-corruption incidence — sample money (Decimal128→null/float), bigint (Long>2^53), timestamp values PG vs Mongo (TYPE-1/2/3/5; #2309).
7. Is `mycure-stg-sh` the intended source; does target PG already hold staging-derived rows.
8. At-rest PII — sample a personal-details / medical-records PG row: cleartext or ciphertext? (CRYPTO-1).

---

## Modules swept clean

- **audit.ts** — enum reduced correctly; parameterized insert; best-effort by design.
- **cdc-metrics.ts** — correct accumulator; the defect is what it omits (CDC-N8/N1), not its logic.
- **config.ts** — CDC block forward-only; 5 `ENC_*` parsed and not logged; `PG_ENCRYPTION_KEY` correctly absent (that's CRYPTO-1, chart-side).
- **pg-retry.ts** — statement-boundary retry, correct SQLSTATE set, capped backoff.
- **pg-introspect.ts** — parameterized information_schema; PK from constraint metadata; table names from trusted defs (no injection). (Its 6-bucket `pgTypeToSimple` is the *upstream* cause of TYPE-1/2/3, not a bug in this file.)
- **buildConflictClause** (batch.ts:116-133) — latest-wins `<=` tie logic correct (#2063).
- **schema-reader.ts** — Better-Auth manual schemas consistent; largely superseded by pg-introspect at runtime.
- **collections.ts** — registry only; dead `TABLE_MAP` export removed this pass; `MONGO_METADATA_FIELDS` correct.
- **verify.ts / verify-store.ts** — read-only; parameterized; the correct decrypt try/catch pattern (verify.ts:225-229) that worker.ts:279 lacks.
- **networkpolicy.yaml / httproute.yaml / externalsecret.yaml** — ingress gateway-scoped, HTTPRoute gated off, ESO secrets map 1:1. (App-layer auth gap is SEC-1/2, not a policy defect.)
- **startServer / reverse-route removal** — signature and call sites consistent; no dangling refs.

---

## Delta vs review #1 (what this pass adds)
- **Resolved:** MODE-1/2/4/5 (reverse write-back, unauth DDL, unauth PII read, overflow injection) — removed with the modes.
- **New:** NEW-1 (cutoff drift on resume), NEW-2 (no monotonic progress guard), NEW-4 (phase failure doesn't abort), TYPE-11 (Date→epoch-ms on int cols), CRYPTO-2 refinement (worker decrypt uncaught → collection-kill), CRYPTO-10 (dead encrypt surface), CRYPTO-11 (nested `$$enc$$` written as ciphertext), CDC-NEW-1 (Better-Auth delete no fallback), CDC-NEW-2 (fullDocument:null "treated as delete" but skipped), CDC-NEW-3 (cross-batch ordering), CDC-N1 refinement (negative lagMs → health green), SEC-2 (unauth /cdc/pause|resume), SEC-3 (esc single-quote), plus GridFS/OPS minors.

_Stop condition: full forward-path SCOPE covered; data-axis validation pending the queued checks (classifier-blocked). No new finding above LOW surfaced on a second sweep of the low-severity tail._
