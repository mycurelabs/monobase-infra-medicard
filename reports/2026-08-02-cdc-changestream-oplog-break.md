# 2026-08-02 — CDC Mongo→PG forward-sync down (change-stream oplog window exceeded)

**Affected system:** `hapihub-migrator-cdc` (MongoDB → PostgreSQL live forward-sync / Change Data Capture)
**Environment:** medicard production AKS cluster `aks-mpi-sea-p-mycurex01`, namespace `medicard`
**MongoDB source:** Atlas cluster `mycure-stg-sh.q4trx.mongodb.net` (db `medicard-production`)
**PG target:** Azure PostgreSQL (`mpiazeppgdb0003`)
**Severity:** High — pre-cutover forward-sync halted; PG target is diverging from the source
**Status:** DRAFT / Active — CDC down since 2026-07-30; recovery blocked 2026-08-02 by bastion (kubectl jumphost) outage
**Detection:** 2026-08-02, during a requested verification of MediCard's claim that the source Mongo was re-synced with their live prod Mongo

> Draft for incident submission. Times are UTC. The "Recovery-access retry log" section is machine-appended from `/tmp/medicard/bastion-watch.log` and will be folded in once access is restored.

---

## Summary

The live Change Data Capture (CDC) pipeline that mirrors the source MongoDB into the new PostgreSQL backend has been in `CrashLoopBackOff` since **2026-07-30 07:20 UTC** (~515 restarts as of detection). Each start dies with a MongoDB `ChangeStreamFatalError` (code 280) — the CDC's saved change-stream **resume token is no longer in the source oplog** ("oplog window exceeded"). The collector is designed to fail loud rather than silently skip data, so it exits and Kubernetes restarts it into the same failure.

Root cause: a large burst of writes on the source Atlas cluster (`mycure-stg-sh`) — consistent with MediCard re-syncing the source from their live production Mongo — rolled the source oplog past the position the CDC had last checkpointed. Because CDC had processed almost nothing before this (`lastSeq=11`), the token aged out and cannot be resumed.

Consequence: **no data has flowed Mongo→PG since ~2026-07-30**, and the freshly re-synced source data is not reflected in the PG target. CDC cannot self-recover; a bulk re-migrate + fresh CDC start is required.

A secondary issue was found during triage: the CDC pod is now *also* rejected by a Kyverno pod-security policy (`require-run-as-non-root`), so even a code-healthy pod would not schedule until its `securityContext.runAsNonRoot=true` is set.

Recovery (approved) is currently **blocked** because the sole kubectl path to the private-link prod cluster — the bastion VM `mc.remote.prd.bastion` (`172.23.4.8`, `SEA-VM-STG-MYCURE-WEB`) — went unreachable on 2026-08-02 (~00:5x UTC), mid-triage.

---

## Impact

- **Forward-sync halted.** The PG target has received no source changes since ~2026-07-30 07:20 UTC. Any patient/encounter/billing writes that reached the source after that are absent from PG.
- **Silent divergence.** The migration dashboard (`hapihub-migrator-dashboard`) stays Healthy and continues serving from PG; the outage is only visible in the CDC pod state/logs. There was no alert.
- **No data loss at source.** The source Mongo and MediCard's live prod Mongo are intact; this is a *propagation* outage, not corruption. The gap is recoverable by re-reading the source.
- **Cutover risk.** Any go-live that assumes PG is a live mirror of Mongo would ship stale/partial data until the pipeline is repaired and reconciled.

---

## Timeline (UTC)

| Time | Event |
|---|---|
| 2026-07-28 | CDC forward-sync (`hapihub-migrator-cdc`, change-stream → PG) deployed and running; change stream opened `resumeFrom: now`. |
| 2026-07-30 07:20:12 | Current CDC pod (`hapihub-migrator-cdc-55ff4fc8fd-s9vsm`) starts (image roll to 3.12.7). From here it cannot resume — saved resume token already dead. Enters CrashLoopBackOff. |
| 2026-07-30 → 08-02 | ~515 restarts, each dying with `ChangeStreamFatalError` code 280 (resume token not found / oplog window exceeded). `eventsCollected: 0` per attempt. |
| ~2026-07-27 → 08-02 | MediCard re-syncs the source Atlas cluster (`mycure-stg-sh`) from their live prod (`mycure`). Source is a near-mirror of prod (within ~0.2%). This write burst is what rolled the source oplog past the CDC checkpoint. |
| 2026-08-02 ~00:40 | Triage confirms RCA: change-stream resume token dead; CDC also blocked by Kyverno `require-run-as-non-root`. |
| 2026-08-02 00:58:37 | Recovery blocked: bastion kubectl jumphost `mc.remote.prd.bastion` (172.23.4.8) unreachable — 100% ICMP loss + TCP/22 timeout from the gateway. Gateway and legacy `mc.remote.prd.api` remain up. Retry watcher started. |

