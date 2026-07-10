# 2026-07-10 — Prod Cluster Key Vault Connectivity Revalidation (round 3)

**Status:** MediCard fixed the RBAC — the UAMI now has `Key Vault Secrets User` on the prod vault. Full read pipeline works end-to-end from inside the cluster. All three ExternalSecrets have synced (`hapihub-secrets`, `velero-credentials`, `minio-credentials`); the `minio-credentials` case was closed on our side by restructuring the s3proxy chart to mint its S3-side credential via ESO's `Password` generator (no external KV entry needed). Hapihub, s3proxy (fronting as `minio`), mycure, velero, and the node-agent DaemonSet are all 1/1 Running. The only remaining item is MediCard-side: velero's BackupStorageLocation is `Unavailable` because the `velero-backups` blob container does not exist in `sampseapmycurex01` yet — non-blocker for hapihub/s3proxy, only matters at first backup attempt.
**Environment under test:** Production AKS cluster `aks-mpi-sea-p-mycurex01`.
**Access path:** kubectl executed from `mc.remote.prd.bastion` via `ssh medicard.gateway`.
**Prior state:** see [`2026-07-10-prod-cluster-kv-connectivity-revalidation.md`](./2026-07-10-prod-cluster-kv-connectivity-revalidation.md) (round 2). Round 2 observed the RBAC `Forbidden` error immediately after DNS was fixed; MediCard's Khalid Bayabao confirmed the diagnosis and swapped the MI's role from `Key Vault Certificate User` to `Key Vault Secrets User`.

**Scope disclaimer.** Read-only diagnostic, same shape as rounds 1 and 2. Observations only; no prescriptions.

---

## 1. Scope

Third-round revalidation after MediCard's RBAC fix. Re-run Probe 2 (full read-lifecycle) to observe the pipeline from Azure AD auth → vault list → vault read. Additionally observe downstream: whether the ExternalSecrets successfully create the k8s Secrets, whether the previously-stuck workload pods come up, and identify any narrower failures that remain.

Strictly non-destructive.

## 2. Findings

### 2.1 Vault read pipeline — works end-to-end

Same `kv-probe` manifest as Appendix A2 of the round-1 report:

```
=== 1. az login via workload identity ===
login exit: 0

=== 2. list secrets in vault (names only) ===
medicard-prod-AUTH-SECRET
medicard-prod-azureblob-account-key
medicard-prod-azureblob-account-name
medicard-prod-database-uri
medicard-prod-enc-billing-invoices
medicard-prod-enc-billing-items
medicard-prod-enc-billing-payments
medicard-prod-enc-medical-records
medicard-prod-enc-personal-details
medicard-prod-mongo-source-uri
medicard-prod-pg-encryption-key
medicard-prod-pg-target-uri
sampseapmycurex01
count: 13

=== 3. read a representative sample (values redacted) ===
  medicard-prod-database-uri: postgresql://mycure_prod_app:[REDACTED]@mpiazeppgdb0003.postgres.database.azure.com:5432/postgres?sslmode=require
  medicard-prod-pg-target-uri: postgresql://mycure_prod_app:[REDACTED]@mpiazeppgdb0003.postgres.database.azure.com:5432/postgres?sslmode=require
  medicard-prod-auth-secret:   length=20 chars (opaque; value redacted)
  medicard-prod-azureblob-account-name: value='sampseapmycurex01' (account name is not sensitive)
  medicard-prod-azureblob-account-key:  length=88 chars (opaque; value redacted)
  medicard-prod-mongo-source-uri: mongodb+srv://stg_mycure_acct:[REDACTED]@mycure-stg-sh.q4trx.mongodb.net/admin?appName=mycure-stg-sh
  medicard-prod-pg-encryption-key:  length=20 chars (opaque; value redacted)
  medicard-prod-enc-medical-records: length=104 chars (opaque; value redacted)
```

Observations:
- List returned 13 entries — every MediCard-populated secret + the reserved name `sampseapmycurex01`.
- All eight sampled reads succeeded.
- Azure KV case-insensitivity confirmed operationally: the chart queries `medicard-prod-auth-secret` (lowercase) and receives the value stored under `medicard-prod-AUTH-SECRET` (uppercase).
- URI structural fragments match sheet-provided values (redacted here to keep the credential material out of the report).

### 2.2 ExternalSecret status

All three transitioned to Ready:

```
NAMESPACE   NAME                 STATUS         DETAIL
medicard    hapihub-secrets      SecretSynced   Secret created with 7 keys
medicard    minio-credentials    SecretSynced   Secret created with 4 keys
                                                (root-user, root-password,
                                                 azureblob-account, azureblob-key)
velero      velero-credentials   SecretSynced   Secret created with AZURE_STORAGE_ACCOUNT_ACCESS_KEY
```

