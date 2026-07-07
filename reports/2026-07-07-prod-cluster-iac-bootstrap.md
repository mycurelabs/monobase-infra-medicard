# 2026-07-07 — Prod Cluster IaC Bootstrap

**Status:** ArgoCD + all infrastructure Applications deployed. Monitoring (Prometheus + Grafana + Alertmanager + Loki + Promtail) is green. Application-layer workloads (hapihub, s3proxy, velero) are queued on a single upstream blocker: the ExternalSecrets operator can't authenticate to Azure Key Vault, so the Secrets those pods depend on are never created. Mycure and the migrator scaffold are green.
**Environment under test:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia, Private Link API).
**Access path:** all `kubectl` / `helm` from operator jumphost `mc.remote.prd.bastion` via `ssh medicard.gateway`.
**Prior state:** see [`2026-07-07-prod-cluster-database-connectivity-validation.md`](./2026-07-07-prod-cluster-database-connectivity-validation.md) — cluster held only system namespaces at start of this run.

---

## 1. Scope

Deploy the MediCard IaC end-to-end into the empty PROD cluster: install ArgoCD, wire GitOps auto-discovery, let ArgoCD reconcile all infrastructure + application charts to the desired state. Migration itself stays gated (`hapihubMigrator.replicaCount: 0`) — this deploy is IaC only, not a data cutover.

This is a **mutating** run: workloads, namespaces, secrets, and CRDs are created and left in place. Contrast with the read-only connectivity probes in prior reports.

## 2. On-cluster state

### 2.1 ArgoCD Applications

```
NAME                          REV      SYNC      HEALTH
envoy-gateway                 v1.2.0   Synced    Healthy
envoy-proxy-config            main     Synced    Healthy
external-secrets              0.9.11   Synced    Healthy
external-secrets-stores       main     Synced    Degraded    ← see §3.1
gateway-resources             main     Synced    Healthy
grafana                       main     Synced    Healthy
infrastructure                main     Synced    Healthy
loki                          6.24.0   Synced    Healthy
medicard-hapihub              main     Synced    Progressing ← see §3.2
medicard-hapihub-migrator     main     Synced    Healthy     (0/0 replicas — paused)
medicard-mycure               main     Synced    Healthy     (1/1 Running)
medicard-namespace            main     Synced    Healthy
medicard-root                 main     Synced    Healthy
medicard-s3proxy              main     Synced    Degraded    ← see §3.2, §3.6
medicard-security-baseline    main     Synced    Healthy
monitoring                    11.3.9   Synced    Healthy
monitoring-resources          main     Synced    Healthy
promtail                      6.16.6   Synced    Healthy
velero                        12.0.1   Synced    Progressing ← see §3.2
velero-resources              main     Synced    Degraded    ← see §3.7
```

### 2.2 Namespaces

`argocd`, `envoy-gateway-system`, `external-secrets-system`, `gateway-system`, `medicard`, `monitoring`, `velero` (7 total). Prior 5 system namespaces untouched.

## 3. Findings

### 3.1 ExternalSecrets provider = InvalidProviderConfig (upstream blocker)

Sheet row 5.b.iii ("No **separate** user-assigned mi for ExternalSecrets at this moment") and 5.b.v ("access policies naka set sya as role-based access(IAM)(RBAC)") point at reusing the same UAMI staging uses. Tenant confirmed same in 5.b.ii. Under that reading, the annotation is on our side, not something we're waiting on MediCard for. Applied and persisted in `values/infrastructure/main.yaml` under `externalSecrets.serviceAccountAnnotations`:

```
azure.workload.identity/client-id: d6b958ed-790e-4a8a-9ce0-10aa6c0776b8
azure.workload.identity/tenant-id: 31e62360-d307-45a7-932a-f774aa7a6288
```

That progressed the reconciler past the "missing SA annotation" error and produced a new one from Azure AD:

