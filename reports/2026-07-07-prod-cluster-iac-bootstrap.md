# 2026-07-07 — Prod Cluster IaC Bootstrap

**Status:** ArgoCD + all infrastructure Applications deployed to the PROD AKS cluster. GitOps auto-discovery is live. Application-layer pods stuck waiting on Azure Key Vault secrets — a known, single-cause gap on the MediCard side.
**Environment under test:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia, Private Link API).
**Access path:** all `kubectl` / `helm` from operator jumphost `mc.remote.prd.bastion` via `ssh medicard.gateway`.
**Prior state:** see [`2026-07-07-prod-cluster-database-connectivity-validation.md`](./2026-07-07-prod-cluster-database-connectivity-validation.md) — cluster held only system namespaces at start of this run.

---

## 1. Scope

Deploy the MediCard IaC (this repo, prod branch = `main`) end-to-end into the empty PROD cluster: install ArgoCD, wire GitOps auto-discovery to the private repo, let ArgoCD reconcile all infrastructure + application charts to the desired state. Migration itself stays gated (`hapihubMigrator.replicaCount: 0`) — this deploy is IaC only, not a data cutover.

This is a **mutating** run: workloads, namespaces, secrets, and CRDs are created and left in place. Contrast with the read-only connectivity probes in prior reports.

## 2. What shipped

### 2.1 Branch flip (repo-side, pre-bootstrap)

- New `staging` branch cut from prior `main` at `5544b42`; `values/infrastructure/main.yaml` pinned there to `targetRevision: staging` (commit `7dcd9aa`).
- Staging cluster's `argocd-bootstrap` chart re-applied; the staging `infrastructure` Application and all `medicard-staging-*` children now track the `staging` branch. Staging remained Synced+Healthy through the flip — verified before mutating `main`.
- `main` rewritten to hold PROD values (commit `e94344c`). Two files changed. Substitutions per the *Infrastructure Clarifications* sheet:

| Field | Staging | PROD |
|---|---|---|
| `global.namespace` | `medicard-staging` | `medicard-prod` |
| `global.environment` | `staging` | `production` |
| App hostnames | `*-mycurex-dev.medicardphils.com` | `*-mycurex.medicardphils.com` |
| Azure KV `vaultUrl` | `kv-mpi-sea-a-mycurex01` | `kv-mpi-sea-p-mycurex01` |
| Azure KV `tenantId` | `31e62360-…` | same (confirmed) |
| Envoy internal LB IP | `172.23.32.5` (static) | `""` (auto-allocate; captured post-deploy, see §3.3) |
| `hapihub.image.tag` | `11.2.9` | `11.20.47` (ghcr latest as of run) |
| `mycure.image.tag` | `10.4.2` | `10.25.68` |
| `hapihubMigrator.image.tag` | `3.7.7` | `3.9.3` |
| `hapihubMigrator.replicaCount` | `0` | `0` (unchanged — migration stays gated) |
| MinIO `remoteKey` | `medicard-staging-minio-root-password` | `medicard-prod-minio-root-password` |
| Mailpit | enabled | disabled |

### 2.2 Cluster-side bootstrap (on `mc.remote.prd.bastion`)

- Installed helm v3.16.3 to `~/bin/helm` (no sudo).
- Shipped `main` tree via `git archive HEAD | ssh … | tar x` into `~/monobase-infra-medicard`.
- `kubectl create ns argocd`.
- `helm upgrade --install argocd argo/argo-cd --version 7.7.12` with `values/infrastructure/main.yaml`. 7 pods reached Running.
- Created `argocd-repo-medicard` Secret (label `argocd.argoproj.io/secret-type: repository`) with GitHub PAT (`gh auth token`, user `mycurebot`, scopes `repo`) so ArgoCD can clone the private repo.
- `helm upgrade --install argocd-bootstrap ./charts/argocd-bootstrap` — creates the `infrastructure` Application and the `monobase-auto-discover` ApplicationSet.
- ApplicationSet auto-discovered `values/deployments/medicard.yaml` and generated the `medicard-root` Application, which fanned out to `medicard-prod-{hapihub, hapihub-migrator, minio, mycure, namespace, security-baseline}`.