`minio-credentials` was closed by a chart change: the s3proxy chart's ExternalSecret no longer looks up `medicard-prod-s3proxy-credential` from KV. Instead, a namespaced `Password` generator (from `generators.external-secrets.io/v1alpha1`) mints a 32-char alphanumeric value once at ExternalSecret creation, and `refreshInterval: 0` keeps that value stable across subsequent reconciles. The Azure Blob keys still come from KV — those are the only entries `minio-credentials` reads from MediCard's vault. No MediCard interaction was required for this change.

### 2.3 Downstream pod state

- **`mycure`** — 1/1 Running.
- **`hapihub`** — 1/1 Running. Pod logs show a real Postgres connection to `mpiazeppgdb0003`; the SQLite fallback is gone.
- **`minio`** (s3proxy fronting as `minio`) — 1/1 Running. S3 API is reachable at `http://minio.medicard.svc.cluster.local:9000`; hapihub's `STORAGE_S3_*` env vars point here.
- **`velero`** and **`node-agent-*`** — all 1/1 Running.

### 2.4 Velero BackupStorageLocation

```
NAME      PHASE         LAST VALIDATED   AGE
default   Unavailable   19s              3d1h

Status message:
BackupStorageLocation "default" is unavailable:
rpc error: code = Unknown desc = ContainerNotFound:
The specified container does not exist.
```

Velero can authenticate to the storage account (the account-key secret is now on the pod) and can reach `sampseapmycurex01` over the network, but the `velero-backups` container inside that account does not exist yet. Was flagged in §3.7 of the bootstrap report as "MediCard's message did not mention creating it". Not a blocker for hapihub / s3proxy; only bites once backups are attempted.

### 2.5 Summary table (rounds 1 → 2 → 3)

| Step | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| DNS: KV FQDN via CoreDNS | ❌ "No answer" | ✅ `172.22.26.6` | ✅ `172.22.26.6` |
| Auth: `az login` via workload identity | (blocked) | ✅ | ✅ |
| Read: `az keyvault secret list` | ❌ DNS | ❌ `Forbidden` (no assignment) | ✅ 13 entries |
| Read: `az keyvault secret show` | ❌ DNS | ❌ `Forbidden` | ✅ all sampled reads succeed |
| ExternalSecret `hapihub-secrets` | (not wired yet) | `SecretSyncedError` (403) | ✅ `SecretSynced` |
| ExternalSecret `velero-credentials` | ❌ (DNS) | ❌ (403) | ✅ `SecretSynced` |
| ExternalSecret `minio-credentials` | ❌ (DNS) | ❌ (403) | ✅ `SecretSynced` (Password generator + KV) |
| Workload pods: `mycure` | ✅ | ✅ | ✅ |
| Workload pods: `velero` + node-agents | ❌ Init | ❌ Init | ✅ 1/1 Running |
| Workload pods: `hapihub` (new RS) | ❌ CCCE | ❌ CCCE | ✅ 1/1 Running (PG connection to `mpiazeppgdb0003`) |
| Workload pods: s3proxy-as-`minio` | ❌ CCCE | ❌ CCCE | ✅ 1/1 Running |
| Velero BSL | (not deployed) | (blocked) | `Unavailable` — ContainerNotFound |

### 2.6 What we're reporting

The application layer is now green — hapihub, s3proxy, mycure, velero all running with real DB connectivity and real Azure Blob storage. One narrow, low-priority item remains:

- **MediCard-side**: the `velero-backups` blob container inside `sampseapmycurex01`. Was flagged in the bootstrap report; still not observed to exist. Non-blocker for hapihub/s3proxy/mycure. Only matters when a backup is attempted; velero's BackupStorageLocation stays `Unavailable` until the container exists.

## 3. Cluster-side artifacts left behind

**None.** The `kv-probe` was deleted after log capture. No secrets, ConfigMaps, PVCs, or NetworkPolicies were created. Only egress: DNS + HTTPS to Azure AD and the vault.

---

## Appendix — Environment fingerprint at time of test

- **Prod cluster:** `aks-mpi-sea-p-mycurex01`.
- **Prod vault:** `kv-mpi-sea-p-mycurex01.vault.azure.net`; resolves inside the cluster to `172.22.26.6`.
- **UAMI:** `appid=d6b958ed-790e-4a8a-9ce0-10aa6c0776b8` — now with role `Key Vault Secrets User` on the prod vault (per MediCard's 2026-07-10 fix; previously had `Key Vault Certificate User` which does not grant secret read).
- **Test date / time:** 2026-07-10 (Asia/Manila).
