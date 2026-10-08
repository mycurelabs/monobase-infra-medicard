# MediCard MYCURE X — Staging AKS deployment checklist verification (2026-10-08)

## Summary

Re-ran the prod migration requirements checklist (the Q&A sheet MediCard answered
before the initial migration) against the **live staging** environment, adapted to
staging naming (`p-`→`a-`, `*-mycurex`→`*-mycurex-dev`, `medicard-prod-*`→
`medicard-staging-*`). Context: monobase-mycure#4521.

**Result:** core staging platform is healthy and matches the intended design —
AKS reachable, Workload-Identity/ESO→Key Vault working, internal LB + `-dev`
routes in place, Postgres reachable from the cluster. Several items **differ from
the prod pattern or are not provisioned** (public-networked PG, no external
gateway/DNS/TLS, Vault holds only the MinIO secret, ~2.2 TB of data in "staging").

> Access caveat (see companion report): the jump box's **default kubectl context
> is PROD**. All staging checks below were run with an explicit
> `--context aks-mpi-sea-a-mycurex01`. See
> [`2026-10-08-medicard-stg-aks-access-defaults-to-prod.md`](./2026-10-08-medicard-stg-aks-access-defaults-to-prod.md).

## Method

- Access: Azure Bastion → jump host `vm-mpi-sea-p-mycure01` → `kubectl
  --context aks-mpi-sea-a-mycurex01` (staging). Driven headless via Playwright
  against the browser SSH terminal.
- All probes **read-only**: `kubectl get/config`, `kubectl exec` env reads, and a
  non-destructive `SELECT`-only Postgres size query via a pure-stdlib SCRAM client
  run inside the staging `hapihub` pod (`DATABASE_URI` from pod env — creds never
  left the pod). No writes, no resource creation, no config changes.

## Checklist (verified against live staging)

Legend: ✅ verified · ⚠️ works-but-differs / partial · ❌ missing/blocked ·
ℹ️ process / client-side (not independently verifiable by us).

### 1. Private network access
- **1.a Access method** ✅ Azure Bastion shareable URL → SSH jump host
  `vm-mpi-sea-p-mycure01`. (PDF link GUID drops a hyphen → use `…995a-f27b050fbc24`.)
- **1.b Owner** ℹ️ MediCard Infra.
- **1.c–1.e Onboarding / cred delivery / turnaround** ℹ️ process; creds delivered in #4521.
- **1.f Session/audit limits** ℹ️ unspecified ("MediCard standard controls").

### 2. AKS credentials / kubeconfig (STG)
- **2.a Retrieve kubeconfig** ⚠️ `az aks get-credentials … aks-mpi-sea-a-mycurex01`
  **fails** for our account (`AuthorizationFailed`). Works today only via the
  kubeconfig already on the jump box.
- **2.b Identity** ✅ AAD `service.mycure@medicardphils.com` (tenant *MEDICard Philippines Inc.*).
- **2.c RBAC roles** ❌ account lacks **AKS Cluster User Role** (`listClusterUserCredential/action`).
- **2.d AAD vs cert** ✅ AAD-based (`clusterUser` contexts).
- **2.e API server** ✅ `aks-mpi-sea-a-mycurex01-dns-jw2em7hl.hcp.southeastasia.azmk8s.io:443`
  (public HCP endpoint, AAD-gated; prod is privatelink).

### 3. PostgreSQL (STG target)
- **3.a Connection** ✅ hapihub `DATABASE_URI` → `mpiazeapgdb0002.postgres.database.azure.com:5432/postgres`, TCP reachable from the cluster.
- **3.b Roles** ℹ️ single role (`mpadmin02` / `postgres`).
- **3.c TLS mode** ✅ `sslmode=require`.
- **3.d FQDN resolves from inside AKS** ✅ resolves from the hapihub pod → `4.194.210.116` (⚠️ **public** IP — not a private endpoint).
- **3.e Capacity** ✅ read-only SCRAM probe: server total ≈ **2264 GB**, essentially all in `postgres`. ⚠️ ~2.2 TB in staging — confirm intended.

### 4. MongoDB source
- N/A — staging hapihub is **v11 (PG-only)**; `mongodb.enabled=false`, no migrator in the staging runtime. Relevant only to migration activities.

### 5.a Azure resources
- **5.a.i AKS** ✅ `aks-mpi-sea-a-mycurex01`, southeastasia, **v1.32.11**, nodes `aks-newpool` + `aks-systempool` Ready.
- **5.a.ii OIDC / Workload Identity** ✅ working (ESO authenticates to KV via WorkloadIdentity → OIDC issuer + WI enabled).
- **5.a.iii VNet / subnet / internal LB IP** ✅ internal LB **`172.23.32.5`** (Envoy shared gateway), staging subnet `172.23.32.0/23`.
- **5.a.iv AKS→PG connectivity** ⚠️ reachable (TCP_OK) but over **public** IP, not a private endpoint.
- **5.a.v AKS→Mongo** N/A.
- **5.a.vi PG Flexible Server** ✅ `mpiazeapgdb0002`, sslmode require, admin `mpadmin02`, `postgres` DB ≈ 2264 GB. (Azure-side storage tier/HA not SQL-queryable; RBAC blocks `az`.)
- **5.a.vii Mongo shared/separate** N/A.

