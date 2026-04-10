# 2026-04-10 — Azure PG read-only sustained for ~48h, migrator in CrashLoopBackOff

**Status:** Active — server still read-only, migrator crash-looping, no manual intervention possible from cluster side
**Environment:** `medicard-staging` (AKS cluster `aks-mpi-sea-a-mycurex01`)
**Target DB:** `mpiazeapgdb0002.postgres.database.azure.com` (Azure Postgres Flexible Server)
**Root cause:** See [`2026-03-12-azure-pg-recurring-readonly-storage-threshold.md`](./2026-03-12-azure-pg-recurring-readonly-storage-threshold.md) — Azure's 95%-storage auto read-only protection against what appears to be a 2 TB provisioned tier.

> This is a continuation of the incident class documented in the consolidated report above. This occurrence is **qualitatively different from prior ones** because the read-only state has not auto-recovered within the observation window — it has been sustained for approximately 48 hours and is now blocking even the schema-init path, not just data writes.

---

## Current observed state (2026-04-10 ~00:34Z probe)

### Target database

```
 in_recovery | tx_ro | def_ro | db_size
-------------+-------+--------+---------
 f           | on    | on     | 1913 GB
```

- **`default_transaction_read_only = on`** — every new transaction is born read-only. Same state as the April 8 occurrence, but this time it has **not auto-recovered**.
- **DB size: 1,913 GB** — up from 1,900 GB on April 8. The +13 GB reflects partial progress the migrator made during brief writable windows on April 8 before the sustained RO state set in.
- **Remaining headroom: ~32 GB** before hitting the 95% threshold (1,945 GB) of the presumed 2 TB provisioned tier. The migration still needs ~197 GB to complete.

### Migrator pod

```
NAME                               READY   STATUS             RESTARTS         AGE
hapihub-migrator-c4c8959cc-qwpfg   0/1     CrashLoopBackOff   87 (3m24s ago)   44h
```

- **87 restarts** over 44 hours. Kubernetes backoff is capped at 5m, so the pod attempts a restart every 5 minutes and fails immediately.
- **Exit pattern:** `exitCode: 1`, `startedAt` and `finishedAt` are the same second — the process dies instantly on startup, before reaching any useful work.
- **Image:** `ghcr.io/mycurelabs/hapihub-migrator:3.7.5` (digest `sha256:4ecb7ba4bec8d17d2dd792663a2560e0382009f73ffc69571465131bbe7a3caa`).
- **ArgoCD:** Healthy=Progressing (because the pod is not Ready), Sync=Synced at `6b018ef`.

### Crash error

Every restart produces the identical crash:

```
{"level":30,"time":...,"msg":"Connected to PostgreSQL"}
{"level":30,"time":...,"migrationsFolder":"/usr/local/bin/drizzle-pg","msg":"Resolved drizzle-pg directory"}
Fatal error:
error: cannot execute CREATE SCHEMA in a read-only transaction
     length: 125,
   severity: "ERROR",
       code: "25006"
       file: "utility.c"
    routine: "PreventCommandIfReadOnly"
```

The process:
1. Connects to PostgreSQL — succeeds (the server is up, accepting connections, just rejecting writes).
2. Runs Drizzle schema migrations (`CREATE SCHEMA ...`) — hits `sqlstate 25006` because `default_transaction_read_only = on`.
3. The Drizzle schema-init path has **no retry/backoff handler** for `25006`. The error is unhandled, the process exits with code 1.
4. Kubernetes restarts the pod after backoff.
5. Repeat.

This is distinct from the April 8 observation where the migrator reached the bulk data phase and retried gracefully with exponential backoff on `INSERT` failures. On April 8, the read-only state cleared briefly enough for the pod to start, pass schema-init (because the schema already existed), and enter the data phase. Now, because the RO state is sustained, the pod cannot even get past Drizzle init — it crashes before reaching the data-retry code.

---

