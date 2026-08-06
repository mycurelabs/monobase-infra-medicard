# Azure PostgreSQL Server Tuning — `work_mem` + parallel workers — Ask for MediCard

**Affected system:** Azure PostgreSQL Flexible Server `mpiazeppgdb0003.postgres.database.azure.com` (DB `postgres`, PG 17.10)
**Severity:** High — aggravates the #2774 Daily Census / Lab / Imaging worklist **504** timeouts
**Status:** Ask — two **dynamic** server-parameter changes by MediCard's Azure admin (no restart, no downtime)
**Phase:** MYCURE X testing / pre-cutover
**Date:** 2026-08-04
**Related:** issue #2774; `reports/2026-08-04-medicard-worklist-daily-census-504-rca.md` (full RCA); `reports/2026-07-31-azure-pg-extension-allowlist-blocking-search-perf.md` (separate `azure.extensions` ask)

---

## Summary / Ask

The #2774 worklist/census 504s are primarily an app-side + index problem (tracked separately), but two **server-level** settings on this Flexible Server make the slow queries *much* worse than they need to be. Both are **dynamic** parameters — they take effect without a restart or maintenance window.

1. **`work_mem` is 4 MB** — far too small for this workload. Large filtered scans overflow the in-memory bitmap and go **"lossy"**, which forces Postgres to re-check ~millions of extra heap rows. On the live plans below this turned a count into a **114-second** scan.
2. **Parallelism isn't being used** on the heaviest query — the planner *planned* 2 parallel workers but **launched 0**, so a 114 s scan ran single-threaded.

### Requested changes (Azure CLI)

```bash
# 1) Raise work_mem from 4MB. 32–64MB is a reasonable start for this workload.
az postgres flexible-server parameter set \
  --resource-group <medicard-resource-group> --server-name mpiazeppgdb0003 \
  --name work_mem --value 65536        # value is in KB → 64 MB

# 2) Ensure parallelism is available (check current values first; raise if starved).
az postgres flexible-server parameter show \
  --resource-group <medicard-resource-group> --server-name mpiazeppgdb0003 \
  --name max_parallel_workers_per_gather
az postgres flexible-server parameter show \
  --resource-group <medicard-resource-group> --server-name mpiazeppgdb0003 \
  --name max_parallel_workers
# if max_parallel_workers is low relative to vCores, raise it (e.g. to the vCore count).
```

Portal equivalent: server → **Settings → Server parameters** → `work_mem` → `65536` (KB) → Save.

> **Caveat on `work_mem`:** it is allocated **per sort/hash node per connection**, so raising it multiplies under high connection counts. 64 MB is conservative; if the server is memory-constrained or runs very high connection counts, start at 32 MB (`32768`) and watch memory. This is the one knob to set thoughtfully.

---

## Evidence (live `EXPLAIN (ANALYZE, BUFFERS)`, 2026-08-04)

**Lab worklist forced `count(*)` — 114 s, lossy bitmap, 0 workers launched:**
```
Finalize Aggregate (actual time=114032..114036)
  Workers Planned: 2  Workers Launched: 0                 <- parallelism not used
  -> Parallel Bitmap Heap Scan on diagnostic_order_tests  rows=546,967
       Rows Removed by Index Recheck: 1,514,037           <- lossy bitmap (work_mem=4MB)
       Heap Blocks: exact=55,485 lossy=301,388
Execution Time: 114,036 ms
```

**Daily Census `billing_items` list — 35 s, same lossy-bitmap symptom:**
```
Rows Removed by Index Recheck: 1,070,694
Heap Blocks: exact=17,412 lossy=228,161
Execution Time: 35,105 ms
```

`SHOW work_mem` → `4MB`. `SHOW max_parallel_workers_per_gather` → `2`.

The `lossy` heap blocks and the millions of "Rows Removed by Index Recheck" are the direct signature of an undersized `work_mem`: the bitmap can't hold every matching tuple ID, so it degrades to page-granularity and Postgres re-reads/rechecks whole pages. A larger `work_mem` keeps the bitmap **exact** and removes that recheck cost.

---

## Why this is worth doing even though the app fix is coming

The app-side fixes (bound/avoid the redundant count; add a `billing_items (facility, created_at)` index; batch the populate fan-out) are the primary remedy and are tracked in the RCA report. But:
- Raising `work_mem` **immediately** reduces the pain across *all* large scans on this DB (reports, exports, ad-hoc), not just these three pages — it's a broad win with a one-line change.
- It's independent of the app deploy cycle, so it can land now while the code fixes go through test → deploy.

Both changes are additive, reversible, and carry no data risk.

## Note: app-side alternative (for context, not required from MediCard)

`work_mem` can also be raised **per-session** by the application (`SET LOCAL work_mem` around specific heavy queries) rather than globally on the server. If MediCard would prefer not to change the global default, we can pursue the per-query approach on the hapihub side instead — but the global bump is simpler and helps everything.