### 2.3 Convergence (~4 min after bootstrap chart apply)

```
NAME                              REV      SYNC      HEALTH
envoy-gateway                     v1.2.0   Synced    Healthy
envoy-proxy-config                main     Synced    Healthy
external-secrets                  0.9.11   Synced    Healthy
external-secrets-stores           main     Synced    Degraded   ← see §3.1
gateway-resources                 main     Synced    Healthy
grafana                           main     Synced    Healthy
infrastructure                    main     Synced    Healthy
medicard-prod-hapihub             main     Synced    Progressing ← see §3.2
medicard-prod-hapihub-migrator    main     Synced    Healthy    (0/0 replicas — paused)
medicard-prod-minio               main     Synced    Degraded   ← see §3.2
medicard-prod-mycure              main     Synced    Healthy    (1/1 Running)
medicard-prod-namespace           main     Synced    Healthy
medicard-prod-security-baseline   main     Synced    Healthy
medicard-root                     main     Synced    Healthy
monitoring                        11.3.9   Synced    Healthy
monitoring-resources              main     Synced    Healthy
```

### 2.4 Namespaces created

`argocd`, `envoy-gateway-system`, `external-secrets-system`, `gateway-system`, `medicard`, `medicard-prod`, `monitoring`. Prior 5 system namespaces untouched.

## 3. Findings

### 3.1 ExternalSecrets provider = InvalidProviderConfig (only remaining blocker)

`ClusterSecretStore/azure-secretstore` reconciler surfaces a specific, actionable error:

```
could not get provider client:
missing service account annotation: azure.workload.identity/client-id
```

The chart-side `authType: WorkloadIdentity` is correct; what's missing is the `azure.workload.identity/client-id` annotation on the `external-secrets/external-secrets-system` ServiceAccount. On staging that annotation carried UAMI client-id `d6b958ed-790e-4a8a-9ce0-10aa6c0776b8`. Per row 5.b.iii of the *Infrastructure Clarifications* sheet, MediCard replied "No separate user-assigned mi for ExternalSecrets at this moment" and pointed at the AKS kubelet MI / a `service.mycure` SA (rows 5.b.iv / 5.b.v).

**Action needed from MediCard:**
- (a) UAMI approach: provision a UAMI in the prod resource group, grant it `Key Vault Secrets User` on `kv-mpi-sea-p-mycurex01`, create a federated identity credential binding `subject: system:serviceaccount:external-secrets-system:external-secrets`, `audience: api://AzureADTokenExchange`, and hand us the UAMI client-id; **or**
- (b) Kubelet MI approach: grant the AKS kubelet MI `Key Vault Secrets User` on the same vault and share its client-id — we then swap the ClusterSecretStore `authType` to `ManagedIdentity` and drop the SA-annotation requirement.

Either unblocks §3.2 immediately.

### 3.2 Application pods

**Update 2026-07-07 (post-bootstrap commit `5a2dd9b`):** MinIO was disabled per §3.6 below, which pruned the `medicard-prod-minio` Application and removed hapihub's dependency on the `minio` Secret. Current state:

- `hapihub-6c59fcb99-…` — **1/1 Running, Healthy**. HTTP `/checkHealth` returns 200. *Caveat:* `hapihub-secrets` still doesn't exist, and every env var referencing it in the Deployment is `optional: true`, so `DATABASE_URI` is unset — hapihub **fell back to SQLite at `/tmp/.local/share/hapihub/hapihub.db`**. Pod logs: `Using SQLite database` → `➜ Database: sqlite`. Functionally detached from the real Azure PG until ESO delivers `hapihub-secrets`. This will look like a working deploy to an outside observer; it is not.
- `mycure-…` — 1/1 Running. No secret deps.
- `hapihub-migrator` — 0/0 replicas as designed. Present in cluster; requires an explicit `hapihubMigrator.replicaCount=1` commit to un-pause.
- MinIO: gone (Deployment, StatefulSet, PVC, ExternalSecret all pruned by ArgoCD).

