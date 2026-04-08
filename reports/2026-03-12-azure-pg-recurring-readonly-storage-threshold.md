# Azure PostgreSQL Recurring Read-Only Issue — Full Report

**Affected system:** Azure PostgreSQL server `mpiazeapgdb0002.postgres.database.azure.com`
**Severity:** Critical
**Status:** Unresolved — recurring since 2026-03-12, migration blocked
**Incident start:** 2026-03-12
**Last updated:** 2026-04-08

---

## Issue

The Azure PostgreSQL server has repeatedly entered read-only mode, rejecting all write operations with:

```
cannot execute INSERT in a read-only transaction
```

This has been occurring since 2026-03-12, blocking the data migration from MongoDB to PostgreSQL. The migration process crashes each time and must restart from where it left off.

---

## Timeline

| Date | Event | DB Size |
|---|---|---|
| 2026-03-12 | 1st read-only occurrence | ~919 GB |
| 2026-03-12 | Client reported storage upgrade from 1TB to 4TB | — |
| 2026-03-13 | 2nd read-only occurrence | ~919 GB |
| 2026-03-16 | 3rd read-only occurrence | ~921 GB |
| 2026-03-18 | 4th read-only occurrence | ~921 GB |
| 2026-03-19 | 5th read-only occurrence | ~920 GB |
| 2026-03-20 – 2026-03-28 | Multiple occurrences (weekends + weekdays) | ~920 GB |
| 2026-03-29 | DB grew past 920 GB — storage upgrade partially effective | 1.37 TB |
| 2026-03-31 | Connection terminated unexpectedly (separate issue) | ~1.5 TB |
| 2026-04-01 | Read-only recurrence at new threshold | ~1.87 TB |
| 2026-04-06 | Read-only recurrence | ~1.87 TB |
| 2026-04-08 | Latest confirmed — migration stopped, PG recovered to writable | **1.87 TB** |

---

## Root Cause

Azure Database for PostgreSQL Flexible Server enforces a protective read-only mode when storage usage reaches a critical threshold. Per official Microsoft documentation:

> "When the storage usage reaches 95% or if the available capacity is less than 5 GiB (whichever is more), the system automatically switches the server to read-only mode to avoid errors associated with disk-full situations."
>
> — [Microsoft Learn: Limits in Azure Database for PostgreSQL](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-limits)

Our observed failure points are consistent with a **2 TB provisioned storage** tier, not the reported 4 TB:

| Incident Period | DB Size at Failure | If 2 TB Provisioned | If 4 TB Provisioned |
|---|---|---|---|
| Mar 12–28 | ~920 GB | 92% (approaching 95%) | 23% (would not trigger) |
| Apr 1–8 | ~1,877 GB | **93.9% (imminent)** | 47% (would not trigger) |

The server consistently enters read-only mode as it approaches 95% of what appears to be a 2 TB provisioned tier. If the server were actually provisioned at 4 TB, the 95% threshold would be 3.8 TB — far above the current 1.87 TB usage.

---

## Verified Server State (2026-04-08)

| Metric | Value |
|---|---|
| Database size | **1,877 GB (1.87 TB)** |
| `default_transaction_read_only` | `off` |
| `pg_is_in_recovery()` | `false` (not a replica) |
| WAL size | 480 MB (negligible) |
| Replication slots | 2 active, 0 bytes retained |
| Dead tuples | 0 across all tables |
| PostgreSQL version | 17.7 |

The read-only state is not caused by PostgreSQL configuration, WAL accumulation, replication lag, or dead tuple bloat. It is triggered solely by Azure's external storage protection mechanism.

---

## Database Storage Breakdown

| Table | Rows | Heap (row data) | TOAST (JSONB) | Indexes | Total |
|---|---|---|---|---|---|
| `activity_logs` | 84.5M | 138 GB | 941 GB | 7.9 GB | **1,096 GB** |
| `medical_records` | 29.3M | 31 GB | 666 GB | 2.8 GB | **707 GB** |
| All other tables | — | — | — | — | ~74 GB |
| **Total** | | | | | **1,877 GB** |

