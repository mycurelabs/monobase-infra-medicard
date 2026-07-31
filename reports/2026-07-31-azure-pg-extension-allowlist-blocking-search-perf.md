# Azure PostgreSQL Extension Allow-List Blocking Search Indexes & Performance — Report + Ask

**Affected system:** Azure PostgreSQL Flexible Server `mpiazeppgdb0003.postgres.database.azure.com` (DB `hapihub`, app role `mycure_prod_app`)
**Severity:** High — user-facing performance + a disabled feature
**Status:** Blocked — needs a one-line **`azure.extensions`** server-parameter change by MediCard's Azure admin
**Phase:** MYCURE X testing / pre-cutover
**Date:** 2026-07-31

---

## Summary / Ask

We are now in the **testing phase** of MYCURE X on the migrated PostgreSQL database. During testing we observed queries running **far slower than expected** (e.g. patient search taking ~10 seconds) even though the application **ships the exact indexes to make them fast**. On investigation, the indexes are **not being created** — because they depend on PostgreSQL **extensions that Azure is blocking at the server level**.

Azure Database for PostgreSQL Flexible Server only allows extensions that are explicitly listed in the **`azure.extensions`** server parameter. On this server that list currently contains **`PGCRYPTO` only**. Every other extension the application needs is refused, and the app's automatic database migrations that install them fail silently (they log a warning and continue, so the server stays up but the features run un-optimized or disabled).

**The ask (no downtime, dynamic parameter, ~2 minutes):** add the three required extensions to `azure.extensions`, keeping the existing one:

```
PGCRYPTO, PG_TRGM, VECTOR, PG_STAT_STATEMENTS
```

All three are Microsoft-supported and already present on the server image (they appear in `pg_available_extensions`); they simply need allow-listing. No application change is required to unblock — the app installs the extensions and builds the indexes automatically on the next restart.

---

## What we observed (testing phase)

- Patient search (Patient List and Registration) is slow when typing a specific name — measured **~10.7 seconds** for a single search on the MediCard dataset (`personal_details`, 5.4M rows / 28 GB).
- Expected behaviour: the application ships trigram (`pg_trgm`) GIN indexes precisely so this search is index-backed and returns in well under a second.
- The indexes are **absent** on the server. The application does try to create them on every startup, but the attempt fails.

---

## Root cause (verified)

Azure Flexible Server gates extension creation behind the `azure.extensions` server parameter. Any `CREATE EXTENSION` for an extension not on that list is rejected — even for a role that otherwise has `CREATE` privileges (our app role `mycure_prod_app` does).

Verified directly on the server:

```
azure.extensions (current)      = PGCRYPTO
installed extensions            = azure, pg_cron, pgaadauth, plpgsql
pg_trgm                         = available (v1.6), NOT installed
vector (pgvector)               = available (v0.8.2), NOT installed
pg_stat_statements              = available (v1.11), NOT installed
mycure_prod_app can CREATE      = yes  (so this is purely the allow-list, not a permissions issue)
```

Application startup log (hapihub), on every boot:

```
[pg-concurrent-migrator] 0073_codify_2520_hotfix_indexes / extension pg_trgm failed:
    extension "pg_trgm" is not allow-listed for users in Azure Database for PostgreSQL
[pg-concurrent-migrator] ... idx_personal_details_firstname_trgm failed:
    operator class "gin_trgm_ops" does not exist for access method "gin"
```

Query plan for a patient-name search (read-only `EXPLAIN ANALYZE`), showing the fallback to a full table scan because no usable index exists:

```
Seq Scan on personal_details  (Rows Removed by Filter: 5,444,556)
Execution Time: 10679 ms
```

---

## Impact

| # | Extension | Blocked by allow-list → effect | Feature |
|---|---|---|---|
| 1 | **pg_trgm** | patient-search trigram GIN indexes cannot be created → name search does a full-table scan (~10.7 s per specific-name search) | Patient search (Patient List, Registration) — **slow** |
| 2 | **vector** (pgvector) | `document_embeddings` table is not created (it exists nowhere in the DB today) → semantic / document search silently disabled | Document/semantic search — **off** |
| 3 | **pg_stat_statements** | server-side query telemetry unavailable → we cannot see slow-query statistics to diagnose performance | Ops / performance visibility — **blind** |

No other schema migration (tables, columns, ALTERs, non-extension indexes) is failing — the migration failures are limited to the extension-dependent items above.

---

## Requested change

Add the extensions to the server allow-list. This is a **dynamic** parameter — it does **not** require a server restart or maintenance window.

**Azure CLI:**
```bash
az postgres flexible-server parameter set \
  --resource-group <medicard-resource-group> \
  --server-name mpiazeppgdb0003 \
  --name azure.extensions \
  --value PGCRYPTO,PG_TRGM,VECTOR,PG_STAT_STATEMENTS
```

**Azure Portal (equivalent):** the server → **Settings → Server parameters** → search `azure.extensions` → add `PG_TRGM`, `VECTOR`, `PG_STAT_STATEMENTS` to the existing `PGCRYPTO` → **Save**.

### After the change
1. The application's built-in migrations create the extensions and build the trigram indexes automatically on the next hapihub restart (or we run them on request, using `CREATE INDEX CONCURRENTLY` so there is no write-blocking on the live table).
2. Patient search drops from ~10 s to sub-second (index scan instead of full-table scan).
3. Document/semantic search and query telemetry become available.

There is no risk to existing data: enabling an extension and adding indexes is additive and reversible.

---

## References

- [Azure Database for PostgreSQL — Flexible Server: extensions & the `azure.extensions` allow-list](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-extensions)
- [How to use PostgreSQL extensions (allow-listing via server parameter)](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/how-to-allow-extensions)
- Related MYCURE tracking: patient-search performance (issue #2774).