### 3.3 Envoy LoadBalancer internal IP allocated: `172.22.40.10`

With `envoyProxyConfig.azure.ipv4Address: ""` and the Azure internal-LB annotation, Azure auto-allocated **`172.22.40.10`** from the AKS subnet `subnet-p-mycurex-aks01-172.22.40.0/22`:

```
NAMESPACE              NAME                                              TYPE          EXTERNAL-IP    PORT(S)
envoy-gateway-system   envoy-gateway-system-shared-gateway-0457b32d      LoadBalancer  172.22.40.10   80:31335/TCP
```

Gateway `shared-gateway` in `gateway-system` is `Programmed=True`. HTTPRoutes are attached:

```
NAMESPACE       NAME      HOSTNAMES
medicard-prod   hapihub   ["api-mycurex.medicardphils.com"]
medicard-prod   mycure    ["cms-mycurex.medicardphils.com"]
monitoring     grafana    ["grafana.medicardphils.com"]
```

(The `minio`/`storage-mycurex` route existed at first bootstrap but was pruned in `5a2dd9b`. See §3.6.)

**Action needed from MediCard:** point the external Application Gateway / `mc-traffic-mgr-mpi-prd.trafficmanager.net` backends for the three hostnames above at `172.22.40.10` (HTTP :80). TLS is terminated on their side per the sheet (5.d.i). The eventual s3proxy (§3.6) will re-introduce a `storage-mycurex` HTTPRoute — MediCard will re-add the AG rule at that point.

**Recommended follow-up on our side:** once MediCard confirms `172.22.40.10` is fine to keep, pin it via `envoyProxyConfig.azure.ipv4Address: "172.22.40.10"` in `values/infrastructure/main.yaml` so it survives an LB recreate.

### 3.4 Vault contents (per Infrastructure Clarifications sheet)

Values shared by MediCard for population under the naming convention our charts expect:

| KV secret name | Value source (from sheet) | Status in KV |
|---|---|---|
| `medicard-prod-DATABASE_URI` | Row 3.a, latest: `postgresql://mycure_prod_app:[REDACTED-PG-PASSWORD]@mpiazeppgdb0003.postgres.database.azure.com:5432/postgres?sslmode=require` | Value shared; sheet row 5.c.ix says "not yet configured for ESO sync" — MediCard to write to KV under this exact name. |
| `medicard-prod-pg-target-uri` | Row 5.c.xi: same as DATABASE_URI (single role) | Same — MediCard to write. |
| `medicard-prod-AUTH_SECRET` | Row 99: `[REDACTED-AUTH-SECRET]` | Value shared; MediCard to write. |
| `medicard-prod-BETTER_AUTH_SECRET` | Row 5.c.viii, latest: "no entry found in prod app config" | **Not shared** — either MediCard provides an existing value (to keep session parity with the legacy VM), or we generate a fresh one (invalidates any pre-existing sessions, which is fine since prod is empty). |
| `medicard-prod-mongo-source-uri` | Row 4.a: `mongodb+srv://stg_mycure_acct:[REDACTED-MONGO-PASSWORD]@mycure-stg-sh.q4trx.mongodb.net/admin?retryWrites=true&w=majority&appName=mycure-stg-sh` | Value shared; MediCard to write (only needed once we start the migrator). |
| ~~`medicard-prod-minio-root-password`~~ | Not needed | Superseded — MinIO disabled in commit `5a2dd9b`. See §3.6. |
| `medicard-prod-pg-encryption-key` + per-table keys (`-enc-medical-records`, `-enc-personal-details`, `-enc-billing-invoices`, `-enc-billing-items`, `-enc-billing-payments`) | Row 5.c.i–vii: **disputed** — MediCard says "data is plain text", MYCURE DEV rebuttal says "encrypted, keys exist". | Unresolved. Only needed once migrator is enabled and touches encrypted rows. **Non-blocker for this deploy.** |

None of §3.4 is blocking the deploy at IaC-shape level. §3.4 becomes blocking the moment hapihub is expected to serve traffic (needs DATABASE_URI + AUTH_SECRET) and the moment the migrator is un-paused (needs the source URI + encryption keys if data is in fact encrypted).

