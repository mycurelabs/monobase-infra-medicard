# MediCard X — Daily Census / Lab & Imaging Worklist 504 Timeouts — RCA (data-verified)

**Affected system:** Azure PostgreSQL Flexible Server `mpiazeppgdb0003.postgres.database.azure.com` (DB `postgres`, app role `mycure_prod_app`, PG 17.10) behind hapihub-next `11.20.74`
**Reported in:** issue #2774 (russherr comment — Loom + DevTools captures)
**Severity:** High — three user-facing pages return **`504 Gateway Timeout`** on first load
**Status:** Root cause verified on live prod PG. Fixes = mostly app-side (mono repo) + one optional server-tuning ask to MediCard
**Phase:** MYCURE X testing / pre-cutover
**Date:** 2026-08-04

---

## Summary

Issue #2774 began as a patient-search RCA. A follow-up from russherr expands it: **Daily Census**, **Lab worklist**, and **Imaging worklist** error on first load. The DevTools captures show the real failure is a **`504 Gateway Timeout`** on the underlying API call — a slow query the gateway kills, not a render bug.

All three trace to the same two mechanisms, verified with live `EXPLAIN (ANALYZE, BUFFERS)`:

1. **Every list request runs a forced, unbounded `SELECT count(*)`** (hapihub forces `$total=true` on all lists — `services/hapihub/src/openapi/crud.ts:99`). On a table with millions of rows and no index matching the *count's* predicate, this count alone runs **up to ~114 seconds**.
2. **A query whose sort/filter shape has no matching index** falls back to scanning ~1M rows and sorting them in memory — the **Daily Census list runs ~35 seconds**.

Aggravated by two server settings: **`work_mem = 4MB`** (bitmap scans go *lossy* → huge heap-recheck overhead) and **`max_parallel_workers_per_gather = 2` but workers frequently *launch 0*** under load (queries run single-threaded).

The tables are large: `diagnostic_order_tests` = **6,293,928** rows, `billing_items` = **7,386,052** rows.

---

## Evidence (live, read-only EXPLAIN ANALYZE — 2026-08-04)

Facilities from the reported URLs: lab `5de79f27e6e9fc7153812aa1`, census/imaging `5de79f27e6e9fc7153812aa5`.

### 1. Lab worklist — `GET /diagnostic-order-tests?...type=laboratory&$total=true`

The **list** is fast; the **forced count** is the 504:

```
-- LIST (LIMIT 25): 1.4 ms  ✅ uses idx_diagnostic_order_tests_facility_type_created_at
Limit (actual time=1.283..1.326 rows=25)
  -> Index Scan Backward using idx_diagnostic_order_tests_facility_type_created_at
       Index Cond: (facility = '...aa1' AND type = 'laboratory')
       Filter: (for_confirmation IS NULL)
Execution Time: 1.425 ms

-- COUNT(*) (forced by $total=true): 114,037 ms  ❌  114 SECONDS
Finalize Aggregate (actual time=114032..114036)
  Workers Planned: 2  Workers Launched: 0        <- ran single-threaded
  -> Parallel Bitmap Heap Scan on diagnostic_order_tests  (rows=546,967)
       Rows Removed by Index Recheck: 1,514,037   <- lossy bitmap (work_mem=4MB)
       Heap Blocks: exact=55,485 lossy=301,388
       Buffers: shared hit=223,951 read=134,639   <- 134k blocks off disk
Execution Time: 114,036 ms
```

The count can't use the `(facility,type,created_at)` index effectively because its predicate is `(facility, type, for_confirmation IS NULL)` — `for_confirmation` is in no index, so PG bitmap-scans `(facility,type)` (~766k rows) and heap-checks each. At 4MB `work_mem` the bitmap turns lossy and the recheck dominates.

### 2. Imaging worklist — same query, `type=radiology`, facility `...aa5`

```
-- COUNT(*): 516 ms warm  (matched 57,708 rows; Heap Blocks lossy=64,739)
```

Fast **when warm** for this facility (fewer radiology rows, mostly cached: `hit=192,027 read=1,046`). The *mechanism is identical to Lab* — the same forced count over a lossy bitmap. It tips into a 504 on a **cold cache** (first load — exactly what russherr reports), under concurrent first-load requests competing for the 2 parallel-worker slots, or as this branch's radiology volume grows.

### 3. Daily Census — `GET /billing-items?...finalizedAt[$exists]=true&$sort[createdAt]=-1&$total=true` + 10-relation `$populate`

Here the **list** is the killer (opposite of the worklists):

```
-- LIST (ORDER BY created_at DESC LIMIT 25): 35,105 ms  ❌  35 SECONDS
Limit (actual time=35099..35104 rows=25)
  -> Gather Merge -> Sort  (Sort Key: created_at DESC, top-N heapsort)
       -> Parallel Bitmap Heap Scan on billing_items  (rows=462,863 x2)
            Recheck Cond: (facility = '...aa5')
            Rows Removed by Index Recheck: 1,070,694   <- lossy (work_mem=4MB)
            Heap Blocks: exact=17,412 lossy=228,161
            Filter: (finalized_at IS NOT NULL)
       -> Bitmap Index Scan on billing_items_facility_invoice_type_idx (rows=1,125,629)
Execution Time: 35,105 ms

-- COUNT(*): 527 ms  ✅  (this one IS indexed: billing_items_facility_finalized_at_idx, index-only scan, 925,726 rows)
```

