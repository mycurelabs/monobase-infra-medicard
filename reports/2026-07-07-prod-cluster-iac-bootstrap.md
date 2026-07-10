# 2026-07-07 — Prod Cluster IaC Bootstrap

**Status:** ArgoCD + all infrastructure Applications deployed. Monitoring (Prometheus + Grafana + Alertmanager + Loki + Promtail) is green. ESO now authenticates to Azure AD (MediCard added the missing FIC) — but the vault's private FQDN doesn't resolve from inside the AKS VNet, so ExternalSecret reads still fail at the DNS step. Application-layer workloads (hapihub, s3proxy, velero) remain queued on that single upstream blocker; the Secrets those pods depend on can't be created until the vault becomes reachable. Mycure and the migrator scaffold are green.
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

### 3.1 ExternalSecrets → Key Vault: identity resolved, DNS still blocked

**Identity (resolved).** MediCard added a Federated Identity Credential to the existing UAMI (client-id `d6b958ed-790e-4a8a-9ce0-10aa6c0776b8`) with the prod cluster's OIDC issuer and subject `system:serviceaccount:external-secrets-system:external-secrets`, and confirmed the UAMI has read access on `kv-mpi-sea-p-mycurex01`. `ClusterSecretStore/azure-secretstore` transitioned to `Ready: True, reason: Valid`. ESO now presents a token and Azure AD accepts it.

Sheet-side, this confirms the reading of row 5.b.iii ("no *separate* user-assigned mi") — the intent was to reuse the staging UAMI. Row 5.b.v's RBAC statement is also confirmed.

**DNS (new blocker).** Auth succeeds, but the very next step — the actual secret fetch — fails at DNS resolution:

```
error retrieving secret at .data[0], key: medicard-prod-azureblob-account-key,
err: keyvault.BaseClient#GetSecret: Failure sending request: StatusCode=0
Original Error: Get "https://kv-mpi-sea-p-mycurex01.vault.azure.net/secrets/…":
dial tcp: lookup kv-mpi-sea-p-mycurex01.vault.azure.net on 10.0.0.10:53:
no such host
```

The two operations use different endpoints. Auth talks to `login.microsoftonline.com` — a public Microsoft endpoint reachable over the AKS cluster's normal egress. The secret fetch talks to the vault's own hostname, which CNAME-chains into `privatelink.vaultcore.azure.net.` because the vault has a Private Endpoint (`pl-mpi-sea-p-mycurex-kv01` per sheet row 5.b.v). That private DNS zone only resolves from VNets it is linked to. The AKS VNet (`mc-prd-vnet-sea-01`) does not appear to have that link — CoreDNS returns NXDOMAIN.

**What we need to observe on MediCard's side** (mechanism on their side is out of scope for us):

- `kv-mpi-sea-p-mycurex01.vault.azure.net` must resolve to a routable IP from pods inside the AKS VNet. The mechanism (linking the `privatelink.vaultcore.azure.net` private DNS zone to the AKS VNet, adding a private endpoint of the vault into the AKS VNet, or a network path from AKS to whatever VNet currently holds the private endpoint) is their infrastructure call. We can verify success by re-running the ExternalSecret reconcile and observing whether the same request succeeds.

Once this clears and §3.4's KV entries are already populated (they are — see below), §3.2 unblocks.

### 3.2 Application pods

- **`hapihub`** — pod in `CreateContainerConfigError`. Deployment references the `hapihub-secrets` and `minio` Secrets; both are ESO-managed and blocked by the §3.1 DNS issue. Chart-side, `values/deployments/medicard.yaml` now wires an ExternalSecret pulling seven entries from KV (DATABASE_URI, AUTH_SECRET, and the five per-table encryption keys), so the moment §3.1 clears, `hapihub-secrets` gets created and hapihub restarts onto the real DB.
- **`s3proxy`** — pod in `CreateContainerConfigError`, same root cause: the k8s Secret it reads (literally named `minio` — see §3.5) requires the vault-reachability §3.1 clears.
- **`velero`** — pod in `Init` waiting on `MountVolume.SetUp failed for volume "cloud-credentials" : secret "velero-credentials" not found`. Same root cause. See §3.7.
- **`mycure`** — 1/1 Running. No external-secret dependency; unaffected.
- **`hapihub-migrator`** — 0/0 replicas as designed. Present in cluster; requires an explicit config change on our side to un-pause once data-cutover time comes.

`hapihub`, `s3proxy`, and `velero` all come up together the moment §3.1 clears — one blocker unblocks all three.

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

### 3.4 Vault contents

