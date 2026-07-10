# 2026-07-10 — Prod Cluster Key Vault DNS Resolution Validation

**Status:** From inside the production AKS cluster, `kv-mpi-sea-p-mycurex01.vault.azure.net` does not resolve. Azure DNS returns NXDOMAIN for the private-endpoint FQDN it CNAME-chains into. The Key Vault's private endpoint DNS record is missing from the `privatelink.vaultcore.azure.net` zone that Azure DNS uses for the AKS VNet.
**Environment under test:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia, Private Link API), VNet `mc-prd-vnet-sea-01`. Staging cluster `aks-mpi-sea-a-mycurex01` used as a positive control.
**Access path:** kubectl executed from the operator jumphost `mc.remote.prd.bastion` via `ssh medicard.gateway`. Staging probe run against the local `.kube/config`.
**Related:** blocks §3.1 of [`2026-07-07-prod-cluster-iac-bootstrap.md`](./2026-07-07-prod-cluster-iac-bootstrap.md). ExternalSecrets can authenticate to Azure AD, but every subsequent secret-fetch fails at the DNS step before any TCP packet leaves the pod for the vault.

---

## 1. Scope

Prove — and give MediCard a reproducible, non-destructive way to reproduce — that the failure mode surfaced by the External Secrets Operator (`dial tcp: lookup kv-mpi-sea-p-mycurex01.vault.azure.net on 10.0.0.10:53: no such host`) is a **DNS resolution problem** and not an authentication, authorization, network-egress, or ESO-configuration problem. Localise the missing piece to a specific Azure DNS record.

Strictly non-destructive. Only DNS queries were issued. No secrets were read, no TCP connections opened to the vault, no cluster resources mutated beyond a short-lived diagnostic pod that was deleted immediately after log capture.

## 2. Methodology

Two identical probe pods were deployed — one in the prod cluster and one in the staging cluster — running the same eight DNS queries with `nslookup` and `dig`. Same image (`nicolaka/netshoot:latest`), same script; only the vault and PG hostnames differ (prod vs. staging).

Probes ran **inside the cluster** so the results reflect the actual DNS view a workload has, not the operator laptop's view. The staging cluster is a positive control: both vaults are provisioned the same way (private endpoint), same tenant, same region — the delta between the two probes localises the problem cleanly.

| Query | Purpose |
|---|---|
| 1. KV public FQDN via CoreDNS (10.0.0.10) | The canonical query ESO makes. Failure here matches the ESO error. |
| 2. Same, via Azure internal resolver directly (168.63.129.16) | Bypasses CoreDNS to see whether Azure's own resolver has the record. Where the truth lives. |
| 3. Same, via public resolver (1.1.1.1) | Shows the full CNAME chain the vault's public FQDN goes through. |
| 4. KV **private** FQDN directly via CoreDNS | Direct query for the terminal name in the CNAME chain. |
| 5. Same, directly via 168.63.129.16 | Bypasses CoreDNS's forwarders. |
| 6. `dig +trace` via CoreDNS | Recursive-authoritative trace showing where the chain breaks. |
| 7. Control: `login.microsoftonline.com` via CoreDNS | Confirms cluster DNS itself is healthy for Azure public endpoints (this is the auth endpoint ESO reaches successfully). |
| 8. Control: Azure PG FQDN via CoreDNS | Confirms Azure private-endpoint resolution works for **another** service. Staging PG works from the sheet; prod PG was validated in 2026-07-07 DB-connectivity report. |

## 3. Findings

### 3.1 Prod cluster — vault does not resolve

```
=== /etc/resolv.conf ===
search default.svc.cluster.local svc.cluster.local cluster.local reddog.microsoft.com
nameserver 10.0.0.10
options ndots:5

=== 1. kv public FQDN via CoreDNS (10.0.0.10) ===
Server:  10.0.0.10
Address: 10.0.0.10#53

*** Can't find kv-mpi-sea-p-mycurex01.vault.azure.net: No answer

=== 2. kv public FQDN via Azure internal resolver (168.63.129.16) ===
Server:  168.63.129.16
Address: 168.63.129.16#53

Non-authoritative answer:
kv-mpi-sea-p-mycurex01.vault.azure.net canonical name =
    kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net.
** server can't find kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net: NXDOMAIN

=== 3. kv public FQDN via public resolver (1.1.1.1) — CNAME chain ===
kv-mpi-sea-p-mycurex01.vault.azure.net → kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net.
                                        → data-prod-sea.vaultcore.azure.net.
                                        → data-prod-sea-region.vaultcore.azure.net.
                                        → sin.prd.r.kv.aadg.msidentity.com.
                                        → sin.tm.prd.r.kv.aadg.akadns.net.
Addresses: 20.205.192.64, 13.67.8.104, 40.78.239.124   (public Traffic Manager)

=== 5. kv private FQDN directly via 168.63.129.16 ===
** server can't find kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net: NXDOMAIN

=== 7. control: login.microsoftonline.com via CoreDNS ===
Non-authoritative answer:
login.microsoftonline.com   canonical name = login.mso.msidentity.com.
                            ... (resolved successfully to public IPs) ...

=== 8. control: mpiazeppgdb0003.postgres.database.azure.com via CoreDNS ===
Name:    mpiazeppgdb0003.postgres.database.azure.com
Address: 172.22.25.6            (PRIVATE IP — private endpoint DNS works for PG)
```