---

## Root cause

CDC reads the source via a **MongoDB change stream** (`db.watch(...)`, `services/hapihub-migrator/src/changelog-collector.ts`), buffering events to PG `_migration_changelog` and replaying them to the PG target. A change stream is a managed view over the replica-set **oplog**; its resume token is an oplog position and is bounded by oplog retention.

The collector had checkpointed only `lastSeq=11` (very little live traffic 07-28→07-30). When the source received the large re-sync burst, the oplog advanced past the checkpointed token before CDC consumed it. On the next restart the stream reopened with `resumeAfter: <dead token>` → `ChangeStreamFatalError` code 280. Per design (`changelog-collector.ts:314-325`) the collector fails loud and exits rather than skipping the gap — correct behaviour, but it needs operator action.

Contributing factors:
- **No CDC-health alerting** — the crashloop ran ~2.7 days unnoticed until an unrelated verification.
- **Kyverno `require-run-as-non-root`** now also blocks the imperative CDC deployment (its container security context lacks `runAsNonRoot: true`).
- **Source sync model** (MediCard-side, out of our control here): a periodic bulk re-sync into the source is inherently oplog-window-hostile if CDC is down or lags, or if it drops/recreates collections.

---

## Evidence

CDC pod log (repeats every restart):
```
component=collector resumeFrom=token collections=85 msg="Change stream opened"
component=collector code=280 codeName=ChangeStreamFatalError
  err="cannot resume stream; the resume token was not found. {_data: 826A6C6457...}"
  msg="Change stream history lost / invalidated — resume token is dead. Manual re-sync required (oplog window exceeded)..."
component=collector msg="CDC collector died — exiting for restart"
```
Pod: `hapihub-migrator-cdc-55ff4fc8fd-s9vsm`, restarts 515, startTime 2026-07-30T07:20:12Z.
Kyverno event: `policy require-run-as-non-root fail ... Pod must set securityContext.runAsNonRoot=true`.

Baseline counts 2026-08-02 (Mongo) — SOURCE (`mycure-stg-sh`) vs PROD (`mycure`, live):

| Collection | PROD (live) | SOURCE | Δ prod−source |
|---|--:|--:|--:|
| personal-details | 5,513,410 | 5,510,154 | 3,256 |
| medical-records | 31,815,417 | 31,757,539 | 57,878 |
| medical-encounters | 3,113,990 | 3,107,836 | 6,154 |
| billing-invoices | 3,126,575 | 3,120,403 | 6,172 |
| queue-items | 8,011,101 | 7,992,684 | 18,417 |
| accounts | 3,021 | 3,019 | 2 |
| organizations | 23,506 | 23,498 | 8 |

(PG-target counts pending bastion access — the source-vs-PG delta is the actual gap the recovery closes.)

---

## Recovery plan (approved; pending cluster access)

1. **Baseline** source-vs-PG per-collection counts (the real gap).
2. Scale `hapihub-migrator-cdc` to 0.
3. Reset the dead resume token: clear the `_migration_changelog` meta row (safe — `lastSeq=11`, `maxChangelogSeq=0`, nothing meaningful buffered) so a fresh collector opens `resumeFrom: now`.
4. **Bulk re-migrate** with `START_COLLECTOR_IN_BULK=true` (no-gap handoff: the collector opens a fresh change stream at `now` and buffers *before* the bulk snapshot reads). Bulk is idempotent (`conflictAction=update`, `_id` preserved 1:1). Trigger from the suspended CronJob: `kubectl create job --from=cronjob/hapihub-migrator ...`.
5. After bulk converges, **restart CDC** (scale up) — it resumes from the token saved during bulk. Set `securityContext.runAsNonRoot=true` on the CDC deployment so it passes Kyverno.
6. Reconcile counts against the baseline; confirm convergence.

