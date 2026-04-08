# 2026-04-08 — Latest occurrence of the recurring Azure PG read-only incident

**Status:** Server auto-recovered within the observation window; migration has resumed on its own
**Environment:** `medicard-staging` (AKS cluster `aks-mpi-sea-a-mycurex01`)
**Target DB:** `mpiazeapgdb0002.postgres.database.azure.com` (Azure Postgres Flexible Server)
**Root cause:** See [`2026-03-12-azure-pg-recurring-readonly-storage-threshold.md`](./2026-03-12-azure-pg-recurring-readonly-storage-threshold.md) — this is the 11th+ occurrence of a month-long recurring pattern caused by Azure's 95%-storage auto read-only protection against what appears to be a 2 TB provisioned tier (vs the 4 TB the client reported).

> This report is a **situation log for today's occurrence**, not a root-cause investigation — that's already done in the consolidated report above. Scope: observations of the Azure PG server and the migration workload as seen from the cluster today.

---

## What was observed (cluster-side timeline, 2026-04-08)

- **~04:13Z:** hapihub-migrator pod started a fresh bulk run and began writing successfully.
- **~04:22Z:** Migration reached the `medical_records` table and had processed ~1.4M of ~29.2M rows with zero errors before the target server began rejecting writes.
- **~04:22Z onward:** All subsequent INSERTs against the target returned `sqlstate 25006 — cannot execute INSERT in a read-only transaction`. Same error class as every prior occurrence since 2026-03-12.
- **~04:27Z (first probe):** Direct `psql` probe against the target from an in-cluster one-shot pod, using the same `PG_TARGET_URI` secret the migrator uses, confirmed the server was in read-only state:

  ```
   in_recovery | tx_ro | def_ro
  -------------+-------+--------
   f           | on    | on
  ```

  `in_recovery=f` — not a replica, not in crash recovery. `tx_ro=on, def_ro=on` — the server is writable at the instance level but has `default_transaction_read_only` set, so every new transaction is born read-only. This is consistent with Azure's documented auto read-only state.

- **~05:28Z (second probe):** Repeated the same probe. Server had recovered to writable:

  ```
   in_recovery | tx_ro | def_ro | db_size
  -------------+-------+--------+---------
   f           | off   | off    | 1900 GB
  ```

  No pod restart, no `ALTER`, no intervention on our side between the two probes. The server cleared `default_transaction_read_only` on its own — consistent with Azure's internal recovery/reclamation cycle observed in prior incidents.

- **~05:28Z (migration side):** The migration resumed at `processed=1,955,000` on `medical_records` — a net gain of ~540k rows since the first probe ~60 minutes earlier. The workload bridged the read-only window without any cluster-side action.

Total duration of the read-only window, as bracketed by the two probes: ~60 minutes. The actual RO-to-writable transition happened somewhere inside that window; we did not probe continuously.

## Database size at the time of this occurrence

Measured directly against the target during the recovery probe:

```
pg_database_size('postgres') = 1900 GB
```

**This is 92.8% of a 2,048 GB (2 TB) provisioned tier** — right at the edge of Azure's documented 95% auto read-only threshold. The number is consistent (within growth since) with the 1,877 GB documented in the consolidated root-cause report for Apr 1–8 incidents, and confirms the 2 TB provisioning hypothesis from that report over the client's reported 4 TB figure.

If the server were actually provisioned at 4 TB as reported, 1,900 GB would be 46% utilization — nowhere near the threshold. Today's observation is another data point reinforcing the storage-tier discrepancy.

## Observations

1. **This is a recurrence, not a new incident.** The symptom (`sqlstate 25006`), the behavior (server-level `default_transaction_read_only=on` while `in_recovery=f`), the affected server, the database size range (1.87–1.90 TB sitting at 93–94% of 2 TB), and the auto-recovery pattern all match the month-long timeline in the consolidated report.

2. **The RO window on this occurrence was relatively short (~60 min or less).** Prior incidents in March and early April lasted long enough to require manual intervention to resume the migration; this one cleared on its own within the observation window. Whether this reflects faster Azure-side recovery, a shorter triggering event, or just the narrower observation window today is not determinable from cluster-side data alone.

3. **The target database grew ~23 GB between the 2026-04-06 occurrence (1,877 GB per consolidated report) and today (1,900 GB).** This is consistent with the migration making partial progress between incidents but being repeatedly knocked off course before it can drain the remaining ~197 GB of history tables.

4. **The migration's monotonic storage growth guarantees this will recur.** Unless storage is increased on the Azure side, every subsequent run will push the server closer to the 95% threshold and hit the same auto read-only state again — almost certainly before the two remaining history tables (`personal_details_history`, `medical_records_history`, ~197 GB) can finish. The consolidated report's projection of a ~2.1 TB final database size remains accurate and is above the 2 TB cap.

5. **No other workloads in `medicard-staging` were observably affected.** All other pods in the namespace remained `Running` throughout the window. The read-only state only blocks write transactions against the target DB; the rest of the cluster (cert-manager, gateway, ArgoCD, the other data services, hapihub/mycure/cadence) is decoupled from this target and was unaffected.

## What should happen next (infra/cluster side)

None of the below fix the root cause — that's client/Azure side and is detailed in the consolidated report. These are observation and hedging tasks only.

1. **Continue the current run.** It is actively progressing, no intervention needed.
2. **Probe the target again if the migration stalls for more than ~20 minutes continuously** to distinguish "server is still in the auto-RO state" from any other failure mode. The command for this is in the consolidated report's triage section (and in prior incidents) and only requires the `PG_TARGET_URI` secret that's already in the namespace.
3. **Record the next occurrence's onset time, recovery time, and database size** on the timeline in the consolidated report. The cadence and duration trend of these events is useful data for the client-side storage conversation.
4. **Escalate if the next occurrence does not auto-recover within ~60 minutes.** Prior incidents have cleared on their own; a sustained read-only state would indicate Azure's auto-recovery is no longer keeping up with the growing database, and the migration cannot continue without a manual storage increase.

## References

- **Consolidated root cause and full incident history:** [`reports/2026-03-12-azure-pg-recurring-readonly-storage-threshold.md`](./2026-03-12-azure-pg-recurring-readonly-storage-threshold.md) — authoritative document for this incident class.