85.6% of the database (1,607 GB) is TOAST storage — PostgreSQL's mechanism for storing large values out-of-line. The `_data` JSONB columns in `activity_logs` and `medical_records` contain the migrated MongoDB documents. This is legitimate data, not bloat.

---

## Migration Progress

The migration is at approximately **90% completion** by row count. Two history tables have not yet started.

| Status | Collections | Rows |
|---|---|---|
| Completed | 81 | ~162M |
| Not started | 2 (`personal_details_history`, `medical_records_history`) | ~39M |
| **Total** | 83 | ~201M |

Estimated additional storage needed for remaining tables: **~197 GB** (`personal_details_history` ~178 GB, `medical_records_history` ~19 GB).

**Estimated final database size: ~2.1 TB.**

A 2 TB provisioned tier cannot hold the completed migration. The 95% threshold (1.9 TB) will be exceeded before the remaining tables finish.

---

## Impact to Production

If this storage behavior persists into production, the following will occur when the database reaches the storage threshold:

- **All application writes will fail.** Any INSERT, UPDATE, or DELETE operation will be rejected. This includes user registrations, appointment bookings, medical record creation, billing transactions, inventory updates, and all other write operations.
- **No warning before failure.** The server transitions to read-only without prior notice to the application layer. There is no graceful degradation — writes simply start failing.
- **Data loss risk.** Application transactions that are partially committed at the moment the server goes read-only may be rolled back, resulting in inconsistent state.
- **Recovery requires manual intervention.** The server does not automatically return to read-write mode. Per Microsoft documentation, storage must be increased for Azure to clear the read-only state.
- **Cascading failures.** Services that depend on successful database writes (e.g. queue processing, billing, notifications) will enter error loops, potentially causing CPU/memory pressure and pod restarts across the cluster.
- **Unpredictable timing.** The failure can occur at any time — including during peak hours or critical operations (e.g. mid-billing cycle, during a patient encounter).

---

## Recommendations for Client

**1. Verify actual provisioned storage size**

The provisioned storage tier is not visible from within PostgreSQL. It must be checked via the Azure Portal or Azure CLI:

```
az postgres flexible-server show \
  --resource-group <resource_group> \
  --name mpiazeapgdb0002 \
  --query storage.storageSizeGb
```

**2. Increase provisioned storage to at least 4 TB**

The completed migration will require approximately 2.1 TB. With ongoing application writes and growth, 4 TB provides adequate headroom. Storage can be increased online without downtime (except when crossing the 4,096 GiB boundary, which requires offline scaling per Microsoft documentation).

**3. Enable storage auto-grow**

Auto-grow automatically expands storage before hitting the 95% threshold, preventing read-only mode:

```
az postgres flexible-server update \
  --resource-group <resource_group> \
  --name mpiazeapgdb0002 \
  --storage-auto-grow enabled
```

Note: Auto-grow is **disabled by default** and may not prevent read-only mode if data grows faster than Azure can expand storage. It should be treated as a safety net, not a substitute for adequate provisioning.

**4. Set up Azure Monitor alerts**

Configure alerts at 80% and 90% storage utilization to provide early warning before the 95% read-only threshold is reached.

---

## References

- [Limits in Azure Database for PostgreSQL - Flexible Server (Microsoft Learn)](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-limits)
- [Azure PostgreSQL: Fixing Read-Only Mode Triggered by Storage Threshold (Microsoft Tech Community)](https://techcommunity.microsoft.com/blog/azuredbsupport/azure-postgresql-lesson-learned-2-fixing-read-only-mode-storage-threshold-explai/4464751)
- [Configure Storage Autogrow - Azure Database for PostgreSQL (Microsoft Learn)](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/how-to-auto-grow-storage)
- [PostgreSQL Flexible Server stuck in read-only mode (Microsoft Q&A)](https://learn.microsoft.com/en-us/answers/questions/5786493/postgresql-flexible-server-stuck-in-read-only-mode)
- [Storage autogrow enabled yet server became read-only (Microsoft Q&A)](https://learn.microsoft.com/en-us/answers/questions/2224796/azure-database-for-postgresql-flexible-server-with)

---

## Connection Details

- **Server:** `mpiazeapgdb0002.postgres.database.azure.com:5432`
- **Database:** `postgres`
- **User:** `mpadmin02`