`billing_items` has **no `(facility, created_at)` index**, so the `ORDER BY created_at DESC` can't stream from an index — PG bitmap-scans all **1,125,629** of the facility's rows and does a top-N sort. That's the 35 s. **On top of that**, the Daily Census `$populate` fans out to 10 relations, several of them `method:find` (`payments` by `item`, `attendingDoctors`/`attendingStaff` by id) which hapihub does **not batch** (only count-badge populates are batched — `services/hapihub/src/openapi/populate.ts:231-255`); they resolve **per row**, each re-entering the full auth/AJV request pipeline → on the order of hundreds of sub-requests for 25 rows.

### Index inventory (verified on prod)

| Table | Relevant indexes present | Missing for the hot query |
|---|---|---|
| `diagnostic_order_tests` | `idx_..._facility_type_created_at` ✅, `..._facility_type_section`, `..._test`, `..._order` | none for the list; **count has no index covering `for_confirmation`** |
| `billing_items` | `..._facility_finalized_at` ✅ (serves count), `..._facility_invoice_type[_finalized_at]`, `..._facility_type_finalized_at`, `..._invoice`, `..._ref` | **no `(facility, created_at)`** → list sorts in memory |

(The two `personal_details` `*_trgm` indexes are still missing per the separate Azure allow-list blocker — `reports/2026-07-31-azure-pg-extension-allowlist-blocking-search-perf.md`. Not the cause of these three 504s.)

---

## Root causes (ranked)

1. **Forced unbounded `count(*)` on every list** (`crud.ts:99`) — the direct cause of the **Lab/Imaging worklist 504** (114 s count). App-side.
2. **Missing `billing_items (facility, created_at)` index** — the direct cause of the **Daily Census 35 s list** (in-memory sort of ~1.1M rows). App-side (schema + migration).
3. **`$populate` N+1** for `method:find` relations on Daily Census — compounds #2 into a hard 504. App-side.
4. **Server tuning aggravators:** `work_mem=4MB` (lossy bitmaps) and parallel workers not launching under load. MediCard/Azure-side (optional but high-leverage).

---

## Fixes

### App-side (mono repo `services/hapihub` — analysis only, NOT applied)

1. **Bound / make optional the forced count** — `crud.ts:99` forces `$total=true` on every list; `pg-service.ts` then runs a full `count(*)`. Options, in order of preference:
   - stop forcing it — let the client opt in to `$total` (worklist/census UIs mostly need "page of 25", not an exact total-of-547k);
   - or cap it: `count(*)` over a `LIMIT N` subquery → return exact-or-`>N` (e.g. "500+");
   - or use a planner estimate (`reltuples`-scaled) for the badge.
   This alone takes the Lab/Imaging worklist from 114 s → ~1 ms (the list is already fast). Also helps patient search (#2774) and every other list.
2. **Add `billing_items (facility, created_at)` index** (`services/hapihub/src/services/billing/items.schema.ts` + a `CREATE INDEX CONCURRENTLY` migration; plain btree — **not** blocked by the Azure extension allow-list). Lets Daily Census stream the newest-25 from the index instead of sorting ~1.1M rows. Consider `(facility, finalized_at, created_at)` if the `finalized_at IS NOT NULL` filter should be covered too.
3. **Batch `method:find` populates** — extend the batching in `populate.ts` beyond count-badges so `payments` (one `WHERE item IN (…25 ids)`), `attendingDoctors`/`attendingStaff` resolve in one query per relation instead of per-row. Biggest lever for Daily Census once #2 lands. Join columns are already indexed (`idx_billing_payments_item`).

### MediCard / Azure-side (optional, high-leverage server tuning)

- **Raise `work_mem`** from 4 MB (e.g. 32–64 MB). The lossy bitmaps (300k+ lossy blocks, millions of recheck rows) are a direct consequence of 4 MB; a larger `work_mem` keeps bitmaps exact and cuts the count/scan time sharply. Dynamic parameter, no restart.
- Confirm **`max_parallel_workers` / `max_parallel_workers_per_gather`** aren't starved — the 114 s count planned 2 workers and launched 0.

These are additive and reversible; no data risk.

---

## Verification method

Live prod PG reached read-only through the windowed path `medicard.gateway → mc.remote.prd.bastion → kubectl exec (ns medicard, hapihub pod) → Azure PG`. App pods are stripped of psql/node clients, so queries ran via a pure-stdlib Python PG client (SCRAM-over-TLS) inside the hapihub pod, reading its own `DATABASE_URI`. All statements were `SELECT` / `EXPLAIN` / `SHOW` — no writes.

---

## References

- Issue #2774 (patient search + these worklist/census 504s).
- `reports/2026-07-31-azure-pg-extension-allowlist-blocking-search-perf.md` (the separate `pg_trgm` allow-list blocker — patient search only).
- Code: `services/hapihub/src/openapi/crud.ts:99` (forced `$total`), `.../src/openapi/populate.ts:231-255` (count-badge-only batching), `.../src/services/billing/items.schema.ts` (billing_items indexes), `.../src/services/diagnostic/order-tests.schema.ts:84` (worklist index).
