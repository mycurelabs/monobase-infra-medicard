# hapihub-migrator — Adversarial Review Prompt

Paste into Claude Code (in the medicard/infra repo, with the mono checkout at
`~/Projects/mycure/mono`). Read-only against prod: DB/cluster reads and sampling
are permitted; writes and running the migrator are gated behind approval.

---

GOAL: surface the gaps and inefficiencies nobody has reported yet. NEW findings are the deliverable. The sample issues are calibration only — a review that just re-confirms them has FAILED, and some of them may have nothing to do with the migrator at all.

Adversarially review the hapihub-migrator service on two axes — CORRECTNESS (what breaks or loses data) and EFFICIENCY (what wastes time, memory, connections, money). Assume it's guilty until proven correct and slow until proven fast. Do NOT summarize what it does.

CRITICAL CONTEXT — VERIFIED LIVE STATE (2026-07-15, via prod bastion, READ-ONLY). This supersedes the old "clean continuation over a completed Feb dataset" premise:
- The migration has NEVER completed. ~37 fragmented runs (Feb→Apr 2026); 127 tables total; best single run = 85 completed. `_migration_checkpoints` holds 1,201 rows across those runs. The PG dataset is a temporally-incoherent patchwork — different collections last migrated by different runs at different dates (Feb–Apr), none reflecting current Mongo.
- The pod is LIVE (deployment enabled at commit 3bdf67f — NOT replicaCount:0) and CRASHLOOPING: it connects to PG, applies drizzle migrations, then dies with `DNSException: querySrv ETIMEOUT _mongodb._tcp.mycure-stg-sh.q4trx.mongodb.net`. TWO problems: (i) the prod migrator's Mongo source is a STAGING Atlas cluster (`mycure-stg-sh`), (ii) it can't resolve/reach it → zero forward progress today.
- With RESUME_MIGRATION=true and RUN_ID unset, `findLatestInProgressRunId` auto-resumes `run-1775438668703` (~Apr 6; 30 completed, `medical-records` stuck in_progress) — IGNORING newer, more-complete runs (`run-1775610933162` = 85 completed) because those have no in_progress/pending row to qualify. So the "continuation" resumes a stale, sub-optimal run and drops ~3 months of Mongo deltas on those 30 collections.
- Weight the review on THIS reality: non-convergence, source-environment correctness (staging vs prod Mongo), and delete reconciliation — NOT on "will a clean re-run dup rows" (it won't; upserts are idempotent).

WHAT IT ACTUALLY IS (verify, then go deeper):
- A Bun + TypeScript long-running HTTP service (Hono, drizzle-orm, pg, mongodb driver), shipped as a compiled binary. Not a one-shot script.
- Medicard uses ONLY the one-way Mongo→PG path (bulk + cdc modes in src/config.ts).
- Cursors (worker.ts), param/byte-limit-aware batching with fallbacks (batch.ts), and pg connection pooling ALREADY EXIST and are hardened. AUDIT them — do not propose adding them. Bulk inserts are intentionally non-transactional (per-statement implicit txn, pg-retry.ts); treat as design intent unless you can show a real defect.

SCOPE:
- Code (read-only): ~/Projects/mycure/mono/services/hapihub-migrator — read src/ (collections.ts, transformer.ts, schema-reader.ts, worker.ts, checkpoint.ts, coordinator.ts, batch.ts, config.ts, server.ts, index.ts, pg-retry.ts, gridfs-to-s3.ts, the cdc modules changelog-collector.ts / changelog-replayer.ts / cdc-delete.ts, and the crypto pair encryption.ts / encryption-core.ts), tests/, Dockerfile. checkpoint.ts + coordinator.ts govern the #1 continuation priority (below) — do not skip them.
- Live DATA sampling is ALLOWED and encouraged (READ-ONLY): sample the Mongo source and the PG target to verify findings against real runtime artifacts — row/doc counts per collection, presence of the Feb migration's rows, field-type variance, encrypted-looking values, dup/PK state, checkpoint/resume markers. NEVER write, insert, update, delete, or run the migrator. If a check needs a write, queue it for approval instead.
- Runtime config: the migrator pod is LIVE but crashlooping (see VERIFIED LIVE STATE) — reading its live env/logs may be classifier-gated (they echo connection strings), so filter to progress lines (`grep` for msg/runId/collection/status). Resource limits/env come from the Helm chart at ~/Projects/medicard/infra/charts/hapihub-migrator/ (values.yaml, templates/deployment.yaml) and the medicard override at ~/Projects/medicard/infra/values/deployments/medicard.yaml (MODE=bulk, RESUME_MIGRATION=true, RUN_ID unset, EXIT_ON_BULK_END=true, replicaCount:1, mem req 1Gi / limit 32Gi, batchSize 500).
- DB ACCESS (read-only sampling): the migrator runs in medicard PROD AKS — cluster `aks-mpi-sea-p-mycurex01`, Azure Private Link, laptop-unreachable. Prod kubectl runs bastion-only via a two-hop: `ssh medicard.gateway "ssh mc.remote.prd.bastion 'kubectl -n <ns> ...'"` (context is preconfigured on the bastion — do NOT pass --kubeconfig/--context; prod is read-only by default). Follow the repo `kubectl-access` skill (Prod section) + global `medicard-infra-access` skill; do NOT use the mycure-data-investigation recipe (that targets a different cluster). Target PG is `mpiazeppgdb0003` (chart values.yaml → `hapihub-migration-secrets`/pg-target-uri). Checkpoint sanity query: `SELECT run_id, status, count(*) FROM _migration_checkpoints GROUP BY 1,2 ORDER BY 1,2;` — shows the 37-run thrash and which run auto-resume will pick. To query the external PG read-only WITHOUT printing credentials, run an ephemeral psql pod that injects the URI by `secretKeyRef` (namespace `medicard` enforces PodSecurity `restricted`, so the container MUST set runAsNonRoot=true + runAsUser≥1000 + capabilities.drop=[ALL] + seccompProfile RuntimeDefault; admission is Gatekeeper=dryrun + Kyverno=audit, non-blocking): `kubectl run pgcheck -n medicard --restart=Never --image=postgres:16-alpine -i --rm --overrides='{... secretKeyRef hapihub-migration-secrets/pg-target-uri, HOME=/tmp ...}'`. Secret keys: `mongo-source-uri, pg-target-uri, pg-encryption-key, enc-{billing-invoices,billing-items,billing-payments,medical-records,personal-details}`. Creating a pod on prod is approval-gated — queue it; a read-only SELECT via such a pod is safe once approved.
- Sample issues (fetch, read ONLY to calibrate — DO NOT force a migration link; several may be unrelated frontend/backend bugs):
  https://github.com/mycurelabs/monobase-mycure/issues/2309
  https://github.com/mycurelabs/monobase-mycure/issues/2301
  https://github.com/mycurelabs/monobase-mycure/issues/2109
  https://github.com/mycurelabs/monobase-mycure/issues/2104
  https://github.com/mycurelabs/monobase-mycure/issues/2101
  https://github.com/mycurelabs/monobase-mycure/issues/2092

VERIFIED BASELINE — already CONFIRMED (do NOT re-report these as new findings; VALIDATE with fresh sampled data, QUANTIFY blast radius, and hunt what lies BEYOND them — that is where the NEW value is):
CORRECTNESS (CRITICAL, CONFIRMED):
- Stale-resume non-determinism: `findLatestInProgressRunId` selects the latest run with an in_progress row, not the most-complete/most-recent run → resumes run-1775438668703 (30/127) over run-1775610933162 (85/127); skipped `completed` collections get zero deltas. (index.ts:104-113, checkpoint.ts:54-68)
- Deletes never reconciled: bulk only upserts; cdc-delete.ts is CDC-only; the change stream is forward-only from collector start. Pre-collector Mongo deletes = permanent orphan PG rows; no diff/reap pass anywhere. (worker.ts, cdc-delete.ts, changelog-collector.ts)
- Type corruption from a 6-type coercion vocab narrower than the real DDL: money as float8 (Decimal128→NULL); bigint columns mislabeled `integer` (Long>2^53 truncation, no range guard); no NUL-byte/invalid-UTF-8 handling (silent per-row drops); Date→timestamp not timestamptz (tz drift). (transformer.ts, schema-map.generated.ts, batch.ts:196-223)
- Crypto: CBC decrypt has no MAC check → corrupted ciphertext becomes garbage plaintext with errors=0; wrong-key skips a WHOLE collection with errors:0 (invisible to maxErrorRate/failedCollections). (encryption-core.ts:103-131, worker.ts:81-96)
- CDC: oplog-retention exhaustion undetected (no ChangeStreamHistoryLost branch → dead-token retry loop → silent stop); snapshot/stream handoff gap (wall-clock cutoff stamped before the stream opens → lost cutover writes). (changelog-collector.ts:238-270, index.ts:428-447)
EFFICIENCY / OPS (CONFIRMED):
- gridfs-to-s3 whole-collection `.toArray()` + full-file buffering → OOM (forces the 32Gi limit), non-idempotent re-upload, no checkpoint, silent non-fatal failure. (gridfs-to-s3.ts, index.ts:441-444)
- INSERT not COPY; no prepared-statement reuse; indexes live during load. (batch.ts, init-pg.ts)
- HTTP server fully unauthenticated (server.ts); reverse-* modes write back to Mongo, inert today only by mode-gating + gateway.enabled:false + NetworkPolicy. Mode verdicts: reverse-cdc REMOVE, reverse-bulk REMOVE, correct-overflow KEEP(low)/REMOVE, verify KEEP.

OPEN QUESTIONS — where NEW findings should come from this run:
- Is `mycure-stg-sh` (staging Atlas) the INTENDED prod Mongo source or a misconfiguration? What should prod point at, and does the target PG already hold staging-derived data? (chart/values/secret `mongo-source-uri`)
- The 13 `failed` collections in the latest run (run-1775615785047) — which are they and why did they fail?
- `medical-records` is the perpetual in_progress straggler across runs — why does it never complete (size? encryption? cursor timeout? memory)?
- Actual delete-orphan magnitude and real type-corruption incidence — sample prod rows (anti-join PG id vs Mongo _id per collection; inspect money/bigint/timestamp values).
- Files not yet deeply traced: audit.ts, synclog.ts, pg-introspect.ts, pg-trigger-manager.ts, init-pg.ts, migrations-bundle.ts, cdc-metrics.ts, verify-store.ts, coordinator.ts error paths, schema-reader.ts edge cases.

METHOD:
1. For every path ask "what input, state, ordering, or timing did the author NOT consider?" and "what does this cost at 10x current volume?" Ground 10x in the real current counts you sampled.
2. CONTINUATION / RE-RUN (highest priority): writes are idempotent upserts (`ON CONFLICT DO UPDATE`, batch.ts:2,116-135) — do NOT re-litigate dup-row / PK-violation risk; it is handled. Center the two real gaps instead: (a) DELETES — a doc deleted in Mongo since Feb leaves an orphaned PG row that a full re-scan + upsert can never remove; is there ANY reconciliation / CDC-delete pass, or is this a silent permanent gap? (b) runId semantics — a FRESH runId re-scans every collection and re-upserts current Mongo state (a safe full re-sync that catches all inserts/updates since Feb), but the completed-skip (worker.ts:104 fires on status='completed', and getCheckpoint is scoped `WHERE run_id = $1` — checkpoint.ts:88) means RESUMING Feb's runId skips every collection and migrates ZERO deltas silently. Determine which a continuation actually uses, whether Feb's checkpoint is still present and in what status (_migration_checkpoints), and note the latest-wins `updatedAt` guard (batch.ts) that can leave a row unchanged. Verify against sampled PG+Mongo state.
3. CORRECTNESS — Mongo→PG mapping (silent-corruption class): per-document FIELD-TYPE VARIANCE; numeric precision loss (Decimal128/Long>2^53 -> float/bigint, money -> NUMERIC not float?); timezone (UTC Date -> timestamp vs timestamptz); enum/bool coercion from loose typing; NUL-byte ( ) and invalid-UTF-8 strings PG text rejects; ObjectId->UUID/string mapping consistency & collision; nested/embedded doc & array flattening — data loss vs JSONB, recursive/tree structures; at-scale identifier map held in memory that won't fit.
4. CORRECTNESS — ENCRYPTION/DECRYPTION: determine whether the migrator encrypts/decrypts field data across the boundary. If it does — where are keys sourced (env/chart/secret)?; decrypt-before-insert or ciphertext migrated as-is?; deterministic vs randomized encryption (randomized breaks unique indexes/dedup; deterministic leaks equality); IV/nonce handling; what happens on a DECRYPT FAILURE (throw / silent skip / write garbage or ciphertext into PG — silent corruption); does it re-encrypt for PG or leave plaintext at rest?; any PII/plaintext leaked into logs on error? If there is NO crypto handling, state that and assess whether there SHOULD be (healthcare PII at rest in PG).
5. CORRECTNESS — CDC path: snapshot->streaming HANDOFF (changes during the snapshot window landing at snapshot value, not final — counts match, values disagree); resume-token / oplog handling (resume vs restart — does a restart drop changes captured while stopped?); LAG > OPLOG RETENTION (capped oplog purged before token consumed -> invalid token -> silent gap or forced full reload); checkpoint-vs-commit consistency; idempotency of replayed events (upsert keyed on PK?); concurrent source writes during cutover.
6. CORRECTNESS — general: duplicate/partial writes; ordering & FK/referential-integrity; unique-constraint/PK collisions across tenants; cross-tenant/cross-record data mixing; connection/TLS/timeout; silent error swallowing; crashloop/restart-mid-migration recovery; schema drift. GridFS→S3 (gridfs-to-s3.ts): re-run idempotency, orphaned/missing S3 objects, key collisions — a whole binary-data axis the rest of the review ignores.
7. EFFICIENCY: unbatched per-record work (N+1 / round-trips); INSERT where COPY would win; index/constraint live during bulk load vs drop-and-recreate; commit-batch sizing & WAL/lock pressure; prepared-statement reuse; unbounded in-memory accumulation / missing backpressure; in-memory ID maps that should spill to disk/KV; connection churn vs pooling; redundant recompute in loops; serial work that's trivially parallel; oversized k8s requests vs need (chart); needless full re-migration where continuation/delta would do.
8. MODE ASSESSMENT (separate deliverable): enumerate every mode in src/config.ts. For the non-forward modes (reverse-cdc, reverse-bulk, correct-overflow, verify): do they share/entangle code with the bulk+cdc forward path (shared collections.ts / schema-map / batch / pool)? Are they dead code for medicard? Can any be triggered ACCIDENTALLY (config default, HTTP route, env flag) and corrupt the forward migration (e.g. a reverse mode writing back to Mongo)? Recommend KEEP or REMOVE for each, with the risk if kept and the blast radius if removed.
9. Each finding: cite file:line (or chart line / sampled-data evidence). State the overlooked trigger (correctness) or cost driver + rough big-O/scaling (efficiency), and the user-facing/operational impact.
10. Tag each finding NEW or KNOWN(#issue). NEW leads.

Axis: CORRECTNESS | EFFICIENCY. Severity: CRITICAL (data loss/corruption/mixing) / HIGH / MEDIUM / LOW. Confidence: CONFIRMED (root cause cited) / PLAUSIBLE (what to check) / [uncertain].

RULES:
- Read-only: DB/cluster READS and sampling OK; NO writes, edits, mutations, or running the migrator. Queue any write/DB-mutating check for approval and keep sweeping — do not halt.
- Ground every claim in a file:line, a chart/config line, or sampled-data evidence; if truly unverifiable, mark [uncertain] — never speculate as fact.
- Diagnosis only, no fixes.
- Do NOT force a link between a sample issue and the migrator. If an issue looks like a frontend/backend/data bug unrelated to migration, say UNRELATED and move on.

STOP only when every file in SCOPE appears in either the Findings or the "Modules swept clean" section AND two consecutive passes surface no new finding above LOW on either axis. Two empty passes without full SCOPE coverage do NOT satisfy the stop condition.

OUTPUT (Markdown):
- Findings table (NEW before KNOWN, sorted Severity then Confidence): Finding | Axis | NEW/KNOWN | Severity | Confidence | Root cause (file:line / data) | Trigger / cost driver | Impact
- Per-finding detail: the code trace / sampled-data evidence and the adversarial (or scaling) reasoning
- Section: "Continuation-run verdict" — is a second bulk run safe as-is? what must change first?
- Section: "Mode assessment" — per non-forward mode: KEEP/REMOVE + reason
- Section: "Sample-issue disposition" — each of the 6: RELATED-to-finding / LIKELY-UNRELATED-to-migration / UNCLEAR (never invent a link)
- Section: "Checks queued for approval (writes/DB mutations)"
- Section: "Modules swept clean"
