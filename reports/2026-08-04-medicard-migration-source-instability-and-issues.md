# 2026-08-04 — MediCard migration source: shard-node shutdown mid-migration (verified)

**Scope:** Source-side (`mycure-stg-sh`) event that interrupted the 2026-08-04 PG backfill, **excluding** the snapshot-restore/oplog-break and the frozen-vs-live-source topology, which are documented separately (see Related). Every claim lists how it was verified so MediCard can independently re-check. (Migrator-side issues found during the backfill — including the `activity-logs` convergence-count stall — are ours to fix and are tracked separately, not in this report.)
**Environment:** cluster `aks-mpi-sea-p-mycurex01`, namespace `medicard`; source Atlas `mycure-stg-sh.q4trx.mongodb.net` (sharded — `isdbgrid`).
**Related (not repeated here):** `2026-08-02-cdc-changestream-oplog-break.md` (snapshot restore rolled the oplog → CDC break), `2026-08-03-medicard-source-topology-snapshot-vs-live-cdc.md` (source is a frozen snapshot, not live).

---

## Summary

During the PG backfill from `mycure-stg-sh`, a **source shard node shut down mid-read**, failing the in-flight reads on 3 collections. **82 of 83 collections are migrated and (where re-checked) verified.** The one remaining collection, `activity-logs`, is blocked by a **migrator-side** issue (an unbounded convergence count over a non-indexed field), not by the source — see "Correction" below.

---

## 1. Shard-node shutdown mid-migration → 3 collections' reads failed (2026-08-04 ~00:17Z)

A 24h bulk migration completed **80 of 83 collections**, then a source shard node went down during reads.

- **Verified — the migrator's per-collection error records:**
  - `activity-logs` → `Error on remote shard atlas-k97n6n-shard-01-01.q4trx.mongodb.net:27017 :: caused by :: interrupted at shutdown`
  - `billing-invoice-agt` → `Error on remote shard atlas-k97n6n-shard-00-02 :: interrupted at shutdown`
  - `diagnostic-orders` → `Cursor not found (id: 2089281964639564606)`
- **What this proves:** `interrupted at shutdown` is MongoDB error **11600 (InterruptedAtShutdown)** — emitted **by the MongoDB server** when a node is shutting down. Unambiguously a source-cluster event, not a client/network fault on our side.
- **Needs MediCard to confirm:** whether this shutdown was **planned** (Atlas maintenance / a snapshot restore in progress) or **unplanned** — only visible in the Atlas cluster event/maintenance log.
- **Re-verify:** `SELECT collection,status,error FROM _migration_checkpoints WHERE run_id=(SELECT run_id FROM _migration_checkpoints ORDER BY started_at DESC LIMIT 1) AND status<>'completed';`

---

## Correction — the `activity-logs` "stall" is a MIGRATOR issue, not a source scan limit

An earlier draft of this report attributed the `activity-logs` stall to the source being "unable to serve a full scan." **That was wrong.** Verified against the source (2026-08-04):

- **Document reads are paginated and fast.** The migrator streams a `_id`-sorted cursor in 500-doc batches. A `find({}).sort({_id:1}).limit(500)` on `activity-logs` returns in **330 ms**. Run 1 read `activity-logs` to 34M+ incrementally before the shard shutdown — reading 100M in one query never happens.
- **The stall is the migrator's convergence count.** `countWindowVsPg` runs an **exact `countDocuments({_cd …})` over the whole collection with no `maxTimeMS`**, at resume re-validation (before reads) and at the final gate. `activity-logs` has **no `_cd` index** (indexes: `_id, _sl,_og, _eh, createdAt, type, organization, account, …` — no `_cd`), so that count is a 100M collection-scan that hangs (`countDocuments(_cd filter)` → `MaxTimeMSExpired` at 20s in testing).

So `activity-logs` is blocked by an unbounded exact-count on a non-indexed field — a **fix on our side** (bound the convergence count / use `estimatedDocumentCount` for un-windowed runs / handle count timeout). It does **not** require action from MediCard.

---

## Impact / current state (verified)

- **82 of 83 collections migrated and verified.** The two smaller collections hit by the shutdown were re-run and passed verification:
  - `billing-invoice-agt`: Mongo 1,277,496 == PG 1,277,496 — verify **pass**.
  - `diagnostic-orders`: Mongo 3,168,386 == PG 3,168,386 — verify **pass**.
- **Outstanding: `activity-logs`** (~100.2M docs) — pending the migrator convergence-count fix above (ours), not the source.

---

## Ask of MediCard

1. **Confirm the 2026-08-04 ~00:17Z shard shutdown** on `mycure-stg-sh` — planned (maintenance/restore) or unplanned? (Atlas event log.) A quiescent window (no restores/maintenance) during the next backfill run avoids a repeat.
2. **Optional / minor:** an index on `_cd` for the very large collections would let our convergence counts run quickly, but the primary fix is on our side.