```
AADSTS700211: No matching federated identity record found for
presented assertion issuer
'https://southeastasia.oic.prod-aks.azure.com/31e62360-d307-45a7-932a-f774aa7a6288/b0819550-15a3-4697-9db7-44b573833866/'.
```

Reading:
- Azure AD recognises the UAMI as an identity in the shared tenant.
- The UAMI's Federated Identity Credential does NOT list the prod cluster's OIDC issuer (the URL Azure printed above).
- Vault RBAC couldn't be tested yet — the request never reached the vault.

**What we need to observe on MediCard's side to unblock this** (mechanism and process on their side are out of scope for us):

- A federated identity credential on the UAMI whose issuer matches the URL Azure returned above, whose subject matches `system:serviceaccount:external-secrets-system:external-secrets`, and whose audience is `api://AzureADTokenExchange`. When that credential exists, this error goes away.
- Once the federation error clears, we'll observe whether the next call succeeds or returns a vault-side "Forbidden" — the latter would indicate the UAMI still needs read access on `kv-mpi-sea-p-mycurex01` (5.b.v says RBAC is set; this would falsify that).

If instead MediCard intended a different identity than the staging UAMI (i.e. our reading of 5.b.iii is wrong), the alternative is to swap the ClusterSecretStore's `authType` to the mode matching whatever identity they intend and revert the SA annotation. Either way, we're now one narrow, single-error question away from Ready.

Once resolved, §3.2 unblocks.

### 3.2 Application pods

- **`hapihub`** — pod in `CreateContainerConfigError`. The Deployment references a k8s Secret (`hapihub-secrets` for DATABASE_URI / AUTH_SECRET / etc., and `minio` for its S3 client) which the ExternalSecrets operator can't create until §3.1 clears.
- **`s3proxy`** — pod in `CreateContainerConfigError`, same root cause: the k8s Secret it reads (which also happens to be named `minio` — see §3.5 for why) isn't there because ESO can't sync it.
- **`velero`** — pod in `Init` waiting on `MountVolume.SetUp failed for volume "cloud-credentials" : secret "velero-credentials" not found`. Same root cause — ESO can't sync the `velero-credentials` Secret because §3.1. See §3.7.
- **`mycure`** — 1/1 Running. No external-secret dependency; unaffected.
- **`hapihub-migrator`** — 0/0 replicas as designed. Present in cluster; requires an explicit config change on our side to un-pause once data-cutover time comes.

`hapihub`, `s3proxy`, and `velero` all come up together the moment §3.1 clears and the KV entries in §3.4 land — one blocker unblocks all three.

### 3.3 Envoy LoadBalancer internal IP: `172.22.40.10`

Azure auto-allocated `172.22.40.10` from the AKS subnet `subnet-p-mycurex-aks01-172.22.40.0/22`:

```
NAMESPACE              NAME                                              TYPE          EXTERNAL-IP    PORT(S)
envoy-gateway-system   envoy-gateway-system-shared-gateway-0457b32d      LoadBalancer  172.22.40.10   80:31335/TCP
```

Gateway `shared-gateway` in `gateway-system` is `Programmed=True`. HTTPRoutes attached:

```
NAMESPACE    NAME      HOSTNAMES
medicard     hapihub   ["api-mycurex.medicardphils.com"]
medicard     minio     ["storage-mycurex.medicardphils.com"]   ← backed by s3proxy Service (§3.6)
medicard     mycure    ["cms-mycurex.medicardphils.com"]
```

Grafana is deliberately not on this list — see §3.5.

**Reported to MediCard:** the cluster's internal LoadBalancer IP for the three hostnames above is `172.22.40.10`, HTTP port 80. External routing, DNS, and TLS termination remain MediCard's responsibility per sheet row 5.d; the specific ingress mechanism they use to reach `172.22.40.10:80` (Application Gateway, TrafficManager, direct DNS, etc.) is out of scope for us.

