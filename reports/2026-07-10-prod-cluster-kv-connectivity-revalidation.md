# 2026-07-10 — Prod Cluster Key Vault Connectivity Revalidation (round 2)

**Status:** DNS is now resolving from inside the AKS cluster. `az login` via workload identity succeeds. The very next step (list/get against the vault) fails with an Azure RBAC "Forbidden" — no role assignment for the UAMI on the prod vault. Auth path works; authorization path does not. Application-layer workloads (hapihub, s3proxy, velero) remain queued on that single narrower blocker.
**Environment under test:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia, Private Link API), VNet `mc-prd-vnet-sea-01`.
**Access path:** kubectl executed from `mc.remote.prd.bastion` via `ssh medicard.gateway`.
**Prior state:** see [`2026-07-10-prod-cluster-kv-dns-resolution-validation.md`](./2026-07-10-prod-cluster-kv-dns-resolution-validation.md) (round 1) — DNS did not resolve from inside the cluster; all reads failed at the DNS step.

**Scope disclaimer.** As with round 1, this report is a read-only diagnostic. Any observations about "where the fix might live" are suggested areas for MediCard to investigate, not prescriptions. Diagnosis and remediation are on MediCard's side.

---

## 1. Scope

Round-2 validation after MediCard's Paul Vincent Garcia posted a screenshot (2026-07-10) showing the vault's FQDN now resolving from his workstation to `172.22.26.6`. Re-run the same two probes from round 1 (DNS probe + full read-lifecycle probe) from inside the prod AKS cluster to observe:

- whether the DNS fix propagates to the cluster's network path (CoreDNS at `10.0.0.10` forwarding to Azure DNS `168.63.129.16`), which is different from `psgarcia`'s workstation path (resolver `172.21.1.4`);
- whether the full read pipeline now succeeds end-to-end;
- if not, where in the pipeline the next failure sits.

Strictly non-destructive. Same probe manifests as round 1 (Appendices A1/A2 of the prior report), same cleanup discipline.

## 2. Methodology

