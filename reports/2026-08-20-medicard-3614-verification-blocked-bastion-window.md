# #3614 Index-Enhancements Verification — Blocked by Prod Bastion Auto-Shutdown

**Issue:** [mycurelabs/monobase-mycure#3614](https://github.com/mycurelabs/monobase-mycure/issues/3614) (ffup of #2774)
**Goal:** Verify that MediCard's `azure.extensions` allow-list change actually took effect on prod PG — i.e. the extensions are installed and the previously-stranded performance indexes got built.
**Status:** **Verification blocked** — the sole access path to prod PG (the AKS bastion) is deallocated outside its daily up-window.
**Date:** 2026-08-20

---

## What MediCard did (confirmed)

On 2026-08-20 MediCard reported the `azure.extensions` allow-list request is done. Their portal screenshots (issue #2774 comment `5350254082`) show, on server **`mpiazeppgdb0003`** → Server parameters → `azure.extensions` = **"4 selected"**:

- **PG_STAT_STATEMENTS** ✅
- **PG_TRGM** ✅
- **PGCRYPTO** ✅
- **VECTOR** ✅

This is exactly the ask from `reports/2026-07-31-azure-pg-extension-allowlist-blocking-search-perf.md`. **The allow-list itself is correct and complete.**

## Why the allow-list alone does not close #3614

The `azure.extensions` param only *permits* `CREATE EXTENSION`; it installs nothing. The extensions and the stranded indexes are created by hapihub's **`pg-concurrent-migrator`, which runs only on pod boot**. Its run loop aborts on the first failed index build (`throw`), and previously died at entry **`0073`** (`CREATE EXTENSION pg_trgm` was refused → the `gin_trgm_ops` index build threw), stranding entries `0074`–`0080`.

So the change only takes effect after a **hapihub restart**. Verification must therefore be done **against the database**, checking:

1. `pg_extension` actually contains `pg_trgm`, `vector`, `pg_stat_statements` (+ existing `pgcrypto`).
2. These indexes exist **and `indisvalid = t`**:
   - `0073`: `idx_personal_details_firstname_trgm`, `idx_personal_details_lastname_trgm`, `idx_medical_patients_external_id_trgm`
   - `0080`: `idx_billing_items_facility_created_at`, `idx_diagnostic_order_tests_facility_type_for_confirmation`
   - (plus the stranded `0074`/`0075`/`0079` entries)
3. `EXPLAIN` confirms patient search + worklist count + census list are index-served, not seq-scan.

Ready-to-run read-only SQL staged at `/tmp/verify-3614.sql`.

### Known risk to check (do not assume "search fixed")

Migrator `0073` builds trgm indexes on **raw** `name->>'firstName'` / `lastName`, but the deployed search filters `name->>'firstNameNormalized'` (lowercased). A trgm GIN on the raw column **cannot** serve a predicate on the normalized column, so **patient-name search (#2774 item 1) may still seq-scan even after the unblock** — this was flagged as an app-side follow-up on 2026-07-31 and has no corrective migration as of hapihub main. The worklist/census 504s (`0080`) *are* expected to be genuinely fixed. Step 4 of the staged SQL tests both columns to settle this.

---

## The blocker (verified, with proof)

Prod PG = Azure Flexible Server `mpiazeppgdb0003`, reachable **only** from inside the AKS VNet (Azure Private Link). The single documented path is:

```
laptop --(VPN)--> medicard.gateway --> mc.remote.prd.bastion (172.23.4.8) --> kubectl exec (ns medicard) --> PG
```

`mc.remote.prd.bastion` is on an Azure start/stop schedule: **auto-start ~23:00 UTC, auto-shutdown 00:10 UTC → up only ~1h/day**. Outside that window the VM is deallocated.

**Probe, 2026-08-20 02:04:55 UTC** (≈2h after shutdown, ≈21h before next start):

```
# Hop 1 — gateway (VPN): UP
$ ssh medicard.gateway 'hostname; date -u'
medicard
gw_utc=02:04:55

# Hop 2 — bastion, from the gateway (same VNet): DOWN
$ ssh mc.remote.prd.bastion 'hostname'
ssh: connect to host 172.23.4.8 port 22: Connection timed out   (exit 255)

# TCP/22 + ICMP to the bastion, from the gateway:
TCP22_CLOSED_OR_TIMEOUT
2 packets transmitted, 0 received, 100% packet loss
```

100% ICMP loss **from inside the network** + TCP/22 timeout = the VM is **deallocated (stopped)**, not merely an sshd/service issue. VPN and gateway are healthy. This matches the documented daily deallocation, not a crash. (See `reports/2026-08-02-medicard-prod-bastion-jumphost-outage.md`.)

---

## Next steps

1. **Wait for the up-window (~23:00 UTC)** — or have MediCard start / widen the bastion schedule — then run `/tmp/verify-3614.sql` via the hapihub-pod python client (`kubectl -n medicard get pod -l app=hapihub`, read-only).
2. **If extensions are still absent** (no restart happened since the allow-list change): rollout-restart the hapihub deployment to trigger the migrator, then re-verify. *(Pre-authorized for this specific condition.)*
3. Post the confirmed results (extensions installed, indexes valid, EXPLAIN plans) to #3614, and — if the raw-vs-normalized trgm mismatch is confirmed — file the app-side index-column correction as a follow-up.

**Bottom line:** MediCard's part (the 4-extension allow-list) is done and correct. It cannot be confirmed *effective* until (a) hapihub has restarted since the change and (b) we read the DB — and (b) is unreachable until the bastion's next up-window.