---

## Recovery execution (2026-08-02 → 08-03, after bastion recovery)

Baseline captured before any change — SOURCE (`mycure-stg-sh`) vs PG target (estimates; accounts/orgs exact). The gap is what CDC failed to carry since 07-30 (~1.5M rows):

| Collection → PG table | SOURCE | PG target | gap |
|---|--:|--:|--:|
| personal-details → personal_details | 5,510,154 | 5,444,556 | ~65,598 |
| medical-records → medical_records | 31,757,539 | 30,844,424 | ~913,115 |
| medical-encounters → medical_encounters | 3,107,836 | 3,001,019 | ~106,817 |
| billing-invoices → billing_legacy_invoices | 3,120,403 | 3,023,156 | ~97,247 |
| queue-items → queue_items | 7,992,684 | 7,700,816 | ~291,868 |
| accounts → accounts | 3,019 | 2,936 | 83 |
| organizations → organizations | 23,498 | 23,393 | 105 |

Steps executed:
1. **CDC stopped** — `kubectl -n medicard scale deploy hapihub-migrator-cdc --replicas=0` (halts the crashloop; was 780 restarts).
2. **Reset safety confirmed** — `_migration_changelog` had 0 buffered rows; `_migration_changelog_meta` held the dead collector token (last progress 2026-07-30 01:21 UTC, `last_seq=11`).
3. **Bulk heal** with `CONFLICT_ACTION=nothing` (backfill: insert-missing only, no rewrite/history bloat) + `SKIP_SCHEMA_INIT=true`, `RESUME_MIGRATION=true`, `BATCH_SIZE=500`, `COLLECTION_CONCURRENCY=1`. **Chosen over `CONFLICT_ACTION=update`** to avoid ~40M row rewrites + ~40M audit-history inserts + sustained prod-PG load; trade-off = edits to *already-migrated* rows during the outage window are not re-pulled.

### Backfill / heal run timings (UTC)

| Run (Job) | Scope | Start | End | Elapsed | Outcome |
|---|---|---|---|---|---|
| `hapihub-migrator-heal-20260803` | full (83 collections) | ~2026-08-03 00:15 | 2026-08-04 00:17:23 | ~24 h | **Failed** — source shard shutdown mid-read (`InterruptedAtShutdown`); **80/83 collections completed** before the failure |
| `hapihub-migrator-heal-20260804` | full resume | 2026-08-04 00:27:40 | 2026-08-04 00:49:02 | ~21 min | Failed on `accounts` convergence gate (pre-fix; benign dup-email shortfall) |
| `hapihub-migrator-heal-20260804b` | `activity-logs` (targeted) | 2026-08-04 00:54:36 | ~2026-08-04 01:35 (killed) | ~40 min | Stalled on the pre-read convergence count (100M, unindexed `_cd`); killed |
| `hapihub-migrator-heal-20260804c` | `billing-invoice-agt` + `diagnostic-orders` | 2026-08-04 01:36:49 | 2026-08-04 01:40:41 | **3 min 52 s** | **Complete** — both re-verified (0 mismatched/missing) |
| `hapihub-migrator-heal-activitylogs` | `activity-logs` (with count-bound fix) | 2026-08-04 03:07:58 | in progress | — | Reading (paginated); ~100.2M rows, hours-scale |

Notable per-collection timings (run `…804c`, verify phase): `billing-invoice-agt` verify 1.8 s, `diagnostic-orders` verify 4.8 s. Start times before 2026-08-03 for run 1 are approximate (the Job was garbage-collected; derived from the ~24 h duration and the 00:17:23 Z failure). All other timestamps are exact (Job `status.startTime`/`completionTime` or the retry-watcher log).

**Net result:** 82 of 83 collections migrated and verified; `activity-logs` (the 100M audit log) is being completed by the final run above. On completion: reset `_migration_changelog_meta` and (per the accepted snapshot model, [[2026-08-03-medicard-source-topology-snapshot-vs-live-cdc.md]]) leave CDC scaled to 0.

## Preventive actions (proposed)

