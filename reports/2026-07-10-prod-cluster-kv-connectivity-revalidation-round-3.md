# 2026-07-10 — Prod Cluster Key Vault Connectivity Revalidation (round 3)

**Status:** MediCard fixed the RBAC — the UAMI now has `Key Vault Secrets User` on the prod vault. Full read pipeline works end-to-end from inside the cluster. Two of three ExternalSecrets have synced (`hapihub-secrets`, `velero-credentials`); the third (`minio-credentials`) fails on a KV entry that is on **our** side to populate. Velero pod is now 1/1 Running, but the BackupStorageLocation is `Unavailable` because the `velero-backups` blob container does not exist in the storage account yet. Hapihub and s3proxy pods remain stuck at `CreateContainerConfigError` waiting for the `minio` Secret to be created — that unblocks once the third KV entry lands.
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

Two of three transitioned to Ready; the third fails on a downstream, well-scoped issue:

```
NAMESPACE   NAME                 STATUS               DETAIL
medicard    hapihub-secrets      SecretSynced         Secret created with 7 keys
velero      velero-credentials   SecretSynced         Secret created with AZURE_STORAGE_ACCOUNT_ACCESS_KEY
medicard    minio-credentials    SecretSyncedError    "error retrieving secret at .data[2],
                                                       key: medicard-prod-s3proxy-credential,
                                                       err: Secret does not exist"
```

The `minio-credentials` failure is not on MediCard's side. This KV entry is the internal-to-cluster S3-side credential that our chart is set up to consume — it was called out in earlier reports as "Owner: us. No MediCard dependency." The vault does not contain it because we have not created it yet.

### 2.3 Downstream pod state

- **`mycure`** — 1/1 Running (unchanged, no secret deps).
- **`velero-*`** and **`node-agent-*`** — all 1/1 Running (velero-credentials sync unblocked the entire velero namespace).
- **`hapihub-*`** — new ReplicaSet's pod still `CreateContainerConfigError` with `secret "minio" not found`. Hapihub's Deployment references both `hapihub-secrets` (now exists) and the `minio` Secret (does not — see §2.2).
- **`minio-*`** (s3proxy fronting as `minio`) — same `CreateContainerConfigError`, same root cause (`minio` Secret does not exist).

The `hapihub-bb87dcc4c-*` pod that shows `1/1 Running` is a rollout artefact from a previous ReplicaSet — the one that was briefly on the SQLite fallback back when `hapihub.minio.enabled` was temporarily off. It is not the current desired state; do not treat that lingering Running pod as a working deploy.

Both `hapihub` and s3proxy-as-`minio` come up 1/1 the moment the `minio` k8s Secret is created — that's one action away.

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
| ExternalSecret `minio-credentials` | ❌ (DNS) | ❌ (403) | ❌ `SecretSyncedError` (our KV entry missing) |
| Workload pods: `mycure` | ✅ | ✅ | ✅ |
| Workload pods: `velero` + node-agents | ❌ Init | ❌ Init | ✅ 1/1 Running |
| Workload pods: `hapihub` (new RS) | ❌ CCCE | ❌ CCCE | ❌ CCCE (waiting on `minio` Secret) |
| Workload pods: s3proxy-as-`minio` | ❌ CCCE | ❌ CCCE | ❌ CCCE (waiting on `minio` Secret) |
| Velero BSL | (not deployed) | (blocked) | `Unavailable` — ContainerNotFound |

### 2.6 What we're reporting

Two narrow items remain to close out the deploy. They are independent:

- **Our-side**: `medicard-prod-s3proxy-credential` needs to be created. This is the S3-side identity that s3proxy (fronting as `minio`) uses; we've always framed it as our responsibility to mint. Two paths: put a random 32-char value into the KV under that name (requires KV `Secrets Officer` role for us on the vault, which we don't currently have), or restructure the s3proxy chart's ExternalSecret to source that value from an ESO password generator instead of a KV read. When the `minio` Secret is created by ESO, both hapihub and s3proxy come up 1/1 without further intervention.
- **MediCard-side**: the `velero-backups` blob container inside `sampseapmycurex01`. Was flagged in the bootstrap report; still not observed to exist. Non-blocker for hapihub/s3proxy. Only matters when a backup is attempted.

## 3. Cluster-side artifacts left behind

**None.** The `kv-probe` was deleted after log capture. No secrets, ConfigMaps, PVCs, or NetworkPolicies were created. Only egress: DNS + HTTPS to Azure AD and the vault.

---

## Appendix — Environment fingerprint at time of test

- **Prod cluster:** `aks-mpi-sea-p-mycurex01`.
- **Prod vault:** `kv-mpi-sea-p-mycurex01.vault.azure.net`; resolves inside the cluster to `172.22.26.6`.
- **UAMI:** `appid=d6b958ed-790e-4a8a-9ce0-10aa6c0776b8` — now with role `Key Vault Secrets User` on the prod vault (per MediCard's 2026-07-10 fix; previously had `Key Vault Certificate User` which does not grant secret read).
- **Test date / time:** 2026-07-10 (Asia/Manila).
