# 2026-04-13 — hapihub-migrator OOM on final collection + missing encryption keys for billing tables

**Status:** Partially resolved — encryption keys added (billing-items now migrating), OOM on diagnostic-order-tests-history mitigated but not fully resolved
**Environment:** `medicard-staging` (AKS cluster `aks-mpi-sea-a-mycurex01`)
**Migrator version:** `ghcr.io/mycurelabs/hapihub-migrator:3.7.5`

---

## Context

Following the resolution of the Azure PG read-only storage issue (see [`2026-04-10-azure-pg-readonly-sustained-crashloop.md`](./2026-04-10-azure-pg-readonly-sustained-crashloop.md)), the target database became writable again after the client's storage upgrade to 4 TB. The migrator resumed and made significant progress — completing the remaining Phase 1–4 collections and three of the four Phase 5 history tables (including the large `personal-details-history` at 38M rows).

However, the migration then **stopped** due to two new issues:

1. The migrator pod was being **OOM-killed** (exit code 137) every time it reached the `diagnostic-order-tests-history` collection — the last remaining collection in Phase 5. The previous memory limit (16 Gi) was insufficient for this collection's cursor load.
2. The `billing-items` collection in Phase 3 had been **failing** due to encryption secrets that had not yet synced to the cluster, with all encrypted documents counted as errors.

At the time of investigation, **81 of 83 collections were fully migrated (97.6% by collection count)** — but the migration was not continuing. The pod was in CrashLoopBackOff, restarting every ~5 minutes. Each restart scanned all prior collections as "Already completed," then hit one of the two blockers and exited without making progress.

---

## Issue 1: OOM on `diagnostic-order-tests-history`

### Observed behavior

The migrator pod follows a consistent pattern each restart:

1. Starts up, connects to PostgreSQL and MongoDB.
2. Scans all 83 collections — 79 report "Already completed, skipping."
3. Reaches `diagnostic-order-tests-history` in Phase 5, begins resuming from its last checkpoint (533,000 rows processed so far).
4. Memory climbs rapidly during the initial MongoDB cursor load for this collection.
5. Pod is killed by the OOM killer within ~60–70 seconds of reaching the collection.
6. Kubernetes restarts the pod. Repeat.

Each cycle makes minimal forward progress (~500 rows per restart) via the checkpoint mechanism before being killed.

### Termination evidence

```
reason: OOMKilled
exitCode: 137
startedAt: 2026-04-13T00:54:23Z
finishedAt: 2026-04-13T00:55:30Z   (~67 seconds)
```

### Memory profile observed

The pod's memory consumption was observed climbing from ~10 GB to ~21 GB within 30 seconds of reaching the `diagnostic-order-tests-history` resume query. The growth rate (~350 MB/sec) is consistent with a large MongoDB cursor being decoded and buffered in-process rather than streamed.

### Resolution (partial)

The Kubernetes Deployment spec for `hapihub-migrator` had its resource limits updated:

```yaml
resources:
  requests:
    cpu: 200m
    memory: 1Gi
  limits:
    cpu: "1"
    memory: 32Gi    # was: 16Gi
```

After the update, the pod was restarted. With the higher limit, the pod survived past the previous OOM point and successfully processed one batch before hitting a connection-level error (`"Connection terminated unexpectedly"`), followed by memory continuing to climb toward the new 32 Gi ceiling.

**Current status:** The memory limit increase extends the pod's lifespan per restart cycle, allowing it to process more rows before being killed. Combined with the migrator's checkpoint mechanism (which persists progress across restarts), the migration makes forward progress incrementally — ~500 rows per cycle. Since this is a one-time migration operation, this brute-force approach is acceptable. The collection will complete over repeated restart cycles without manual intervention.

### Node capacity

The AKS node (`aks-newpool-16889436-vmss00000l`) has approximately 31 GB of allocatable memory. The 32 Gi limit is effectively the maximum for this node size. If faster completion is desired, the node pool could be scaled to a larger VM SKU to allow a higher memory limit — this would let the migrator process more rows per cycle (or potentially complete the collection in a single pass), but is not strictly necessary given that the checkpoint-and-restart approach will eventually complete on its own.

---

## Issue 2: Missing encryption keys for billing collections