**Our-side follow-up:** if `172.22.40.10` is stable across LB recreates on MediCard's end, we can pin it in our infrastructure values. Otherwise we leave the current auto-allocation in place and capture whatever new IP appears after any LB recreate.

### 3.4 Vault contents (per Infrastructure Clarifications sheet)

For each KV entry name our ExternalSecrets are configured to read, this is what was observed at snapshot time. The "Value visible in the sheet" column tracks values MediCard has already disclosed to us in writing; it does NOT imply the corresponding KV entry has been created — that step is on the KV owner (MediCard for the MediCard-owned entries; us for the s3proxy internal credential).

| KV secret name | Value visible in the sheet | Observed status |
|---|---|---|
| `medicard-prod-database-uri` | Row 3.a, latest: `postgresql://mycure_prod_app:[REDACTED-PG-PASSWORD]@mpiazeppgdb0003.postgres.database.azure.com:5432/postgres?sslmode=require` | Value disclosed; sheet row 5.c.ix notes "not yet configured for ESO sync". Owner: MediCard. |
| `medicard-prod-pg-target-uri` | Row 5.c.xi: same as DATABASE_URI (single role). | Value disclosed; not observed in KV. Owner: MediCard. |
| `medicard-prod-auth-secret` | Row 99: `[REDACTED-AUTH-SECRET]`. | Value disclosed; not observed in KV. Owner: MediCard. |
| `medicard-prod-better-auth-secret` | Row 5.c.viii, latest: "no entry found in prod app config". | Value NOT disclosed. Two paths exist: MediCard supplies an existing value if session parity with the legacy VM matters, otherwise a fresh value can be generated (with the caveat that any pre-existing sessions would be invalidated). |
| `medicard-prod-mongo-source-uri` | Row 4.a: `mongodb+srv://stg_mycure_acct:[REDACTED-MONGO-PASSWORD]@mycure-stg-sh.q4trx.mongodb.net/admin?retryWrites=true&w=majority&appName=mycure-stg-sh`. | Value disclosed; not observed in KV. Only becomes relevant once the migrator is un-paused. Owner: MediCard. |
| `medicard-prod-azureblob-account-name` | Storage account name (per earlier answers, expected to be a dedicated account for this workload). | Not observed in KV. Owner: MediCard. |
| `medicard-prod-azureblob-account-key` | Storage account access key. | Not observed in KV. Owner: MediCard. |
| `medicard-prod-s3proxy-credential` | Not applicable — internal S3-side credential (32-char random). | Not written yet. Owner: us. No MediCard dependency. |
| `medicard-prod-pg-encryption-key` + per-table keys (`-enc-medical-records`, `-enc-personal-details`, `-enc-billing-invoices`, `-enc-billing-items`, `-enc-billing-payments`) | Row 5.c.i–vii: **disputed** — MediCard says "data is plain text", MYCURE DEV rebuttal says "encrypted, keys exist". | Unresolved dispute. Only becomes blocking once the migrator is enabled AND the source data is in fact encrypted. Non-blocker for this deploy. |

Nothing in §3.4 blocks IaC shape. It **is** the reason hapihub and s3proxy pods don't come up: hapihub reads `DATABASE_URI` + `AUTH_SECRET` from the ExternalSecret-populated `hapihub-secrets`; s3proxy reads the `azureblob-*` pair from the ExternalSecret-populated `minio` Secret. Migrator un-pause additionally reads the source URI (and encryption keys if the disputed encryption state resolves to "encrypted").

### 3.5 Ancillary observations

