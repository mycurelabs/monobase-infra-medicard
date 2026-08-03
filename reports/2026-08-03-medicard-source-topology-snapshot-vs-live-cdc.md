# 2026-08-03 — MediCard migration source topology: snapshot-restore model vs live replication (and what it means for CDC)

**Scope:** How MediCard feeds the migration source, why our live CDC (Mongo→PG) cannot work as designed on it, the accepted operating model, and the alternative if a live PG mirror is ever required.
**Status:** Decision recorded — **keep the snapshot-restore model** (accepted 2026-08-03). This document is the reference for its consequences.
**Related:** `2026-08-02-cdc-changestream-oplog-break.md` (the CDC outage this topology caused), `2026-08-02-medicard-prod-bastion-jumphost-outage.md`.

---

## TL;DR

MediCard populates our migration source (`mycure-stg-sh`) by **restoring point-in-time snapshots of prod** into it — not by live replication. Two consequences follow directly:

1. **The source is frozen between restores.** It holds prod-as-of-the-last-snapshot and receives no live writes. Our PG target can therefore only ever be as current as the last restore.
2. **Live CDC cannot function on it.** A change stream needs a live oplog to tail; a snapshot-restored source produces no ongoing changes to stream, and each restore *rolls the oplog*, which kills any running change stream (`ChangeStreamFatalError` — the 2026-07-30 break).

**Accepted model:** keep snapshot restores; after each restore, run a **bulk re-migrate** to bring PG up to that snapshot. CDC is not the sync mechanism under this model. PG is a point-in-time copy, refreshed per restore — not a live mirror.

---

## The two clusters

| Cluster | Role | Fed how | Liveness |
|---|---|---|---|
| `mycure.q4trx.mongodb.net` (`mycure`) | MediCard **live prod** (app writes here; used by `mc.remote.prd.api`) | Live application traffic | Live — writing continuously |
| `mycure-stg-sh.q4trx.mongodb.net` (`mycure-stg-sh`, "stg MYCURE") | **Our migration source** (migrator `MONGO_SOURCE_URI` / CDC read from here) | **Periodic Atlas snapshot restore from prod** | **Frozen** between restores |

Our migrator + CDC read **`mycure-stg-sh`**, never prod directly.

---

## Evidence the source is a frozen snapshot, not live (2026-08-03)

Latest record-creation time (`_cd`) per cluster:

| Collection | source `mycure-stg-sh` | live prod `mycure` |
|---|---|---|
| medical-encounters newest `_cd` | **2026-07-29 20:57:31 UTC** | **2026-08-03 02:56:25 UTC** (live) |

The source's newest data is ~5 days old and static; prod is writing in real time. MediCard's 2026-07-30 restore (Atlas: Entire Snapshot, PIT 07-30 05:04 AM, completed 07-30 09:02 PM) is what set the source to this frozen state. The ~0.2% count gap measured on 08-02 between source and prod is exactly this 07-30→now delta, not replication lag.

---

## Why live CDC does not work on a snapshot-restored source

Our CDC collector opens a MongoDB **change stream** (`db.watch()`) on the source and tails its oplog, forwarding each insert/update/delete to PG. That design assumes the source is *live*. Under the snapshot-restore model:

1. **Nothing to stream between restores.** The source receives no application writes, so the change stream emits ~no events. PG cannot "auto-update as data comes" because no data comes to the source.
2. **Each restore breaks the stream.** A snapshot restore replaces the cluster's data wholesale — a massive oplog churn that scrolls past the CDC resume token. The collector then fails with `ChangeStreamFatalError` (oplog window exceeded) and, by design, refuses to skip the gap. This is the 2026-07-30 outage. It cannot self-recover; it needs a fresh bulk + CDC reset.
3. **So CDC is not the sync path here.** On this topology CDC is at best a no-op (idle source) and at worst a recurring outage (broken by every restore). The real sync path is the **bulk migrate**, run once per restore.

---

## Accepted operating model — snapshot restore + bulk re-migrate

Each time MediCard restores a new prod snapshot into `mycure-stg-sh`:

1. **Stop CDC** — `kubectl -n medicard scale deploy hapihub-migrator-cdc --replicas=0` (it will be crash-looping on the dead token anyway).
2. **Reset the CDC changelog meta** — clear the `_migration_changelog_meta` collector row so any later CDC start opens fresh (`resumeFrom: now`).
3. **Bulk re-migrate** — trigger Job from CronJob `hapihub-migrator` with `CONFLICT_ACTION=nothing` (backfill; insert new rows only, no rewrite/history bloat) and `SKIP_SCHEMA_INIT=true`. Idempotent, `_id`-preserving. This brings PG up to the new snapshot.
4. **Reconcile** — compare per-collection counts source vs PG against the previous baseline.
5. **CDC** — optional. On a static source it captures nothing; leaving it scaled to 0 is fine. (If left running it will simply sit idle until the next restore breaks it.)

### Consequences to accept under this model
- **PG is a point-in-time copy, never live.** It reflects the last restore's PIT; all prod activity since is absent until the next restore + re-migrate.
- **Freshness = restore cadence.** If MediCard restores weekly, PG is up to a week stale. There is no continuous convergence.
- **Every restore is a manual operation on our side** (steps 1–4) and requires cluster access via the prod jump host (note its own availability constraints — see the bastion report).
- **No "cutover to live" is possible from this source** without switching topology (below). A go-live that assumes PG mirrors prod in real time is not achievable on snapshot restores.

---

## Alternative (not chosen) — live prod → stg replication

If MediCard ever needs the new PG system to stay **continuously current** (e.g., for a real cutover), the source must be *live*. Two ways:

- **A. Continuous replication prod → stg.** MediCard replaces periodic snapshot restores with live cluster-to-cluster replication (e.g., `mongosync`) into `mycure-stg-sh`. The source then has a live oplog, our CDC change stream streams changes in real time, PG converges continuously, and restores no longer break CDC. Keeps prod-load isolation (we still read stg). MediCard-side change.
- **B. Point the migrator at live prod (`mycure`) directly.** We read + CDC against the prod oplog itself. Simplest to make CDC work; but adds read load to prod and requires MediCard's OK, network path from our cluster to the prod cluster, and the same field-encryption keys.

Under either A or B, the operating model flips: **bulk once, then CDC carries forward live** — the design CDC was built for. Both require an oplog/retention window large enough to cover CDC's worst-case downtime, and (for A) no collection drops during replication.

**Trigger to revisit:** any requirement that PG be less than one restore-cycle stale, or an actual production cutover to the PG/v11 backend.

---

## Current state (2026-08-03)

- Source restored to the 07-30 snapshot; PG being brought up to it by bulk heal Job `hapihub-migrator-heal-20260803` (`CONFLICT_ACTION=nothing`), ~30% through `medical_records` at time of writing.
- CDC deployment scaled to 0.
- Decision: **snapshot model retained.** After the heal completes, PG = prod-as-of-07-30; it will remain there until MediCard's next restore, after which we re-run the bulk heal.