### Observed behavior

The `billing-items` collection was failing with:

```
error: "Error rate 1.0% exceeds max 1%"
processed: 535,500 / totalEstimate: 6,750,811
errors: 5,500
```

Every error was:

```
"Document has _eh (encrypted) but no encryption key provided — counting as error"
```

The migrator uses **per-collection encryption keys** (not a single global key) to decrypt documents that were encrypted at rest in the source MongoDB. Five collections require encryption keys, each configured via a dedicated environment variable sourced from a Kubernetes secret:

| Collection | Env var | Secret key |
|---|---|---|
| personal-details / personal-details-history | `ENC_PERSONAL_DETAILS` | `enc-personal-details` |
| medical-records / medical-records-history | `ENC_MEDICAL_RECORDS` | `enc-medical-records` |
| billing-invoices | `ENC_BILLING_INVOICES` | `enc-billing-invoices` |
| billing-items | `ENC_BILLING_ITEMS` | `enc-billing-items` |
| billing-payments | `ENC_BILLING_PAYMENTS` | `enc-billing-payments` |

### Root cause

The Kubernetes secret `hapihub-migration-secrets` had not fully synced — two of the five encryption keys were missing from the cluster-side secret:

| Secret key | Status |
|---|---|
| `enc-personal-details` | Synced |
| `enc-medical-records` | Synced |
| `enc-billing-invoices` | Synced |
| **`enc-billing-items`** | **Not synced** |
| **`enc-billing-payments`** | **Not synced** |

The three billing collections (`billing-invoices`, `billing-items`, `billing-payments`) share the same encryption key material. `billing-invoices` worked because its key had synced; the other two had not yet been pulled into the cluster secret.

### Resolution

The external secret sync was triggered and the sync frequency was updated to prevent recurrence. The migrator pod was restarted to pick up the now-available keys.

After the restart, `billing-items` immediately began migrating with **errors: 0**, confirming the encryption keys are now synced and documents are being decrypted and inserted successfully. At time of writing, `billing-items` was progressing at ~5,000 rows/sec through 6,750,933 total rows.

---

## Current migration state (as of 2026-04-13 ~01:15Z)

| Phase | Collections | Status |
|---|---|---|
| Phase 1 | 8 / 8 complete | All done |
| Phase 2 | 19 / 19 complete | All done |
| Phase 3 | 12 / 13 complete | `billing-items` now actively migrating (was blocked by missing key) |
| Phase 4 | 40 / 40 complete | All done |
| Phase 5 | 3 / 4 complete | `diagnostic-order-tests-history` blocked by OOM |

**Active:** `billing-items` — 735,000 / 6,750,933 rows, errors: 0, ~5k rows/sec
**Blocked:** `diagnostic-order-tests-history` — 533,000 rows processed via checkpointing, OOM-killed on each attempt

The migration is **no longer stopped.** After the resource limit update and encryption key sync, the migrator resumed active progress. Once `billing-items` completes (~20 minutes at current rate), the migrator will proceed through the remaining Phase 3–4 collections (all "Already completed") and reach `diagnostic-order-tests-history` in Phase 5, where it will continue making incremental progress via the checkpoint-and-restart approach.

---

## Recommendations

### For the OOM issue

No immediate action required. The migration is a one-time operation and the checkpoint-and-restart approach will complete `diagnostic-order-tests-history` without manual intervention, just slowly. If faster completion is desired, scaling the node pool to a larger VM SKU (e.g., 64 GB) would allow a higher memory limit and potentially let the collection complete in a single pass.

### For the encryption keys

The sync frequency for the external secret store has been updated. All five encryption keys are now confirmed present in the cluster secret. No further action needed unless the secret is recreated or the ExternalSecret resource is redeployed — in that case, verify all five keys are synced before restarting the migrator.

---

## References

- **Azure PG read-only incident (resolved):** [`reports/2026-04-10-azure-pg-readonly-sustained-crashloop.md`](./2026-04-10-azure-pg-readonly-sustained-crashloop.md)
- **Root cause for the read-only pattern:** [`reports/2026-03-12-azure-pg-recurring-readonly-storage-threshold.md`](./2026-03-12-azure-pg-recurring-readonly-storage-threshold.md)
