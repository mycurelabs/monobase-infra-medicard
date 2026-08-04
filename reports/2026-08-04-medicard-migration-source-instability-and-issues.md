# 2026-08-04 — MediCard migration source: shard-node shutdown during backfill

**Scope:** A source-side (`mycure-stg-sh`) event that interrupted the PG backfill on 2026-08-04. Each claim states how it was verified so MediCard can independently re-check.
**Environment:** cluster `aks-mpi-sea-p-mycurex01`, namespace `medicard`; source Atlas `mycure-stg-sh.q4trx.mongodb.net` (sharded — `isdbgrid`).
**Related:** `2026-08-02-cdc-changestream-oplog-break.md` (snapshot restore rolled the oplog → CDC break), `2026-08-03-medicard-source-topology-snapshot-vs-live-cdc.md` (source is a frozen snapshot, not live).

---

## Shard-node shutdown mid-migration → 3 collections' reads failed (2026-08-04 ~00:17Z)

A bulk migration completed 80 of 83 collections, then a source shard node went down while reads were in flight.

- **Verified — the migrator's per-collection error records:**
  - `activity-logs` → `Error on remote shard atlas-k97n6n-shard-01-01.q4trx.mongodb.net:27017 :: caused by :: interrupted at shutdown`
  - `billing-invoice-agt` → `Error on remote shard atlas-k97n6n-shard-00-02 :: interrupted at shutdown`
  - `diagnostic-orders` → `Cursor not found (id: 2089281964639564606)`
- **What this proves:** `interrupted at shutdown` is MongoDB error **11600 (InterruptedAtShutdown)** — emitted by the MongoDB server when a node is shutting down. It is a source-cluster event, not a client/network fault on our side.
- **Re-verify:** `SELECT collection,status,error FROM _migration_checkpoints WHERE run_id=(SELECT run_id FROM _migration_checkpoints ORDER BY started_at DESC LIMIT 1) AND status<>'completed';`

---

## Current state (verified)

- **82 of 83 collections migrated and verified.** The two smaller collections hit by the shutdown were re-run and passed verification:
  - `billing-invoice-agt`: Mongo 1,277,496 == PG 1,277,496 — verify pass.
  - `diagnostic-orders`: Mongo 3,168,386 == PG 3,168,386 — verify pass.
- `activity-logs` (~100.2M docs) is not yet migrated; being completed on our side.

---

## Ask of MediCard

Confirm whether the 2026-08-04 ~00:17Z shard shutdown on `mycure-stg-sh` was **planned** (maintenance / a snapshot restore in progress) or **unplanned** — visible in the Atlas cluster event/maintenance log. A quiescent window (no restores/maintenance in progress) during the next backfill run avoids a repeat.