### 5.b Azure Key Vault
- **5.b.i Vault URL** ✅ `https://kv-mpi-sea-a-mycurex01.vault.azure.net` (ESO store `Valid`/`Ready`).
- **5.b.ii Tenant ID** ✅ `31e62360-d307-45a7-932a-f774aa7a6288`.
- **5.b.iii ESO MI client-id** ✅ `d6b958ed-790e-4a8a-9ce0-10aa6c0776b8` (on `external-secrets` SA).
- **5.b.iv Federated identity binding** ✅ working (`external-secrets-system/external-secrets`).
- **5.b.v Vault RBAC (get/list)** ✅ working (`minio-credentials` ExternalSecret `SecretSynced=True`).

### 5.c KMS / encryption keys & app secrets in Vault
- ⚠️ **Only `medicard-staging-minio-root-password` is in the staging Vault via ESO.** Not provisioned:
  - ❌ `pg-encryption-key` + per-table enc keys (`enc-medical-records`, `enc-personal-details`, `enc-billing-invoices`, `enc-billing-items`, `enc-billing-payments`). (hapihub v11 is PG-only; PG PII stored plaintext per audit CRYPTO-1.)
  - ❌ `AUTH_SECRET` / `BETTER_AUTH_SECRET` not synced via ESO.
  - ❌ `DATABASE_URI` not in KV — injected directly into hapihub (not via ESO). Same for `pg-target-uri` / `mongo-source-uri`.
  - ✅ `minio-root-password` present & synced.

### 5.d External gateway / TLS / DNS
- **5.d.i Pattern** ⚠️ internal LB exists (`172.23.32.5`); **no external gateway / public exposure**.
- **5.d.ii Hostnames** ✅ HTTPRoutes `api-mycurex-dev`, `cms-mycurex-dev`, `storage-mycurex-dev`. ❌ `pxp-mycurex-dev` not configured.
- **5.d.iii/iv TLS & DNS** ❌ staging FQDNs **NXDOMAIN** in public DNS (prod `*-mycurex` resolves via Traffic Manager → `20.212.27.66`). Staging internal-only.

### 5.e Container registry pull access
- **5.e.i ghcr.io egress** ✅ `ghcr.io/mycurelabs/hapihub:11.2.9` + `…/mycureapp:10.4.2` Running; docker.io (MinIO, mailpit) also pulls. Egress unrestricted.

### 6. PG / Mongo egress whitelisting
- **6.a PG egress** ✅ cluster reaches staging PG (TCP_OK); public-networked, firewall already permits cluster egress.
- **6.b Mongo** N/A.
- **6.c Private DNS zones** ⚠️ staging PG resolves to a **public** IP — no private endpoint / private DNS zone (prod uses one).

## How to re-check (read-only)

```bash
C="--context aks-mpi-sea-a-mycurex01"; N=medicard-staging

# identity (don't trust the context name — verify by node resource group)
kubectl $C get nodes -o jsonpath='{.items[0].spec.providerID}{"\n"}'   # expect mc_rg-mpi-sea-A-...
kubectl $C get nodes                                                    # newpool/systempool + v1.32.11 = staging

# workloads + routes + internal LB
kubectl $C -n $N get pods
kubectl $C get httproute -A | grep mycurex-dev
kubectl $C -n envoy-gateway-system get svc | grep LoadBalancer         # EXTERNAL-IP 172.23.32.5

# ESO → Key Vault health + identity + which secrets sync
kubectl $C get clustersecretstore -o wide                              # azure-secretstore Valid/Ready
kubectl $C -n $N get externalsecret                                    # minio-credentials SecretSynced
kubectl $C -n external-secrets-system get sa external-secrets -o jsonpath='{.metadata.annotations}'

# Postgres target + reachability (host only; creds stay in the pod)
H=$(kubectl $C -n $N get pod -o name | grep -m1 hapihub)
kubectl $C -n $N exec $H -- python3 -c 'import os,urllib.parse as u;p=u.urlparse(os.environ["DATABASE_URI"]);print(p.hostname,p.port)'

# container images (ghcr egress)
kubectl $C -n $N get pods -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' | sort -u

# public DNS (expect NXDOMAIN for staging)
dig +short @8.8.8.8 api-mycurex-dev.medicardphils.com
```

PG size (read-only) was obtained with a pure-stdlib SCRAM client executed inside
the hapihub pod (`python3`; no psql/driver exists on the box or pod) — see memory
`prod-pg-query-route-scram-python` for the method.

## What we did NOT do

Read-only throughout. No `az aks get-credentials`, no `use-context`, no kubeconfig
edit, no workload/secret/DB writes, no resource creation. MediCard owns the
environment — findings are reported, not remediated.

## Gaps / items to raise with MediCard

1. ⚠️ Access defaults to **prod** — staging needs explicit `--context aks-mpi-sea-a-mycurex01` (companion report).
2. ❌ Grant `service.mycure@medicardphils.com` the **AKS Cluster User Role** on `aks-mpi-sea-a-mycurex01`.
3. ⚠️ Staging PG is **public-networked** (`mpiazeapgdb0002` → public IP + firewall), not a private endpoint.
4. ❌ **No external gateway / public DNS / TLS** for staging (`*-mycurex-dev` = NXDOMAIN); `pxp-mycurex-dev` route missing.
5. ⚠️ Vault holds **only the MinIO password** for staging (DATABASE_URI/auth/enc keys not in KV via ESO).
6. ⚠️ **~2.2 TB** in staging PG — confirm the data volume is intended for STG.

## Related

- monobase-mycure#4521 — "Check Access To STG AKS Cluster" (task + proof screenshots in the checklist comment).
- [`2026-10-08-medicard-stg-aks-access-defaults-to-prod.md`](./2026-10-08-medicard-stg-aks-access-defaults-to-prod.md) — companion access report.
- Memory: `medicard-stg-aks-access-path`, `prod-pg-query-route-scram-python`, `medicard-infra-report-dont-remediate`.