Identical to round 1. Probe 1 (`dns-probe`, `default` namespace, `nicolaka/netshoot`) issues the same DNS queries. Probe 2 (`kv-probe`, `external-secrets-system` namespace, `mcr.microsoft.com/azure-cli`, running as ESO's own SA via workload identity) attempts `az login` → `az keyvault secret list` → `az keyvault secret show`. Values sampled and reported as lengths only; never printed.

Because the two probes are the same as round 1, the full manifests are not re-included here — refer to Appendices A1/A2 of the [round-1 report](./2026-07-10-prod-cluster-kv-dns-resolution-validation.md).

## 3. Findings

### 3.1 DNS layer — resolves now

```
=== 1. kv public FQDN via CoreDNS (10.0.0.10) ===
Server:  10.0.0.10
Address: 10.0.0.10#53

Name:    kv-mpi-sea-p-mycurex01.vault.azure.net
Address: 172.22.26.6

=== 2. kv public FQDN via Azure internal resolver (168.63.129.16) ===
Server:  168.63.129.16
Address: 168.63.129.16#53

Non-authoritative answer:
kv-mpi-sea-p-mycurex01.vault.azure.net canonical name =
    kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net.
** server can't find kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net: NXDOMAIN

=== 5. kv private FQDN directly via Azure internal resolver ===
** server can't find kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net: NXDOMAIN
```

**What changed vs. round 1:**
- Q1 (canonical query via CoreDNS): previously "No answer"; now `172.22.26.6`. This is the query ESO makes and the one that gates the whole pipeline. It works now.
- Q2 / Q5 (queries directly against Azure's internal resolver `168.63.129.16`): still NXDOMAIN on the privatelink FQDN.

**Interpretation.** Whatever MediCard did on their end resolves the name via CoreDNS's forwarders but not via Azure's built-in resolver directly. Consistent with a custom DNS server / conditional forwarder in the AKS VNet DNS configuration (rather than linking the `privatelink.vaultcore.azure.net` private DNS zone directly to the AKS VNet, which would make 168.63.129.16 authoritative for it). Either way, pod-side DNS works — that's what matters for the reconcile loop.

### 3.2 Auth layer — works

`az login` via the same workload-identity-federated UAMI returned exit 0. The Azure AD token exchange (public endpoint `login.microsoftonline.com`) was already known to work in round 1; it continues to work here.

### 3.3 Authorization layer — new blocker

`az keyvault secret list` and every `az keyvault secret show` on the prod vault return `Forbidden`:

```
ERROR: (Forbidden) Caller is not authorized to perform action on resource.
If role assignments, deny assignments or role definitions were changed recently,
please observe propagation time.

Caller:   appid=d6b958ed-790e-4a8a-9ce0-10aa6c0776b8
          oid=d8fc3c1e-35d7-4fc7-990d-3db74df08d75
          iss=https://sts.windows.net/31e62360-d307-45a7-932a-f774aa7a6288/

Action:   'Microsoft.KeyVault/vaults/secrets/readMetadata/action'
          (for list)
          'Microsoft.KeyVault/vaults/secrets/getSecret/action'
          (for individual reads)

Resource: /subscriptions/55e4144e-b310-4f7a-b583-542f534cbc98
          /resourcegroups/rg-mpi-sea-p-mycurex-resource01
          /providers/microsoft.keyvault/vaults/kv-mpi-sea-p-mycurex01

Assignment:       (not found)
DenyAssignmentId: null
InnerError:       ForbiddenByRbac
```

**Interpretation.** Azure identified the caller (the UAMI's application id, object id, and tenant issuer are all correct — this is the same UAMI staging uses and MediCard's earlier work bound the prod FIC to). The vault's decision engine then looked up whether this principal has a role assignment granting the requested actions on the requested resource, and found none.

`Assignment: (not found)` is Azure's explicit way of saying: no matching role assignment exists. Not "wrong scope", not "insufficient scope", not "conditional access denied" — just no assignment at all for this principal on this vault.

Under sheet row 5.b.v ("access policies naka set sya as role-based access(IAM)(RBAC)") we understood MediCard had granted role-based access on the prod vault. The observation from Azure's own error message is that no role assignment for this specific UAMI is present on `kv-mpi-sea-p-mycurex01`.

### 3.4 Downstream ExternalSecret status (as of snapshot)

All three ExternalSecrets in the cluster now show the same "Forbidden" upstream, not the previous "no such host":

```
NAMESPACE   NAME                 STATUS               MSG
medicard    hapihub-secrets      SecretSyncedError    could not get secret data from provider
medicard    minio-credentials    SecretSyncedError    could not get secret data from provider
velero      velero-credentials   SecretSyncedError    could not get secret data from provider
```

ESO's error log for each cites the same 403 `ForbiddenByRbac`. The k8s Secrets those ExternalSecrets target still do not exist, and therefore hapihub, s3proxy (fronting as `minio`), and velero pods remain stuck exactly where they were: `CreateContainerConfigError` on hapihub / minio, `Init:0/1` on velero.

### 3.5 Summary table (round 1 → round 2)

| Layer | Round 1 (2026-07-10 initial) | Round 2 (this report) |
|---|---|---|
| DNS: KV public FQDN via CoreDNS | ❌ "No answer" | ✅ `172.22.26.6` |
| DNS: KV FQDN via `168.63.129.16` direct | ❌ NXDOMAIN | ❌ NXDOMAIN (unchanged; not the path pods use) |
| TCP/TLS to vault | Not reached | Reached (implied by 403 response — TCP + TLS + Azure API layer all succeeded before the AuthZ check) |
| Auth: `az login` via workload identity | ✅ | ✅ |
| Read: `az keyvault secret list` | ❌ DNS resolution failure | ❌ `Forbidden` — `Assignment: (not found)` |
| Read: `az keyvault secret show <name>` | ❌ DNS resolution failure | ❌ `Forbidden` — same |
| ESO `ExternalSecret` status | `SecretSyncedError` (no such host) | `SecretSyncedError` (403 Forbidden — narrower) |
| Workload pods (hapihub/s3proxy/velero) | Stuck at `CreateContainerConfigError`/`Init` | Same state (still no k8s Secrets available) |

### 3.6 What we're reporting to MediCard

We are **not** proposing a fix. The observations are:

- DNS is now resolving from inside the cluster — thank you.
- The next step in the pipeline hits `403 Forbidden` with `Assignment: (not found)`. The caller Azure sees is the UAMI with client-id `d6b958ed-790e-4a8a-9ce0-10aa6c0776b8`, same identity that has the just-added FIC and that MediCard's earlier answer indicated should have RBAC on the vault.
- The exact resource path in the error (subscription / resource group / vault name) is the prod vault. The exact actions Azure lists as unauthorized are `secrets/readMetadata/action` (for list) and `secrets/getSecret/action` (for individual reads).

Whatever change MediCard makes to grant that specific UAMI those specific actions on that specific vault can be verified by re-running Probe 2 (same manifest as Appendix A2 of the round-1 report). If it lists secrets and reads back a sample, the authorization piece is resolved; ESO will start syncing the k8s Secrets on its next reconcile, and hapihub / s3proxy / velero will come up 1/1 without further intervention on our end.

## 4. Cluster-side artifacts left behind

**None.** Both probe pods (`dns-probe` in `default`, `kv-probe` in `external-secrets-system`) were deleted immediately after log capture. Verified:

```
$ kubectl -n default get pods
No resources found in default namespace.
$ kubectl -n external-secrets-system get pods | grep kv-probe
(no output)
```

No secrets, ConfigMaps, PVCs, or NetworkPolicies were created. No egress except DNS (10.0.0.10 / 168.63.129.16 / 1.1.1.1), HTTPS to `login.microsoftonline.com`, and one HTTPS attempt to the vault that Azure rejected before returning any secret data.

---

## Appendix — Environment fingerprint at time of test

- **Prod cluster:** `aks-mpi-sea-p-mycurex01`, VNet `mc-prd-vnet-sea-01`, CoreDNS `10.0.0.10`.
- **Prod vault target:** `kv-mpi-sea-p-mycurex01.vault.azure.net`; now resolves inside the cluster to `172.22.26.6`.
- **Caller identity Azure logged:** `appid=d6b958ed-790e-4a8a-9ce0-10aa6c0776b8`, `oid=d8fc3c1e-35d7-4fc7-990d-3db74df08d75`, tenant `31e62360-d307-45a7-932a-f774aa7a6288`.
- **DNS probe image:** `nicolaka/netshoot:latest`.
- **KV probe image:** `mcr.microsoft.com/azure-cli:latest`.
- **Test date / time:** 2026-07-10 (Asia/Manila).
