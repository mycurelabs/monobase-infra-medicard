# 2026-07-07 — Prod Cluster IaC Bootstrap

**Status:** ArgoCD + all infrastructure Applications deployed. All app-layer workloads (hapihub, s3proxy) queued on the single ESO `azure-secretstore` blocker — MediCard-side identity + KV entries. Mycure and migrator infra are green.
**Environment under test:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia, Private Link API).
**Access path:** all `kubectl` / `helm` from operator jumphost `mc.remote.prd.bastion` via `ssh medicard.gateway`.
**Prior state:** see [`2026-07-07-prod-cluster-database-connectivity-validation.md`](./2026-07-07-prod-cluster-database-connectivity-validation.md) — cluster held only system namespaces at start of this run.
**Repo state at snapshot:** `main` @ `7569ab1` (post Phase 0 rename + Phase 1 s3proxy + PSS fix — see Appendix A).

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
| `global.namespace` | `medicard-staging` | `medicard` (was `medicard-prod` at initial bootstrap; renamed in `1728194` — see Phase 0 in Appendix A) |
| `global.environment` | `staging` | `production` |
| App hostnames | `*-mycurex-dev.medicardphils.com` | `*-mycurex.medicardphils.com` |
| Azure KV `vaultUrl` | `kv-mpi-sea-a-mycurex01` | `kv-mpi-sea-p-mycurex01` |
| Azure KV `tenantId` | `31e62360-…` | same (confirmed) |
| Envoy internal LB IP | `172.23.32.5` (static) | `""` (auto-allocate; captured post-deploy, see §3.3) |
| `hapihub.image.tag` | `11.2.9` | `11.20.47` (ghcr latest as of run) |
| `mycure.image.tag` | `10.4.2` | `10.25.68` |
| `hapihubMigrator.image.tag` | `3.7.7` | `3.9.3` |
| `hapihubMigrator.replicaCount` | `0` | `0` (unchanged — migration stays gated) |
| MinIO subchart | Bitnami MinIO enabled | disabled; replaced by s3proxy → Azure Blob (§3.6) |
| Mailpit | enabled | disabled |

### 2.2 Cluster-side bootstrap (on `mc.remote.prd.bastion`)

- Installed helm v3.16.3 to `~/bin/helm` (no sudo).
- Shipped `main` tree via `git archive HEAD | ssh … | tar x` into `~/monobase-infra-medicard`.
- `kubectl create ns argocd`.
- `helm upgrade --install argocd argo/argo-cd --version 7.7.12` with `values/infrastructure/main.yaml`. 7 pods reached Running.
- Created `argocd-repo-medicard` Secret (label `argocd.argoproj.io/secret-type: repository`) with GitHub PAT (`gh auth token`, user `mycurebot`, scopes `repo`) so ArgoCD can clone the private repo.
- `helm upgrade --install argocd-bootstrap ./charts/argocd-bootstrap` — creates the `infrastructure` Application and the `monobase-auto-discover` ApplicationSet.
- ApplicationSet auto-discovered `values/deployments/medicard.yaml` and generated the `medicard-root` Application, which fanned out to per-app children (`medicard-{hapihub, hapihub-migrator, mycure, namespace, s3proxy, security-baseline}` in the current state — the initial bootstrap used `medicard-prod-*` naming; see Phase 0 in Appendix A).

### 2.3 Current on-cluster state

```
NAME                          REV      SYNC      HEALTH
envoy-gateway                 v1.2.0   Synced    Healthy
envoy-proxy-config            main     Synced    Healthy
external-secrets              0.9.11   Synced    Healthy
external-secrets-stores       main     Synced    Degraded    ← see §3.1
gateway-resources             main     Synced    Healthy
grafana                       main     Synced    Healthy
infrastructure                main     Synced    Healthy
medicard-hapihub              main     Synced    Progressing ← see §3.2
medicard-hapihub-migrator     main     Synced    Healthy     (0/0 replicas — paused)
medicard-mycure               main     Synced    Healthy     (1/1 Running)
medicard-namespace            main     Synced    Healthy
medicard-root                 main     Synced    Healthy
medicard-s3proxy              main     Synced    Degraded    ← see §3.2, §3.6
medicard-security-baseline    main     Synced    Healthy
monitoring                    11.3.9   Synced    Healthy
monitoring-resources          main     Synced    Healthy
```