## Timeline of this occurrence

| Time | Event | DB Size |
|---|---|---|
| 2026-04-08 ~04:13Z | Pod `qwpfg` started on 3.7.5 (rebuilt digest). Schema init passed; bulk migration began. | 1,900 GB |
| 2026-04-08 ~04:22Z | First `sqlstate 25006` errors on `INSERT` (data phase). Migrator retried with backoff. | 1,900 GB |
| 2026-04-08 ~05:28Z | Probe showed PG had recovered to writable (`tx_ro=off, def_ro=off`). Migrator resumed automatically, reached 1,955,000 rows on `medical_records`. | 1,900 GB |
| 2026-04-08 ~06:27Z | Monitor script detected another RO backoff event. Migrator at 2,315,000 rows. PG oscillating in and out of RO. | ~1,905 GB |
| 2026-04-08 ~06:31Z | Monitor confirmed: 25006 retries outnumber progress lines. Still retrying. | ~1,905 GB |
| 2026-04-08 (later) – 2026-04-10 | **RO state became sustained.** Pod eventually exhausted retries, exited (EXIT_ON_BULK_END working), restarted, hit Drizzle `CREATE SCHEMA` → instant crash. Entered CrashLoopBackOff. **87 restarts over ~44 hours.** | Growing to 1,913 GB |
| 2026-04-10 ~00:34Z | Current observation. Pod in CrashLoopBackOff. PG probe confirms `tx_ro=on, def_ro=on`. DB at 1,913 GB. | **1,913 GB** |

---

## What changed vs. the April 8 occurrence

| Aspect | April 8 | April 10 |
|---|---|---|
| RO duration | ~60 min windows, auto-recovered | **~48 hours sustained**, no auto-recovery observed |
| Migrator behavior during RO | Retry with exponential backoff on `INSERT`; resumed automatically when RO cleared | **Cannot start at all** — crashes on Drizzle `CREATE SCHEMA` before reaching data phase |
| Pod status | Running, Ready=true, 0 restarts | CrashLoopBackOff, Ready=false, 87 restarts |
| DB size | 1,900 GB | 1,913 GB (+13 GB from brief writable windows on Apr 8) |
| DB size as % of 2 TB | 92.8% | **93.2%** |
| Net migration progress | Gained ~900k rows on `medical_records` (1.4M → 2.3M) | Zero — all 87 restart attempts crash before reaching data work |

---

## Observations

1. **The auto-recovery that saved prior incidents is not happening this time.** On April 8, the RO state cleared within ~60 minutes. This time it has persisted for ~48 hours across 87 restart attempts. Either Azure's auto-recovery is no longer sufficient at this storage utilization level (1,913 GB / 2 TB = 93.2%), or the brief writable windows are shorter than the pod's 5-minute CrashLoopBackOff interval — meaning the pod misses them entirely.

2. **The Drizzle schema-init path is a harder blocker than the INSERT path.** Even if a brief writable window appears, the pod must complete its entire Drizzle `CREATE SCHEMA` step within that window to reach the data phase where the retry logic lives. If the writable window is only seconds long (plausible given the storage pressure), the pod may start, connect to PG, and still hit `CREATE SCHEMA` during a micro-RO event. The April 8 pod survived this because it started during a long enough writable window for Drizzle to finish.

3. **Each restart attempt is pure waste.** The pod connects to PG (success), runs one DDL statement (fails), exits. 87 iterations of this in 44 hours, each consuming image-pull time, PID allocation, log output, and a restart counter increment. None of them accomplished any useful work.

4. **DB growth has nearly stopped.** Only +13 GB in 2 days, all from the April 8 brief writable windows. The migration is effectively stalled. At the current rate (approaching zero), it will never complete.

5. **The gap to the 95% hard-cap is shrinking even without the migration.** If any other workload writes to this database (e.g., application-level activity logging, WAL accumulation, temp table creation), the remaining 32 GB of headroom will erode further, potentially making even brief writable windows impossible.