- ArgoCD Git repo credential is a `mycurebot` GitHub fine-grained PAT for the initial bootstrap. Migration to a GitHub App with rotation is a follow-up on our side.
- **Grafana is proxy-only in prod.** No HTTPRoute is attached to the shared gateway and no `grafana.medicardphils.com` FQDN is registered on our side. Ops access is via `kubectl -n monitoring port-forward svc/grafana 3000:3000` from the bastion. Rationale: Grafana holds the whole cluster's metric surface; a public entry point for an ops-only UI is a needless attack surface.
- Full monitoring stack is running: Prometheus + Alertmanager + Grafana (default dashboards) + Loki 6.24.0 single-binary + Promtail DaemonSet. Log retention 30d; metric retention 30d. Alertmanager has no external notifier receivers wired yet.
- Loki writes to a 50Gi PVC on the cluster's default StorageClass (Azure Disk on AKS). No S3/Blob dependency — chunks and indexes are on the same filesystem.
- Neither `hapihub-secrets` nor the s3proxy-backed `minio` Secret exist yet — both are ESO-driven and blocked on §3.1. Consequently hapihub sits at `CreateContainerConfigError`; it has never reached the real Azure PG.
- **Storage-layer naming (intentional, worth flagging to avoid confusion).** The S3-facing Service, Deployment, ReplicaSet, and Secret in `medicard` are all literally named `minio` even though the workload is s3proxy talking to Azure Blob. This lets the hapihub chart's built-in MinIO integration point at the s3proxy Service without any chart modification. Renaming this to something like `hapihub-storage` is a follow-up refactor.

### 3.6 Object storage layer: s3proxy → native Azure Blob

Per Infrastructure Clarifications sheet row 5.c.xii, object storage in prod is native Azure Blob, not MinIO. The cluster runs a stateless `andrewgaul/s3proxy:3.3.0` container (`medicard-s3proxy` Application) that presents an S3 API on port 9000 and delegates writes to Azure Blob via jclouds' `azureblob` provider. All bytes live in the storage account; no PVC lives in the cluster.

s3proxy is deployed alongside the ExternalSecret configured to read Azure Blob credentials from `kv-mpi-sea-p-mycurex01` and expose them to s3proxy at container start.

**What we need to observe on MediCard's side for s3proxy to become functional** (mechanism and process on their side are out of scope for us):

- Two KV entries present in `kv-mpi-sea-p-mycurex01` under the names our ExternalSecret is configured to read:
  - `medicard-prod-azureblob-account-name` — the storage account name (per earlier answers, expected to be a dedicated account for this workload).
  - `medicard-prod-azureblob-account-key` — an access key for that account.
- Confirmation of the Azure environment (standard commercial vs. sovereign). Standard commercial requires no additional config on our side; a sovereign or custom-endpoint deployment would require a different endpoint value.
- Confirmation of the storage account's network posture (public with key auth, private endpoint, or IP-restricted from the AKS VNet's egress). The report simply flags that if the account is unreachable from AKS as configured, s3proxy will fail with connection errors; the mechanism MediCard uses to make it reachable is their decision.
- Existence of a Blob container named `monobase-files`. If it doesn't exist, s3proxy can create it on first write; MediCard may prefer to pre-create it with their own naming/tagging conventions.

The third KV entry, `medicard-prod-s3proxy-credential`, is not a MediCard dependency — it's an internal-to-cluster S3 credential we write once at any time and rotate at our discretion.

### 3.7 Velero backups — same blocker as s3proxy, plus one extra

Velero 1.18 (chart 12.0.1) is deployed to namespace `velero`, azure provider, storage-account-key auth. It reuses the same KV entries s3proxy is waiting on (`medicard-prod-azureblob-account-name`, `-account-key`) so there's no dedicated backup identity to provision. Once §3.1 (ESO) clears and those two KV entries exist, the `velero-credentials` k8s Secret gets created and velero pods complete their init.

Two extra items specific to backups (both MediCard-observable):

- **The `velero-backups` Blob container must exist in the storage account.** Velero does not auto-create it; if the container is missing when velero starts, the BackupStorageLocation goes `Unavailable` and every backup fails.
- **The storage-account name is currently a placeholder** in `values/infrastructure/main.yaml` (`velero.azure.storageAccount: "REPLACE-WITH-MEDICARD-STORAGE-ACCOUNT-NAME"`) — the chart requires it as a plaintext value, not sourced from KV. Once MediCard shares the account name (same value that goes into the `medicard-prod-azureblob-account-name` KV entry), we replace the placeholder and velero comes up.