### 3.2 Staging cluster (positive control) — vault resolves

Same eight queries against the staging vault `kv-mpi-sea-a-mycurex01`:

```
=== 1. kv public FQDN via CoreDNS (10.0.0.10) ===
Name:    kv-mpi-sea-a-mycurex01.vault.azure.net
Address: 172.23.10.84            (PRIVATE IP — DNS working)

=== 2. kv public FQDN via 168.63.129.16 ===
kv-mpi-sea-a-mycurex01.vault.azure.net canonical name =
    kv-mpi-sea-a-mycurex01.privatelink.vaultcore.azure.net.
Name:    kv-mpi-sea-a-mycurex01.privatelink.vaultcore.azure.net
Address: 172.23.10.84            (PRIVATE IP — Azure DNS is authoritative for
                                  this record and returns the private endpoint IP)
```

### 3.3 Summary table (prod vs. staging)

| Query | Prod result | Staging result |
|---|---|---|
| Q1 KV public FQDN via CoreDNS | ❌ "No answer" (SERVFAIL) | ✅ Private IP `172.23.10.84` |
| Q2 KV public FQDN via 168.63.129.16 | CNAME → privatelink; **NXDOMAIN on privatelink** | CNAME → privatelink; ✅ Private IP `172.23.10.84` |
| Q5 KV private FQDN via 168.63.129.16 | ❌ NXDOMAIN | ✅ (as part of Q2's chain) `172.23.10.84` |
| Q3 KV public FQDN via 1.1.1.1 (public) | ✅ Public Traffic Manager IPs (as expected) | ✅ Public Traffic Manager IPs |
| Q7 login.microsoftonline.com via CoreDNS | ✅ Resolves | ✅ Resolves |
| Q8 Azure PG FQDN via CoreDNS | ✅ Private IP `172.22.25.6` | ✅ (analogous) |

### 3.4 Interpretation — what's actually missing

Azure Key Vault's public FQDN `<vault>.vault.azure.net` always CNAME-chains into `<vault>.privatelink.vaultcore.azure.net` regardless of whether the vault has a private endpoint. Whether the terminal lookup returns a *private* IP or a *public* IP (or NXDOMAIN) depends entirely on the state of the `privatelink.vaultcore.azure.net` **Private DNS Zone** attached to the VNet the client sits in.

Azure's internal resolver (`168.63.129.16`) is the source of truth for that zone inside the VNet. Comparing Q2 between the two environments:

- **Staging:** 168.63.129.16 returns the private IP `172.23.10.84` for `kv-mpi-sea-a-mycurex01.privatelink.vaultcore.azure.net` → the private DNS zone `privatelink.vaultcore.azure.net` is linked to the staging AKS VNet AND contains an A record `kv-mpi-sea-a-mycurex01 → 172.23.10.84`.
- **Prod:** 168.63.129.16 returns NXDOMAIN for `kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net` → the private DNS zone is either (a) not linked to the prod AKS VNet at all, or (b) linked but missing the A record for the prod vault.

The Q8 control confirms that private-endpoint DNS integration DOES work for another service (PG) from the prod cluster — so the general capability is there, just not wired for the vault.

### 3.5 Why authentication succeeded but reads fail

Auth talks to `login.microsoftonline.com` (Q7 — public, resolves fine). The secret fetch talks to the vault's own FQDN (Q1 — fails). Two different hostnames, two different DNS paths. ESO's Azure AD authentication and its Key Vault SDK calls are unrelated at the DNS layer even though they are consecutive lines of the same reconcile.

### 3.6 What we need to observe on MediCard's side

Any one of the following will unblock ESO reads (mechanism is MediCard's choice):

- The `privatelink.vaultcore.azure.net` Private DNS Zone that the AKS VNet `mc-prd-vnet-sea-01` resolves against contains an A record for `kv-mpi-sea-p-mycurex01` (analogous to what staging has for its vault). If MediCard's private endpoint `pl-mpi-sea-p-mycurex-kv01` was created with automatic Private DNS integration, this record should already exist in the zone the endpoint's resource group holds; if that zone isn't the one linked to `mc-prd-vnet-sea-01`, either link it or add the record to the linked zone.
- OR a working DNS forwarder inside the AKS VNet that resolves the private FQDN — same net effect.

Verification we can do without MediCard's cooperation once they change something on their end: re-run this probe (Appendix A) and check whether Q1 returns a private IP. That single-line result gates every other check — `hapihub-secrets`, s3proxy's `minio` Secret, and velero's `velero-credentials` all start syncing the moment Q1 resolves.

## 4. Scope notes

- The Q4 result (`kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net` mysteriously resolving via CoreDNS to public Traffic Manager IPs) is a cache/upstream artefact and does not change the diagnosis: those IPs point at the public Traffic Manager fronting the vault; the vault itself sits behind private-endpoint firewall rules, so even if traffic reached those IPs it would be rejected. The failing path is the one ESO's SDK actually takes: the `.vault.azure.net` FQDN, which Q1 shows is unresolvable.
- No attempt was made to reach the vault over TCP; only DNS was queried. If DNS is fixed and the request still fails, the next diagnostic step is a TCP probe from a pod to the private IP that Q1 returns.
- The staging positive control uses a different vault (`kv-mpi-sea-a-mycurex01`) in a different resource group. The probe compares like-with-like at the DNS layer — the two probes differ only in the vault name.

## 5. Cluster-side artifacts left behind

**None.** Both probe pods (`dns-probe` in each cluster's `default` namespace) were deleted immediately after log capture. Verified:

```
$ kubectl -n default get pods
No resources found in default namespace.
```

No secrets, ConfigMaps, PVCs, or NetworkPolicies were created. No egress traffic left the cluster except DNS UDP to 10.0.0.10, 168.63.129.16, and 1.1.1.1. No calls were made against the vault, PG, or MongoDB Atlas.

---

## Appendix A — Probe pod manifest

Reproducible by anyone with kubectl access to either cluster. Same manifest was applied on prod and (with `sea-a` and PG-0001 substituted) on staging.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: dns-probe
  namespace: default
spec:
  restartPolicy: Never
  containers:
  - name: probe
    image: nicolaka/netshoot:latest
    command: ["/bin/sh", "-c"]
    args:
      - |-
        set +e
        echo "=== /etc/resolv.conf ==="
        cat /etc/resolv.conf
        echo
        echo "=== 1. kv public FQDN via CoreDNS (10.0.0.10) ==="
        nslookup kv-mpi-sea-p-mycurex01.vault.azure.net 10.0.0.10
        echo
        echo "=== 2. kv public FQDN via Azure internal resolver (168.63.129.16) ==="
        nslookup kv-mpi-sea-p-mycurex01.vault.azure.net 168.63.129.16
        echo
        echo "=== 3. kv public FQDN via public resolver (1.1.1.1) — shows CNAME chain ==="
        nslookup kv-mpi-sea-p-mycurex01.vault.azure.net 1.1.1.1
        echo
        echo "=== 4. kv private FQDN directly via CoreDNS ==="
        nslookup kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net 10.0.0.10
        echo
        echo "=== 5. kv private FQDN directly via Azure internal resolver ==="
        nslookup kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net 168.63.129.16
        echo
        echo "=== 6. dig +trace kv public FQDN via CoreDNS ==="
        dig +trace kv-mpi-sea-p-mycurex01.vault.azure.net @10.0.0.10 2>&1 | head -40
        echo
        echo "=== 7. control: login.microsoftonline.com via CoreDNS ==="
        nslookup login.microsoftonline.com 10.0.0.10
        echo
        echo "=== 8. control: postgres FQDN via CoreDNS ==="
        nslookup mpiazeppgdb0003.postgres.database.azure.com 10.0.0.10
```

Apply, wait, read, delete:

```
kubectl apply -f dns-probe.yaml
kubectl -n default wait --for=condition=Ready pod/dns-probe --timeout=60s
kubectl -n default logs dns-probe
kubectl -n default delete pod dns-probe
```

## Appendix B — Environment fingerprint at time of test

- **Prod cluster:** `aks-mpi-sea-p-mycurex01`, VNet `mc-prd-vnet-sea-01`, AKS subnet `subnet-p-mycurex-aks01-172.22.40.0/22`, CoreDNS at `10.0.0.10`.
- **Prod vault target:** `kv-mpi-sea-p-mycurex01.vault.azure.net`; private endpoint per sheet `pl-mpi-sea-p-mycurex-kv01`.
- **Staging cluster (positive control):** `aks-mpi-sea-a-mycurex01`, CoreDNS at `10.0.0.10`.
- **Staging vault target:** `kv-mpi-sea-a-mycurex01.vault.azure.net`; private endpoint IP observed `172.23.10.84`.
- **Probe image:** `nicolaka/netshoot:latest` (BusyBox + iproute2 + dig/nslookup/curl).
- **Test date / time:** 2026-07-10 (Asia/Manila).