6. **No other workloads in `medicard-staging` are affected by the CrashLoopBackOff.** All other pods remain Running. The migrator's crash-loop has no resource-contention or cascading effect on the rest of the namespace — it's contained to a single Deployment with one replica.

---

## What needs to happen

### On the Azure / client side (blocking — nothing else matters until this is resolved)

The provisioned storage must be increased. This is the same recommendation from the consolidated root-cause report, first made on 2026-03-12 and repeated in every subsequent incident report. It has not been actioned.

**Specifics:**

- **Current DB size:** 1,913 GB.
- **Projected final migration size:** ~2.1 TB (current + ~197 GB for two remaining history tables).
- **Minimum viable provisioned tier:** 4 TB (gives ~50% headroom beyond the completed migration).
- **Verification command:**
  ```
  az postgres flexible-server show \
    --resource-group <resource_group> \
    --name mpiazeapgdb0002 \
    --query storage.storageSizeGb
  ```
  This will confirm whether the tier is actually 2 TB (as all evidence suggests) or 4 TB (as the client reported on March 12).

- **Storage increase command:**
  ```
  az postgres flexible-server update \
    --resource-group <resource_group> \
    --name mpiazeapgdb0002 \
    --storage-size 4096
  ```
  This can be done online without downtime (unless crossing the 4,096 GiB boundary per Microsoft docs).

- **Enable auto-grow (safety net):**
  ```
  az postgres flexible-server update \
    --resource-group <resource_group> \
    --name mpiazeapgdb0002 \
    --storage-auto-grow enabled
  ```

Once the storage tier is increased, Azure should clear `default_transaction_read_only` automatically. The migrator pod will succeed on its next restart attempt (within the current 5-minute CrashLoopBackOff cycle) and resume migration.

### On the infra / cluster side (nothing to do except wait)

- Do not delete the pod. The CrashLoopBackOff is self-recovering — once PG becomes writable, the next restart attempt will pass Drizzle init and enter the data phase normally.
- Do not roll back the image. `3.7.5` is correct; the problem is not the image, it's the target DB.
- Continue running the monitor script (`mise run monitor-migration -- --loop`) to detect when PG recovers and the migration resumes. The first `Healthy` status post will confirm recovery.

---

## Upstream migrator feedback (not blocking, but worth noting)

The Drizzle schema-init path (`CREATE SCHEMA` at startup) has no retry wrapper for `sqlstate 25006`. The bulk-insert path does (added in the 3.7.5 rebuild on April 8), but the startup path was missed. This means any transient or sustained read-only event that coincides with a pod startup causes an immediate crash instead of a graceful wait.

Recommended fix: wrap the Drizzle migration runner invocation in the same retry-with-backoff logic used for bulk inserts, catching `sqlstate 25006` and retrying on a reasonable schedule before giving up. This would convert the current 87-restart CrashLoopBackOff into a single pod sitting patiently in retry until PG becomes writable — matching the design intent.

This is additive to the existing upstream ticket at `~/Projects/mycure/mono/services/hapihub-migrator/ISSUE-2026-04-08-non-idempotent-schema-init.md`.

---

## References

- **Consolidated root cause:** [`reports/2026-03-12-azure-pg-recurring-readonly-storage-threshold.md`](./2026-03-12-azure-pg-recurring-readonly-storage-threshold.md) — full incident history, storage math, client recommendations.
- **Previous occurrence:** [`reports/2026-04-08-azure-pg-read-only-blocking-hapihub-migrator.md`](./2026-04-08-azure-pg-read-only-blocking-hapihub-migrator.md) — shorter RO event that auto-recovered within ~60 min; first observation of the 3.7.5 retry logic working.
- **Upstream migrator ticket:** `~/Projects/mycure/mono/services/hapihub-migrator/ISSUE-2026-04-08-non-idempotent-schema-init.md`