### 3.5 Ancillary observations

- ArgoCD Git repo credential currently uses a `mycurebot` fine-grained PAT. Ponytail-correct for bootstrap; migration to a GitHub App with rotation is a follow-up.
- `grafana` HTTPRoute uses `grafana.medicardphils.com` — verify DNS on the MediCard side once (3.3) is wired; currently there is no DNS entry.
- No monitoring dashboards were customised in this run. Prometheus + Grafana came up on default values from the chart.
- No `hapihub-secrets` k8s Secret was manually created; the intent is for ESO to produce it once §3.1 is resolved. Until then hapihub silently runs on an in-pod SQLite (see §3.2 caveat).

### 3.6 MinIO disabled — Azure Blob path (commit `5a2dd9b`)

MediCard requested (Infrastructure Clarifications sheet row 5.c.xii) that object storage be **native Azure Blob**, not MinIO. Committed on `main`:

- `values/deployments/medicard.yaml`: `minio.enabled: false` (top-level, prunes MinIO Deployment/StatefulSet/PVC/ExternalSecret/HTTPRoute) **and** `hapihub.minio.enabled: false` (strips all `STORAGE_*` env vars + the `minio` Secret refs from the hapihub Deployment).

Effect on cluster:
- `medicard-prod-minio` Application deleted by ArgoCD (`preserveResourcesOnDeletion=true` on the ApplicationSet, but this is a straight Application prune under the medicard-root, so resources go).
- Hapihub Deployment restarted cleanly (`hapihub-6c59fcb99-…`) with no `STORAGE_S3_*` env → falls back to SQLite storage as noted in §3.2.

**Follow-up on our side** (tracked in the prior "azure-storage" session): deploy **`s3proxy`** as a stateless Deployment inside `medicard-prod`. s3proxy exposes an S3 API to hapihub (so `hapihub.minio.enabled` can be re-enabled with `STORAGE_S3_ENDPOINT` pointed at the s3proxy Service) and delegates writes to Azure Blob via jclouds' `azureblob` provider. No PVC needed — durable bytes land in Blob.

