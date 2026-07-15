# 2026-07-15 — MongoDB source unreachable, migration blocked (1st occurrence)

**Affected system:** hapihub-migrator (MongoDB → PostgreSQL migration workload)
**Environment:** medicard production AKS cluster `aks-mpi-sea-p-mycurex01`, namespace `medicard`
**MongoDB source:** Atlas cluster `mycure-stg-sh.q4trx.mongodb.net`
**Severity:** High — migration blocked
**Status:** Active — source unreachable as of 2026-07-15, migration stalled
**Incident start:** 2026-07-15
**Occurrence:** 1st logged

> Situation log for this outage. Scope: observations of the migration workload and its MongoDB source as seen from the cluster. This is the first logged occurrence; if the outage recurs, subsequent occurrences will be recorded against this report.

---

## Issue

The migration workload is unable to reach its MongoDB source. On startup the migrator attempts to connect to the Atlas endpoint, the connection attempt does not complete within the timeout, and the process exits. Kubernetes restarts the pod, the next attempt fails the same way, and the pod settles into `CrashLoopBackOff`.

While the source is unreachable, the migrator cannot read any documents, so the MongoDB → PostgreSQL migration makes no forward progress.

---

## Timeline

| Date | Event |
|---|---|
| 2026-07-15 | Migrator unable to connect to the MongoDB source; connection attempts time out; pod enters `CrashLoopBackOff`; migration stalls. (1st logged occurrence.) |

*(This table is the running log for this outage class. Further occurrences will be appended here.)*

---

## Observed state (2026-07-15)

| Item | Observation |
|---|---|
| Migrator pod | `CrashLoopBackOff` — restarts repeatedly |
| MongoDB source connection | Connection attempt on startup times out before completing |
| Migration progress | Halted — no documents read while the source is unreachable; resumes from its last checkpoint once connectivity returns |

> Live re-confirmation of the pod state is pending — production cluster access is restricted and read access is gated. The above reflects the state observed on 2026-07-15.

---

## Impact

- **Migration is stalled.** No data moves from MongoDB to PostgreSQL for as long as the source is unreachable.
- **The workload cannot self-recover.** Each pod restart re-attempts the same connection and fails again; the crash-restart loop continues until connectivity to the source returns.
- **No data loss from this event.** The migration is idempotent and resumes from its last checkpoint once the source is reachable again; the outage delays progress but does not corrupt already-migrated data.

---

## Status / next steps

- The root cause of the connection timeout is under investigation.
- The workload is being monitored for auto-recovery and for recurrence.
- If the outage recurs, each occurrence will be logged against this report so the pattern and frequency are tracked over time.

---

## Environment

- **Workload:** `hapihub-migrator`, namespace `medicard`, cluster `aks-mpi-sea-p-mycurex01`
- **MongoDB source endpoint:** `mycure-stg-sh.q4trx.mongodb.net`
- **Migration target:** Azure PostgreSQL (`mpiazeppgdb0003`)
