# 2026-07-17 — PostgreSQL connection drop interrupts converging migration (medical-records ~70%)

**Affected system:** hapihub-migrator (MongoDB → PostgreSQL migration workload), converging bulk run
**Environment:** medicard production AKS cluster `aks-mpi-sea-p-mycurex01`, namespace `medicard`
**Migration target:** Azure PostgreSQL (`mpiazeppgdb0003`)
**Severity:** Medium — migration interrupted, no data loss
**Status:** Recovered — connectivity restored 2026-07-20; resume in progress
**Incident start:** 2026-07-17 ~17:03 UTC
**Occurrence:** 1st logged (target-PG connection drop during a migration run)

> Situation log for the connection drop that terminated the converging migration run and the co-occurring prod bastion / Private-Link access outage. Scope: the migration Job, its target PostgreSQL connection, and operator (bastion) access to the cluster.

---

## Issue

A **converging bulk migration** run (`RESUME_MIGRATION=false`, run id `run-1784263696274`, image `3.11.4`) was in progress, re-scanning all collections to close known gaps and migrating GridFS file bytes to S3/Blob. It ran for ~12 hours and had:

- completed **30 of 32** collections,
- migrated the full **GridFS** set (`storage_files` = 172,605),
- reached **21,625,000 of 30,844,222** rows (~70%) of the large `medical-records` collection,

when the target PostgreSQL connection dropped:

```
"collection":"medical-records" "processed":21625000 "msg":"Progress"
"err":"Connection terminated unexpectedly" "msg":"Batch insert failed — retrying with halved batch"
```

The migration Job runs with `backoffLimit: 0` (a deliberate design choice so a failed migration never silently retries), so the pod exited **non-zero (exit 1)** rather than restarting, and the run stopped at ~70% of `medical-records`.

Separately and in the same window, operator access to the cluster via the prod bastion / Azure Private Link (`172.23.4.8:22`) was **unreachable for 6+ hours** (SSH connection timeouts), consistent with a shared infrastructure network event rather than an application fault.

---

## Timeline (UTC)

| Time | Event |
|---|---|
| 2026-07-17 ~04:48 | Converging bulk run starts (cutoff `2026-07-17T04:48:16Z`); 30 collections + full GridFS migrate cleanly (0 errors). |
| 2026-07-17 (mid-run) | `medical-records` migrating; progress climbs past 21.6M / 30.8M rows. |
| 2026-07-17 17:03:01 | Target PG connection `terminated unexpectedly` during a `medical-records` batch insert; Job exits 1 (`backoffLimit: 0`, no retry). |
| 2026-07-17 → 07-20 | Prod bastion / Private-Link path (`172.23.4.8:22`) unreachable for 6+ hours; operator cluster access lost during that window. |
| 2026-07-20 ~12:05 | Bastion reachable again; cluster state re-confirmed; resume prepared. |

*(This table is the running log for this outage class. Further occurrences will be appended here.)*

---

## Observed state after the drop (confirmed 2026-07-20)

| Item | Observation |
|---|---|
| Migration Job `hapihub-migrator-converge` | `Failed` — pod `Error`, exit 1, `finishedAt=2026-07-17T17:03:01Z` |
| Checkpoints (`run-1784263696274`) | 30 `completed`, 1 `in_progress` (`medical-records`, last processed 21,625,000), 1 `failed` (`personal-details`) |
| `storage_files` (GridFS) | 172,605 — complete |
| `medical-records` | ~70% migrated; remainder (~9.2M rows) outstanding |
| Dashboard Deployment | `Running` — unaffected |

`personal-details` failed separately during this run (a schema-DDL timing artifact when a second migrator process ran concurrently, not a connection or key problem); it is retried by the isolated resume and is not caused by this connection drop.

---

## Impact

- **The converging run did not complete.** `medical-records` is ~70% migrated and `personal-details` is outstanding; the other 30 collections and all GridFS bytes are fully migrated.
- **No data loss and no corruption.** The migration is idempotent (latest-wins upserts) and checkpointed per collection with a last-processed `_id`. A resume continues `medical-records` from ~21.6M (not from scratch) and re-attempts `personal-details`; already-migrated rows are unaffected.
- **The workload did not self-recover** — by design (`backoffLimit: 0`), a failed migration Job does not auto-retry; it requires an operator-triggered resume.
- **Operator access was lost** for the duration of the bastion / Private-Link outage, delaying diagnosis and resume until connectivity returned.

---

## Root cause / assessment

- The direct trigger was a **target PostgreSQL connection termination** mid-run (`Connection terminated unexpectedly`). This is a target-side / network event (Azure PostgreSQL `mpiazeppgdb0003`), in the same class as prior Azure-PG availability events logged for this cluster (see the 2026-04 Azure PG read-only / crash-loop reports). The co-occurring multi-hour bastion / Private-Link outage points to a broader infrastructure network disruption in the window.
- The migration design behaved correctly: it failed loudly (non-zero exit), preserved all committed work, and left a resumable checkpoint. No application or data-model fault was involved.

---

## Status / next steps

- **Resuming** from checkpoint (`RESUME_MIGRATION=true`, isolated — no concurrent migrator Jobs): skips the 30 completed collections, continues `medical-records` from ~21.6M, and re-attempts `personal-details`.
- Acceptance gate after the resume: reconcile anti-join per collection to confirm `medical-records` and `personal-details` converge with no unexplained gaps.
- Recommended hardening (follow-ups, not blockers): resilience to transient target-PG connection drops (pool-level reconnect/retry across a connection loss so a multi-hour run survives a blip without a full restart); and confirm whether the Azure PG connection drop and the Private-Link/bastion outage share a root cause on the infrastructure side.

---

## Environment

- **Workload:** `hapihub-migrator`, namespace `medicard`, cluster `aks-mpi-sea-p-mycurex01`
- **Migration target:** Azure PostgreSQL (`mpiazeppgdb0003`)
- **Run:** `run-1784263696274`, image `ghcr.io/mycurelabs/hapihub-migrator:3.11.4`, `MODE=bulk`, `backoffLimit: 0`
- **Operator access path:** gateway → bastion `172.23.4.8` (Azure Private Link)