### 2.4 Namespaces created

`argocd`, `envoy-gateway-system`, `external-secrets-system`, `gateway-system`, `medicard`, `monitoring` (6 total). Prior 5 system namespaces untouched. The empty `medicard-prod` shell from initial bootstrap was pruned by ArgoCD after the Phase 0 rename (see Appendix A).

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

State evolved across four commits today (`e94344c` → `5a2dd9b` → `9434f1d` → `7569ab1`). Current, canonical state on the cluster:

- **`hapihub`** — new ReplicaSet `hapihub-5774cfc768` waiting at `CreateContainerConfigError`: the Deployment's `secretKeyRef` to the `minio` Secret can't be resolved. The old ReplicaSet `hapihub-bb87dcc4c` (which briefly ran on in-pod SQLite between `5a2dd9b` and `9434f1d` because `hapihub.minio.enabled` was temporarily off) still holds one `1/1 Running` pod, but is a rollout artefact — it will terminate once the new one comes up. Do **not** treat that lingering `Running` pod as a working deploy: it has never been pointed at prod PG and has no persistent storage.
- **`s3proxy`** (deployed as Service/Deployment/Secret named `minio` via `fullnameOverride`) — new ReplicaSet `minio-86b95648c6` has one pod at `CreateContainerConfigError`, same root cause: the `minio` Secret (with `root-user`/`root-password`/`azureblob-account`/`azureblob-key`) isn't there because ESO can't sync it (§3.1).
- **`mycure`** — 1/1 Running. No external-secret dependency; unaffected.
- **`hapihub-migrator`** — 0/0 replicas as designed. Present in cluster; requires an explicit `hapihubMigrator.replicaCount=1` commit to un-pause.

Both `hapihub` and `s3proxy` come up together the moment §3.1 clears and the three KV entries in §3.4 land — one blocker unblocks both.

### 3.3 Envoy LoadBalancer internal IP allocated: `172.22.40.10`

