# MediCard "Staging AKS" bastion access defaults to the PROD cluster (2026-10-08)

## Summary

MediCard shipped a bastion access path for the MYCURE X **staging** AKS
(monobase-mycure#4521, PDF "How to Access MyCureX Staging AKS via Bastion").
Following it lands you on the **PRODUCTION** cluster by default.

The jump host behind the shared bastion link (`vm-mpi-sea-p-mycure01`,
`172.22.40.12`) sits in the **prod** AKS subnet, and its kubeconfig carries **two**
contexts with **prod set as the current/default one**. So a plain `kubectl …` on
that box talks to prod, not staging. The two context *names* differ only by a
single `p`/`a` character, which is easy to misread. The **staging** cluster is
reachable, but only when you explicitly pass `--context aks-mpi-sea-a-mycurex01`.

This is the same class of trap as the 2026-09-11 re-point report: **the context
name is not a reliable indicator of which physical cluster you're on** — verify by
fingerprint. We did not change anything on the jump host.

## Access path (as verified)

Azure Bastion shareable URL → SSH jump host `vm-mpi-sea-p-mycure01` (VM creds
`mycureadm`) → on the box `az login` as `service.mycure@medicardphils.com`
(authenticator MFA required) → tenant *MEDICard Philippines Inc.*
(`31e62360-d307-45a7-932a-f774aa7a6288`), subscription
`55e4144e-b310-4f7a-b583-542f534cbc98`.

Notes:
- The PDF's bastion link GUID is line-wrapped and drops a hyphen — the working
  link ends `…995a-f27b050fbc24`. As pasted it 404s to "shareable URL not found".
- `az aks get-credentials` **fails** for `service.mycure@medicardphils.com`
  (`AuthorizationFailed`, missing `Microsoft.ContainerService/managedClusters/listClusterUserCredential/action`
  — the *AKS Cluster User Role*). Access works today only via the kubeconfig
  already provisioned on the box.

## Evidence (read-only)

Two contexts in the jump-box kubeconfig, **prod is current (`*`)**:

```
          aks-mpi-sea-a-mycurex01   clusterUser_rg-mpi-sea-a-mycurex-resource01_aks-mpi-sea-a-mycurex01
*         aks-mpi-sea-p-mycurex01   clusterUser_rg-mpi-sea-p-mycurex-resource01_aks-mpi-sea-p-mycurex01
```

API servers registered in that kubeconfig:
- staging: `https://aks-mpi-sea-a-mycurex01-dns-jw2em7hl.hcp.southeastasia.azmk8s.io:443` (public HCP endpoint)
- prod:    `https://aks-mpi-sea-p-mycurex01-dns-ib3b6bgj.<guid>.privatelink.southeastasia.azmk8s.io:443` (private link)

Fingerprint of each physical cluster (confirmed, not inferred from the name):

| Attribute | Default context `…-p-…` (PROD) | `--context …-a-…` (STAGING) |
|-----------|--------------------------------|------------------------------|
| Node pools | `agentpool` + `userpool` (`34798594`) | `newpool` (`16889436`) + `systempool` (`32494558`) |
| Kubernetes version | **v1.35.6** | **v1.32.11** |
| Node subnet (INTERNAL-IP) | `172.22.40.x` (prod AKS subnet) | `10.244.x` pod net; nodes in staging VNet |
| Node resource group (providerID / `kubernetes.azure.com/cluster`) | `mc_rg-mpi-sea-**p**-mycurex-resource01_aks-mpi-sea-p-mycurex01_southeastasia` | `…-**a**-mycurex-resource01_aks-mpi-sea-a-mycurex01` |
| App namespace | `medicard` (s3proxy, valkey, velero) | `medicard-staging` (hapihub 11.2.9, mycureapp, MinIO in-cluster, mailpit) |
| hapihub `DATABASE_URI` host | `mpiazeppgdb0003.postgres.database.azure.com` (private `172.22.25.x`) | `mpiazeapgdb0002.postgres.database.azure.com` (public `4.194.210.116`) |
| Gateway HTTPRoutes | `api/cms/storage-mycurex.medicardphils.com` | `api/cms/storage-mycurex-dev.medicardphils.com` |
| Internal LB IP | (prod) | `172.23.32.5` (Envoy shared gateway) |

The jump host itself (`vm-mpi-sea-p-mycure01`, `172.22.40.12`) is in the prod
subnet — i.e. the access box is provisioned on the prod side, with a staging
context added on top.

## How to check which cluster you are on

Do **not** trust `current-context` by name (p vs a is one character). Verify by
fingerprint before running anything that matters:

```bash
# 1. which contexts exist, which is default
kubectl config get-contexts

# 2. authoritative identity — the node's Azure resource group encodes p/a + cluster name
kubectl get nodes -o jsonpath='{.items[0].spec.providerID}{"\n"}'
#   …/resourceGroups/mc_rg-mpi-sea-P-mycurex-resource01_aks-mpi-sea-p-mycurex01_…  -> PROD
#   …/resourceGroups/mc_rg-mpi-sea-A-mycurex-resource01_aks-mpi-sea-a-mycurex01_…  -> STAGING

# 3. quick corroborating tells
kubectl get nodes            # agentpool/userpool + v1.35.6 = PROD ; newpool/systempool + v1.32.11 = STAGING
kubectl get ns | grep medicard   # 'medicard' only = PROD ; 'medicard-staging' present = STAGING cluster

# 4. to TARGET staging explicitly (does not change the box default):
kubectl --context aks-mpi-sea-a-mycurex01 get nodes
```

A plain `kubectl get nodes` on this box returns the **prod** node set. If you
intend to operate on staging you must add `--context aks-mpi-sea-a-mycurex01` to
every command (or `kubectl config use-context …`, but that mutates the shared
box's default and will affect other operators).

## What we did NOT do

Per MediCard owning/controlling this environment: **no remediation attempted** —
no `az aks get-credentials`, no `use-context`, no kubeconfig edit, no workload
changes. All probes were read-only (`get`, `config view`, and a non-destructive
`SELECT`-only Postgres size check via the staging hapihub pod). This report is
observation only.

## Questions for MediCard

1. Is the access path **intended** to default to prod, with staging reached via an
   explicit `--context aks-mpi-sea-a-mycurex01`? Or should the staging context be
   the default on the jump host for a "staging access" deliverable?
2. Please grant `service.mycure@medicardphils.com` the **Azure Kubernetes Service
   Cluster User Role** on `aks-mpi-sea-a-mycurex01` so we can run
   `az aks get-credentials` ourselves instead of relying on the pre-provisioned
   kubeconfig.
3. Is a single shared jump host (prod-subnet) with both prod and staging contexts
   the intended topology, given the one-character name difference makes a
   wrong-cluster action easy?

## Related

- monobase-mycure#4521 — "Check Access To STG AKS Cluster" (this task; access +
  staging checklist verification + proof screenshots).
- [`2026-09-11-medicard-prod-cluster-access-repointed.md`](./2026-09-11-medicard-prod-cluster-access-repointed.md)
  — same "context name ≠ physical cluster" trap; the `newpool/systempool / v1.32.11`
  fingerprint seen there is now confirmed to be the **staging** cluster.
- Memory: `medicard-stg-aks-access-path`, `medicard-infra-report-dont-remediate`.
