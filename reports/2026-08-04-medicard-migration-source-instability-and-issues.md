# 2026-08-04 — MediCard migration source: node shutdown + slow large scans (verified)

**Scope:** Source-side (`mycure-stg-sh`) issues that blocked the PG backfill on 2026-08-04, **excluding** the snapshot-restore/oplog-break and the frozen-vs-live-source topology, which are documented separately (see Related). Every claim lists how it was verified so MediCard can independently re-check. (Issues on our side — migrator code and our operational procedure — are tracked/fixed by us and are not in this report.)
**Environment:** cluster `aks-mpi-sea-p-mycurex01`, namespace `medicard`; source Atlas `mycure-stg-sh.q4trx.mongodb.net` (sharded — `isdbgrid`).
**Related (not repeated here):** `2026-08-02-cdc-changestream-oplog-break.md` (snapshot restore rolled the oplog → CDC break), `2026-08-03-medicard-source-topology-snapshot-vs-live-cdc.md` (source is a frozen snapshot, not live).

---

## Summary

While backfilling the PG target from `mycure-stg-sh`, the source cluster caused two verified failures: a **shard-node shutdown mid-migration**, and an inability to **serve full scans** of the 100M-row `activity-logs` collection in reasonable time. Because of these, **82 of 83 collections are migrated and (where re-checked) verified**; only `activity-logs` remains, deferred until the source can serve it.

---

## 1. Shard-node shutdown mid-migration → 3 collections failed (2026-08-04 ~00:17Z)

A 24h bulk migration completed **80 of 83 collections**, then a source shard node went down during reads and failed the remaining reads.

- **Verified — the migrator's per-collection error records:**
  - `activity-logs` → `Error on remote shard atlas-k97n6n-shard-01-01.q4trx.mongodb.net:27017 :: caused by :: interrupted at shutdown`
  - `billing-invoice-agt` → `Error on remote shard atlas-k97n6n-shard-00-02 :: interrupted at shutdown`
  - `diagnostic-orders` → `Cursor not found (id: 2089281964639564606)`
- **What this proves:** `interrupted at shutdown` is MongoDB error **11600 (InterruptedAtShutdown)** — emitted **by the MongoDB server** when a node is shutting down. It is unambiguously a source-cluster event, not a client/network fault on our side.
- **Needs MediCard to confirm:** whether this shutdown was **planned** (Atlas maintenance / a snapshot restore in progress) or **unplanned**. This is only visible in the Atlas cluster event/maintenance log, which is on MediCard's side.

## 2. Source cannot serve a full scan of `activity-logs` (100M) in reasonable time

The `activity-logs` migration stalled with no progress for ~40 min. Tested directly against the source (2026-08-04):

- **Verified (live):** `db.getCollection("activity-logs").estimatedDocumentCount()` returns **100,220,122 in 4 ms** (metadata), but a full `countDocuments({}, {maxTimeMS:30000})` **fails with `MaxTimeMSExpired` after 30 s**. Cluster is reachable (`ping = 1`) and is a sharded router (`db.hello().msg = "isdbgrid"`).
- **What this proves:** the source is **up but slow to serve full scans** of this 100M collection — a source-side performance limit (cluster tier / load / shard health), not a connection drop and not a fault in our workload.
- **Re-verify:** `mongosh <source-uri> --eval 'var t=Date.now(); db.getCollection("activity-logs").countDocuments({},{maxTimeMS:30000}); print(Date.now()-t)'`

---

## Impact / current state (verified)

- **82 of 83 collections migrated and verified.** After the shutdown, the two smaller affected collections were re-run and passed verification:
  - `billing-invoice-agt`: Mongo 1,277,496 == PG 1,277,496 — verify **pass** (0 mismatched, 0 missing).
  - `diagnostic-orders`: Mongo 3,168,386 == PG 3,168,386 — verify **pass**.
- **Outstanding: `activity-logs`** (~100.2M docs) — cannot complete until the source can serve the scan. It is the audit/activity log; all clinical and billing collections are done.

---

## Ask of MediCard

1. **Confirm the 2026-08-04 ~00:17Z shard shutdown** on `mycure-stg-sh` — was it planned (maintenance/restore) or unplanned? (Atlas event log.)
2. **Provide a stable, adequately-provisioned window** for `mycure-stg-sh` — no restores/maintenance in progress, and enough capacity for the cluster to serve a full scan of the 100M `activity-logs` collection — so the final collection can be migrated in one pass.