MediCard populated the vault. Observed via the Azure Portal listing.

| KV secret name | Consumed by | Observed status |
|---|---|---|
| `medicard-prod-database-uri` | hapihub (`DATABASE_URI`) + migrator | ✓ Present in KV. Awaiting §3.1 DNS. |
| `medicard-prod-pg-target-uri` | migrator (when un-paused) | ✓ Present in KV. |
| `medicard-prod-AUTH-SECRET` | hapihub (`AUTH_SECRET`) | ✓ Present in KV. Portal spelling is uppercase; Azure KV is case-insensitive so our chart reference `medicard-prod-auth-secret` resolves to the same value. |
| `medicard-prod-mongo-source-uri` | migrator (source) | ✓ Present in KV. |
| `medicard-prod-azureblob-account-name` | info; value `sampseapmycurex01` | ✓ Present in KV. |
| `medicard-prod-azureblob-account-key` | s3proxy + velero | ✓ Present in KV. |
| `medicard-prod-pg-encryption-key` + all five per-table keys (`-enc-medical-records`, `-enc-personal-details`, `-enc-billing-invoices`, `-enc-billing-items`, `-enc-billing-payments`) | hapihub + migrator | ✓ Present in KV. Row 5.c.i–vii dispute effectively closed by MediCard populating them. Non-blocker either way — only relevant once the migrator runs. |
| `medicard-prod-s3proxy-credential` | s3proxy internal identity | Not written yet. Owner: us. No MediCard dependency. |
| `medicard-prod-better-auth-secret` | hapihub (`BETTER_AUTH_SECRET`) | Not present. Env is optional; prod is empty so a fresh value can be minted at any time without disruption. Non-blocker. |

Nothing in §3.4 is currently blocking. Every entry hapihub/s3proxy/velero needs to boot is present in the vault; the pods stay red only because §3.1 DNS blocks the fetch.

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

### 3.7 Velero backups — waiting on §3.1 DNS + one container check

Velero 1.18 (chart 12.0.1) is deployed to namespace `velero`, azure provider, storage-account-key auth. It reuses the same KV entries s3proxy is waiting on (`medicard-prod-azureblob-account-name`, `medicard-prod-azureblob-account-key`) — no dedicated backup identity. Storage account is `sampseapmycurex01`; that value now lives in `values/infrastructure/main.yaml` under `velero.azure.storageAccount`. Once §3.1 DNS clears, the `velero-credentials` k8s Secret gets created and velero pods complete init.

One remaining item to check on MediCard's side:

- **The `velero-backups` Blob container must exist in `sampseapmycurex01`.** Velero does not auto-create containers; if missing when velero starts, `BackupStorageLocation` goes `Unavailable` and every backup fails. MediCard's delivery message did not mention creating it.

Per-namespace backup schedules for `medicard` remain off. Enable when there is application-side state worth backing up (post-migration).

## 4. Summary — status per deployable

| Layer | Status | Blocker (if any) |
|---|---|---|
| ArgoCD | ✅ installed, GitOps live | none |
| envoy-gateway + shared-gateway | ✅ Programmed at 172.22.40.10 | none (MediCard AG wiring is downstream) |
| external-secrets operator | ✅ Running | none |
| ClusterSecretStore `azure-secretstore` | ✅ `Ready: Valid` (Azure AD auth OK) | none for auth; §3.1 for reads (vault DNS) |
| `medicard` namespace + Kyverno/PSS baseline | ✅ | none |
| hapihub | ❌ `CreateContainerConfigError` (Deployment references Secrets that don't exist yet) | §3.1 (ESO to deliver `hapihub-secrets`) + §3.4 (KV entries for DATABASE_URI + AUTH_*) |
| s3proxy (object storage → Azure Blob) | ❌ `CreateContainerConfigError` (Deployment references `minio` Secret that doesn't exist yet) | §3.1 + §3.4 (`medicard-prod-azureblob-account-name`/`-key` + our `medicard-prod-s3proxy-credential`) |
| mycure | ✅ 1/1 Running | none (no ext-secret dep) |
| hapihub-migrator | ✅ Deployed, 0/0 replicas — **paused** | none (by design) |
| monitoring stack (Prometheus + Grafana + Alertmanager) | ✅ | none (Grafana proxy-only per §3.5) |
| loki + promtail | ✅ Log aggregation running, 50Gi PVC, 30d retention | none |
| velero | ⏳ Deployed, pod stuck at `MountVolume` for `velero-credentials` | §3.1 (vault DNS) + §3.7 (`velero-backups` container must exist) |

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