Per-namespace backup schedules for `medicard` remain off. Enable when there is application-side state worth backing up (post-migration).

## 4. Summary — status per deployable

| Layer | Status | Blocker (if any) |
|---|---|---|
| ArgoCD | ✅ installed, GitOps live | none |
| envoy-gateway + shared-gateway | ✅ Programmed at 172.22.40.10 | none (MediCard AG wiring is downstream) |
| external-secrets operator | ✅ Running | none |
| ClusterSecretStore `azure-secretstore` | ❌ `InvalidProviderConfig` | §3.1 (Azure identity + KV read access) |
| `medicard` namespace + Kyverno/PSS baseline | ✅ | none |
| hapihub | ❌ `CreateContainerConfigError` (Deployment references Secrets that don't exist yet) | §3.1 (ESO to deliver `hapihub-secrets`) + §3.4 (KV entries for DATABASE_URI + AUTH_*) |
| s3proxy (object storage → Azure Blob) | ❌ `CreateContainerConfigError` (Deployment references `minio` Secret that doesn't exist yet) | §3.1 + §3.4 (`medicard-prod-azureblob-account-name`/`-key` + our `medicard-prod-s3proxy-credential`) |
| mycure | ✅ 1/1 Running | none (no ext-secret dep) |
| hapihub-migrator | ✅ Deployed, 0/0 replicas — **paused** | none (by design) |
| monitoring stack (Prometheus + Grafana + Alertmanager) | ✅ | none (Grafana proxy-only per §3.5) |
| loki + promtail | ✅ Log aggregation running, 50Gi PVC, 30d retention | none |
| velero | ⏳ Deployed, pod stuck at `MountVolume` for `velero-credentials` | §3.1 + §3.4 (`azureblob-account-name`/`-key`) + §3.7 (storage-account name placeholder + `velero-backups` container must exist) |

## 5. Cluster-side artifacts left behind

Contrary to the prior connectivity probes, **this run leaves everything in place** — that's the point. Retained artifacts:

- 7 namespaces (§2.2).
- ArgoCD 7.7.12 + argocd-bootstrap chart (Applications + ApplicationSet).
- 1 GitHub PAT Secret in `argocd` for repository access.
- All infrastructure Applications (envoy-gateway, external-secrets, monitoring, etc.).
- All `medicard-*` child Applications and their reconciled resources.
- One PVC bound (Loki, 50Gi on default Azure Disk StorageClass) plus one from Prometheus (50Gi). Application-side PG is external, MongoDB Atlas is external, s3proxy and velero are stateless. No stray data on any upstream DB.
- No mutating calls were made against `mpiazeppgdb0003` or `mycure-stg-sh` MongoDB Atlas from this deploy — hapihub hasn't successfully reached either DB, migrator is at 0.

## Appendix — Environment fingerprint at time of test

- **Cluster:** `aks-mpi-sea-p-mycurex01`
- **Kubernetes API server:** `https://aks-mpi-sea-p-mycurex01-dns-ib3b6bgj.996c88f8-39f9-4501-9694-b5cbfda6f629.privatelink.southeastasia.azmk8s.io:443` (Azure Private Link)
- **Bastion:** `SEA-VM-STG-MYCURE-WEB` (user `mycurex`, IP 172.23.4.8), kubectl v1.31.0 preconfigured, helm v3.16.3 installed during this run.
- **ArgoCD version:** `argo-cd` Helm chart `7.7.12` (app version `v2.13.2`).
- **Envoy Gateway version:** `v1.2.0`.
- **External Secrets Operator version:** `0.9.11`.
- **Test date / time:** 2026-07-07 (Asia/Manila).