- **Alert on CDC health**: page on `hapihub-migrator-cdc` not-Ready / restart-count growth / `/cdc/health` failing. This outage was invisible for ~2.7 days.
- **Fix the pod-security context** in the CDC deployment source so it isn't Kyverno-blocked.
- **Size the source oplog / retention** to exceed the largest expected re-sync burst plus CDC's worst-case downtime; or move the source to continuous low-latency replication (no periodic bulk reloads, no collection drops). *(MediCard-side; deferred by request.)*
- **Runbook**: document the "source re-synced → bulk + CDC restart" recovery as a standard operation.

---

## Recovery-access retry log (bastion `172.23.4.8`)

Machine-appended from `/tmp/medicard/bastion-watch.log` (probe: `ssh medicard.gateway "ssh mc.remote.prd.bastion hostname"`, every 120s). All attempts identical result — `connect to 172.23.4.8:22: Connection timed out` (gateway + `mc.remote.prd.api` up throughout).

| Window | Attempts | Result | First → Last (UTC) |
|---|--:|---|---|
| 1 | 1–30 | 30/30 DOWN | 2026-08-02T00:58:37Z → 02:04:45Z |
| 2 | 31–60 | 30/30 DOWN | 2026-08-02T02:06:xx Z → 03:13:42Z |
| 3 | 61–90 | 30/30 DOWN | 2026-08-02T03:15:xx Z → 04:22:14Z |
| 4 | 91–120 | 30/30 DOWN | 2026-08-02T04:24:xx Z → 05:30:50Z |
| 5 | 121–150 | 30/30 DOWN | 2026-08-02T05:33:xx Z → 06:39:17Z |
| 6 | 151–210 | 60/60 DOWN | 2026-08-02T06:41:xx Z → 08:56:04Z |
| 7 | 211–270 | 60/60 DOWN | 2026-08-02T08:58:xx Z → 11:12:43Z |
| 8 | 271–330 | 60/60 DOWN | 2026-08-02T11:15:xx Z → 13:29:28Z |
| 9 | 331–390 | 60/60 DOWN | 2026-08-02T13:31:xx Z → 15:46:06Z |
| 10 | 391–450 | 60/60 DOWN | 2026-08-02T15:48:xx Z → 18:02:43Z |
| 11 | 451–510 | 60/60 DOWN | 2026-08-02T18:04:xx Z → 20:19:28Z |
| 12 | 511–570 | 60/60 DOWN | 2026-08-02T20:21:xx Z → 22:36:15Z |
| 13 | 571–581 | 10 DOWN, **1 UP** | 2026-08-02T22:38:xx Z → **23:01:40Z UP** |

**RESOLVED: bastion reachable again at 2026-08-02T23:01:40Z (attempt 581).**
**Total bastion outage: ~22h03m** (2026-08-02T00:58:37Z → 23:01:40Z; 580 consecutive failed probes, then UP). Gateway and `mc.remote.prd.api` were reachable throughout — outage was isolated to the jumphost VM `SEA-VM-STG-MYCURE-WEB` (172.23.4.8). No config change on our side; the VM simply became reachable again. Full per-attempt log in `/tmp/medicard/bastion-watch.log`.

> Note: the CDC data-sync outage (the primary incident) remained active throughout and is unaffected by the bastion recovery — CDC restart count grew to 780. Recovery of the CDC pipeline proceeds now that cluster access is restored.
*(fold final duration into the Timeline on resolution.)*

---

## Environment

- **Workload:** `hapihub-migrator-cdc` (imperative Deployment, not GitOps-tracked), namespace `medicard`, cluster `aks-mpi-sea-p-mycurex01`
- **Companion:** `hapihub-migrator-dashboard` (MODE=dashboard, GitOps-managed) — Healthy throughout
- **Source Mongo:** `mycure-stg-sh.q4trx.mongodb.net` / `medicard-production` (secret `hapihub-migration-secrets` key `mongo-source-uri`)
- **Live prod Mongo (reference):** `mycure.q4trx.mongodb.net` / `medicard-production`
- **PG target:** Azure PostgreSQL `mpiazeppgdb0003`
- **kubectl access:** private-link cluster; sole path is `mc.remote.prd.bastion` (172.23.4.8) via `medicard.gateway` (VPN required)