With `envoyProxyConfig.azure.ipv4Address: ""` and the Azure internal-LB annotation, Azure auto-allocated **`172.22.40.10`** from the AKS subnet `subnet-p-mycurex-aks01-172.22.40.0/22`:

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
monitoring   grafana   ["grafana.medicardphils.com"]
```

**Action needed from MediCard:** point the external Application Gateway / `mc-traffic-mgr-mpi-prd.trafficmanager.net` backends for the four hostnames above at `172.22.40.10` (HTTP :80). TLS is terminated on their side per the sheet (5.d.i).

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
| ~~`medicard-prod-minio-root-password`~~ | Not needed | Superseded — MinIO subchart disabled; s3proxy owns the S3-side credential. |
| `medicard-prod-azureblob-account-name` | Storage account name (e.g., `medicardprodstore`) — MediCard confirmed dedicated account in prep. | **Not written yet.** Consumed by `s3proxy` ExternalSecret → k8s Secret `minio` key `azureblob-account`. |
| `medicard-prod-azureblob-account-key` | Storage account access key. | **Not written yet.** Consumed by `s3proxy` → `minio` Secret key `azureblob-key`. |
| `medicard-prod-s3proxy-credential` | Internal S3-side credential (32-char random). We mint this once — no MediCard action. | **Not written yet.** Consumed by `s3proxy` → `minio` Secret key `root-password`. |
| `medicard-prod-pg-encryption-key` + per-table keys (`-enc-medical-records`, `-enc-personal-details`, `-enc-billing-invoices`, `-enc-billing-items`, `-enc-billing-payments`) | Row 5.c.i–vii: **disputed** — MediCard says "data is plain text", MYCURE DEV rebuttal says "encrypted, keys exist". | Unresolved. Only needed once migrator is enabled and touches encrypted rows. **Non-blocker for this deploy.** |

Nothing in §3.4 blocks IaC shape. It **is** blocking pods coming up green: hapihub needs `DATABASE_URI` + `AUTH_SECRET`; s3proxy needs the `azureblob-*` pair + `s3proxy-credential`. Migrator un-pause additionally needs the source URI (and encryption keys if the data is actually encrypted).

### 3.5 Ancillary observations

- ArgoCD Git repo credential currently uses a `mycurebot` fine-grained PAT. Ponytail-correct for bootstrap; migration to a GitHub App with rotation is a follow-up.
- `grafana` HTTPRoute uses `grafana.medicardphils.com` — verify DNS on the MediCard side once (3.3) is wired; currently there is no DNS entry.
- No monitoring dashboards were customised in this run. Prometheus + Grafana came up on default values from the chart.
- Neither `hapihub-secrets` nor the s3proxy-backed `minio` Secret exist yet; both are ESO-driven and blocked on §3.1. Until then hapihub sits at `CreateContainerConfigError` — the SQLite fallback that existed briefly between commits `5a2dd9b` and `9434f1d` is gone.
- **Naming smell — deliberate.** The s3proxy chart uses `fullnameOverride: minio`, so the Service, Deployment, ReplicaSet, HTTPRoute, and Secret it manages are all named `minio` despite the workload being s3proxy talking to Azure Blob. This means the hapihub chart works without any modification. Rename-to-`hapihub-storage` cleanup is tracked as a follow-up refactor across `charts/hapihub/templates/deployment.yaml:157–199` and `charts/hapihub/templates/_helpers.tpl:193`.

### 3.6 s3proxy — object storage on native Azure Blob

MediCard requested (Infrastructure Clarifications sheet row 5.c.xii) that object storage be **native Azure Blob**, not MinIO. Delivered across three commits:

- `5a2dd9b` — Bitnami MinIO disabled + hapihub's `STORAGE_S3_*` env stripped. Pruned the MinIO Deployment/StatefulSet/PVC/ExternalSecret/HTTPRoute. Hapihub temporarily fell back to in-pod SQLite (superseded by `9434f1d`).
- `9434f1d` — New chart `charts/s3proxy/` added. Runs `andrewgaul/s3proxy:3.3.0` — a stateless S3→Azure Blob translator via jclouds' `azureblob` provider. Bytes live in native Blob; no PVC. Uses `fullnameOverride: minio` so the Service (port 9000), Deployment, and ExternalSecret-managed Secret are all named `minio`, meaning hapihub's chart branches (`hapihub.minio.enabled: true`, secretKeyRef `name: minio`) work unchanged. ArgoCD auto-discovery template `charts/argocd-applications/templates/s3proxy.yaml` spawns the `medicard-s3proxy` child Application on sync wave 2.
- `7569ab1` — Added the securityContext block (`runAsNonRoot: true`, `runAsUser: 1000`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`) required by the cluster's `restricted:latest` PodSecurity profile. Before this, the ReplicaSet controller refused to create pods with `Warning FailedCreate` events; after, pods spawn but sit at `CreateContainerConfigError` waiting on the `minio` Secret (§3.1).

**What we need from MediCard to turn s3proxy green** (all previously listed, restated for completeness):
- Populate KV `kv-mpi-sea-p-mycurex01` with:
  - `medicard-prod-azureblob-account-name` — storage account (e.g., `medicardprodstore`), dedicated per MediCard's earlier answer.
  - `medicard-prod-azureblob-account-key` — one of the two account keys.
- Confirm the storage account is on **standard commercial Azure** (not sovereign) so jclouds' default endpoint suffix works. If firewalled: allowlist the AKS cluster's egress IP (send once known).
- Blob container `monobase-files` — either MediCard creates it or we create it via s3proxy once the key is live.

The third KV entry, `medicard-prod-s3proxy-credential`, is ours to write once with a random 32-char password. Doesn't need rotation (internal-to-cluster identity), and no MediCard interaction is required.

## 4. Summary — status per deployable

| Layer | Status | Blocker (if any) |
|---|---|---|
| ArgoCD | ✅ installed, GitOps live | none |
| envoy-gateway + shared-gateway | ✅ Programmed at 172.22.40.10 | none (MediCard AG wiring is downstream) |
| external-secrets operator | ✅ Running | none |
| ClusterSecretStore `azure-secretstore` | ❌ `InvalidProviderConfig` | §3.1 (MediCard MI + SA annotation) |
| `medicard` namespace + Kyverno/PSS baseline | ✅ | none |
| hapihub | ❌ `CreateContainerConfigError` (Deployment spec references non-existent `minio` Secret + optional `hapihub-secrets`) | §3.1 (ESO to deliver `hapihub-secrets`) + §3.4 (KV entries for DATABASE_URI + AUTH_*) |
| s3proxy (object storage → Azure Blob) | ❌ `CreateContainerConfigError` (Deployment references non-existent `minio` Secret) | §3.1 + §3.4 (`medicard-prod-azureblob-account-name`/`-key` + our `medicard-prod-s3proxy-credential`) |
| mycure | ✅ 1/1 Running | none (no ext-secret dep) |
| hapihub-migrator | ✅ Deployed, 0/0 replicas — **paused** | none (by design) |
| monitoring stack | ✅ | none |