**Action needed from MediCard for s3proxy**:
- Dedicated storage account name (e.g., `medicardprodstore`) — used as `JCLOUDS_IDENTITY`.
- Storage account access key — the `JCLOUDS_CREDENTIAL` secret.
- Blob container name (e.g., `monobase-files`) — either MediCard creates it or we create it after receiving the key.
- Confirmation the storage account is on **standard commercial Azure** (not sovereign cloud) so we can rely on jclouds' default endpoint. If firewalled: allowlist the AKS cluster's egress IP (we send once the cluster's egress is known).

Once received: one commit adds a `charts/s3proxy` deployment, a Secret pulled from KV (`medicard-prod-azureblob-key`), and flips `hapihub.minio.enabled: true` back on with `hapihub.minio.serviceName: s3proxy` overriding the URL helper. Zero change to hapihub's chart.

## 4. Summary — status per deployable

| Layer | Status | Blocker (if any) |
|---|---|---|
| ArgoCD | ✅ installed, GitOps live | none |
| envoy-gateway + shared-gateway | ✅ Programmed at 172.22.40.10 | none (MediCard AG wiring is downstream) |
| external-secrets operator | ✅ Running | none |
| ClusterSecretStore `azure-secretstore` | ❌ `InvalidProviderConfig` | §3.1 (MediCard MI + SA annotation) |
| medicard-prod namespace + Kyverno/PSS baseline | ✅ | none |
| hapihub | ⚠️ 1/1 Running on **SQLite fallback** (Argo says Healthy but no `hapihub-secrets` → no DATABASE_URI) | §3.1 (ESO to deliver `hapihub-secrets` with DATABASE_URI + AUTH_*) |
| object storage | ❌ MinIO removed (§3.6); s3proxy → Azure Blob pending | MediCard: storage account name + key + container (§3.6) |
| mycure | ✅ 1/1 Running | none (no ext-secret dep) |
| hapihub-migrator | ✅ Deployed, 0/0 replicas — **paused** | none (by design) |
| monitoring stack | ✅ | none |

## 5. Cluster-side artifacts left behind

Contrary to the prior connectivity probes, **this run leaves everything in place** — that's the point. Retained artifacts:

- 7 namespaces (§2.4).
- ArgoCD 7.7.12 + argocd-bootstrap chart (Applications + ApplicationSet).
- 1 GitHub PAT Secret (`argocd/argocd-repo-medicard`) — rotate when the mycurebot token rotates.
- All infrastructure Applications (envoy-gateway, external-secrets, monitoring, etc.).
- All medicard-prod-* Applications and their reconciled resources.
- No PVCs are healthy yet (MinIO / PG are external / disabled); no stray data was written to either upstream DB.
- No mutating calls were made against `mpiazeppgdb0003` or `mycure-stg-sh` MongoDB Atlas from this deploy — hapihub hasn't started, migrator is at 0.

Rollback (if desired): the destructive path from the plan file — `helm uninstall argocd-bootstrap && kubectl delete applicationsets,applications -n argocd --all --cascade=foreground && helm uninstall argocd -n argocd && kubectl delete ns argocd envoy-gateway-system external-secrets-system gateway-system medicard medicard-prod monitoring` — returns the cluster to the pre-bootstrap state (system namespaces only, matching the 2026-07-07 connectivity report's environment fingerprint).

---

## Appendix A — Bootstrap commands actually run (chronological, verbatim)

```
# Repo (ops laptop)
git branch staging && git push -u origin staging
# edit values/infrastructure/main.yaml on staging → targetRevision: staging
git commit + push
# re-apply on staging cluster (existing kubeconfig)
KUBECONFIG=./.kube/config \
  helm upgrade argocd-bootstrap ./charts/argocd-bootstrap \
    -n argocd -f values/infrastructure/main.yaml --wait --timeout 5m
# rewrite main with prod values (see §2.1), commit + push

# Prod bastion (via ssh medicard.gateway → mc.remote.prd.bastion)
mkdir -p ~/bin && curl -sSL https://get.helm.sh/helm-v3.16.3-linux-amd64.tar.gz | tar -xz -C /tmp/ && mv /tmp/linux-amd64/helm ~/bin/
git archive HEAD | ssh … tar x -C ~/monobase-infra-medicard
kubectl create ns argocd
helm repo add argo https://argoproj.github.io/argo-helm && helm repo update
helm upgrade --install argocd argo/argo-cd \
  -n argocd --version 7.7.12 \
  --values values/infrastructure/main.yaml \
  --wait --timeout 15m
kubectl apply -n argocd -f - <<YAML   # PAT-based repo cred
apiVersion: v1
kind: Secret
metadata:
  name: argocd-repo-medicard
  labels: {argocd.argoproj.io/secret-type: repository}
stringData:
  type: git
  url: https://github.com/mycurelabs/monobase-infra-medicard.git
  username: x-access-token
  password: <mycurebot PAT>
YAML
helm upgrade --install argocd-bootstrap ./charts/argocd-bootstrap \
  -n argocd --values values/infrastructure/main.yaml --wait --timeout 5m
```

## Appendix B — Environment fingerprint at time of test

- **Cluster:** `aks-mpi-sea-p-mycurex01`
- **Kubernetes API server:** `https://aks-mpi-sea-p-mycurex01-dns-ib3b6bgj.996c88f8-39f9-4501-9694-b5cbfda6f629.privatelink.southeastasia.azmk8s.io:443` (Azure Private Link)
- **Bastion:** `SEA-VM-STG-MYCURE-WEB` (user `mycurex`, IP 172.23.4.8), kubectl v1.31.0 preconfigured, helm v3.16.3 installed to `~/bin` during this run.
- **ArgoCD version:** `argo-cd` Helm chart `7.7.12` (app version `v2.13.2`).
- **Envoy Gateway version:** `v1.2.0`.
- **External Secrets Operator version:** `0.9.11`.
- **Repo revision applied:** `e94344c` (`feat(prod): switch main to prod values`).
- **Test date / time:** 2026-07-07 (Asia/Manila).