## 5. Cluster-side artifacts left behind

Contrary to the prior connectivity probes, **this run leaves everything in place** — that's the point. Retained artifacts:

- 6 namespaces (§2.4).
- ArgoCD 7.7.12 + argocd-bootstrap chart (Applications + ApplicationSet).
- 1 GitHub PAT Secret (`argocd/argocd-repo-medicard`) — rotate when the mycurebot token rotates.
- All infrastructure Applications (envoy-gateway, external-secrets, monitoring, etc.).
- All `medicard-*` child Applications and their reconciled resources.
- No PVCs bound: PG is external, MongoDB Atlas is external, MinIO/s3proxy are stateless. No stray data on any upstream DB.
- No mutating calls were made against `mpiazeppgdb0003` or `mycure-stg-sh` MongoDB Atlas from this deploy — hapihub hasn't successfully reached either DB, migrator is at 0.

Rollback (if desired): the destructive path from the plan file — `helm uninstall argocd-bootstrap && kubectl delete applicationsets,applications -n argocd --all --cascade=foreground && helm uninstall argocd -n argocd && kubectl delete ns argocd envoy-gateway-system external-secrets-system gateway-system medicard monitoring` — returns the cluster to the pre-bootstrap state (system namespaces only, matching the 2026-07-07 connectivity report's environment fingerprint).

---

## Appendix A — Commit + command chronology (all 2026-07-07)

### Initial bootstrap — commits `7dcd9aa` (staging pin) + `e94344c` (prod values)

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

### Follow-up commits (same day, in order)

- **`5a2dd9b` — MinIO disabled.** `values/deployments/medicard.yaml`: `minio.enabled: false` + `hapihub.minio.enabled: false`. ArgoCD auto-pruned the `medicard-prod-minio` Application and its resources; hapihub restarted onto in-pod SQLite (transient — superseded by `9434f1d`).
- **`1728194` — Phase 0 namespace rename.** `global.namespace: medicard-prod` → `medicard`. ArgoCD renamed all `medicard-prod-*` Applications to `medicard-*`, moved workloads into the pre-existing `medicard` shell, and the empty `medicard-prod` namespace was pruned. Reconciliation on cluster was driven by a hard-refresh annotation on `medicard-root`.
- **`9434f1d` — s3proxy chart landed.** New `charts/s3proxy/` + `charts/argocd-applications/templates/s3proxy.yaml` + values changes flipping `hapihub.minio.enabled` back on and adding the `s3proxy:` block. See §3.6.
- **`7569ab1` — PSS securityContext fix.** Added `runAsNonRoot: true`, `runAsUser: 1000`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault` to the s3proxy Deployment so PSS `restricted:latest` admits the pod.

All post-bootstrap changes were delivered via git push → ArgoCD auto-sync (occasionally kicked with `kubectl -n argocd annotate application <name> argocd.argoproj.io/refresh=hard --overwrite`). No further `helm upgrade` on the prod cluster was needed after the initial bootstrap.

## Appendix B — Environment fingerprint at time of test

- **Cluster:** `aks-mpi-sea-p-mycurex01`
- **Kubernetes API server:** `https://aks-mpi-sea-p-mycurex01-dns-ib3b6bgj.996c88f8-39f9-4501-9694-b5cbfda6f629.privatelink.southeastasia.azmk8s.io:443` (Azure Private Link)
- **Bastion:** `SEA-VM-STG-MYCURE-WEB` (user `mycurex`, IP 172.23.4.8), kubectl v1.31.0 preconfigured, helm v3.16.3 installed to `~/bin` during this run.
- **ArgoCD version:** `argo-cd` Helm chart `7.7.12` (app version `v2.13.2`).
- **Envoy Gateway version:** `v1.2.0`.
- **External Secrets Operator version:** `0.9.11`.
- **Repo revision at snapshot:** `main` @ `7569ab1` (`fix(s3proxy): satisfy Pod Security Standard restricted profile`).
- **Test date / time:** 2026-07-07 (Asia/Manila).
