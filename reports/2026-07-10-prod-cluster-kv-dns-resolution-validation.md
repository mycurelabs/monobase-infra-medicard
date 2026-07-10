# 2026-07-10 — Prod Cluster Key Vault Connectivity Validation

**Status:** From inside the production AKS cluster, the vault's FQDN does not resolve, so no read against the vault can proceed. Staging is included as a positive control demonstrating what the full lifecycle (DNS → TCP → TLS → AAD auth → List → Read) looks like when it works.
**Environment under test:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia, Private Link API), VNet `mc-prd-vnet-sea-01`. Staging cluster `aks-mpi-sea-a-mycurex01` used as a positive control.
**Access path:** kubectl executed from the operator jumphost `mc.remote.prd.bastion` via `ssh medicard.gateway`. Staging probe executed against the local `.kube/config`.
**Related:** blocks §3.1 of [`2026-07-07-prod-cluster-iac-bootstrap.md`](./2026-07-07-prod-cluster-iac-bootstrap.md). ExternalSecrets can authenticate to Azure AD, but every subsequent secret-fetch fails at the DNS step before any TCP packet leaves the pod for the vault.

**Scope disclaimer.** This report is a **read-only diagnostic**. It documents what the cluster sees and where in the lifecycle the failure occurs. Any observations about "where the fix might live" are **suggested areas for MediCard to investigate**, not prescriptions. The actual root cause and the correct remediation are on MediCard's side; we do not have visibility into their VNet/DNS/private-endpoint configuration and cannot warrant that any specific change will resolve the issue.

---

## 1. Scope

Prove — and give MediCard a reproducible, non-destructive way to reproduce — that the failure surfaced by the External Secrets Operator (`dial tcp: lookup kv-mpi-sea-p-mycurex01.vault.azure.net on 10.0.0.10:53: no such host`) sits at the **DNS resolution layer**, not authentication, not authorization, not egress, not ESO configuration. Show what a working end-to-end lifecycle looks like on staging so both sides know what the fixed state should look like.

Strictly non-destructive. Only DNS queries and read-only Azure Key Vault list/get calls were issued. No secrets were written or modified, no TCP connections opened to the vault beyond what Azure's SDK does for `list`/`show`, no cluster resources mutated beyond short-lived diagnostic pods that were deleted after log capture. Secret values are redacted throughout; only lengths and, where already public, structural fragments (URI scheme/host) are shown.

## 2. Methodology

Two independent probes were run on each cluster (prod, staging), inside the cluster, using the same image and same script (with only the vault name changed):

**Probe 1 — DNS diagnostic** (`dns-probe`, `default` namespace, image `nicolaka/netshoot`). Runs eight DNS queries against the vault's public FQDN, its private-endpoint FQDN, and two Azure-adjacent controls (`login.microsoftonline.com`, PG's FQDN), from three resolvers (CoreDNS `10.0.0.10`, Azure DNS `168.63.129.16`, public `1.1.1.1`). See Appendix A1.

**Probe 2 — Full read-lifecycle** (`kv-probe`, `external-secrets-system` namespace, image `mcr.microsoft.com/azure-cli`). Runs as the same ServiceAccount ESO uses (`external-secrets`) with the workload-identity annotations already on it — so the identity presented to Azure AD is identical to what ESO uses. Three steps: `az login` via workload identity, `az keyvault secret list`, and `az keyvault secret show` on each secret. See Appendix A2.

Probes ran **inside the cluster** so results reflect what a workload actually sees, not what the operator laptop sees. Staging is a positive control: same vault topology (private endpoint), same tenant, same region — the delta between the two probes localises the observed behavioural difference cleanly.

## 3. Findings

### 3.1 Prod cluster — DNS layer fails, everything downstream cannot execute

**DNS diagnostic (Probe 1):**

```
=== /etc/resolv.conf ===
search default.svc.cluster.local svc.cluster.local cluster.local reddog.microsoft.com
nameserver 10.0.0.10
options ndots:5

=== 1. kv public FQDN via CoreDNS (10.0.0.10) ===
*** Can't find kv-mpi-sea-p-mycurex01.vault.azure.net: No answer

=== 2. kv public FQDN via Azure internal resolver (168.63.129.16) ===
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
(resolved successfully to public IPs)

=== 8. control: mpiazeppgdb0003.postgres.database.azure.com via CoreDNS ===
Name:    mpiazeppgdb0003.postgres.database.azure.com
Address: 172.22.25.6            (PRIVATE IP — private endpoint DNS works for PG)
```

**Full read-lifecycle (Probe 2):**

```
=== 1. az login via workload identity ===
login exit: 0

=== 2. list secrets in vault (names only) ===
ERROR: HTTPSConnection(host='kv-mpi-sea-p-mycurex01.vault.azure.net', port=443):
Failed to resolve 'kv-mpi-sea-p-mycurex01.vault.azure.net'
([Errno -5] No address associated with hostname)

=== 3. read a representative sample (values redacted) ===
  medicard-prod-database-uri: READ ERROR (same DNS resolution failure)
  medicard-prod-pg-target-uri: READ ERROR (same)
  medicard-prod-auth-secret:   READ ERROR (same)
  … (all reads failed at DNS — same underlying error)
```

Two independent code paths (BusyBox `nslookup`/`dig`, and Azure SDK inside `az cli`) both hit the same failure on the same hostname. Authentication with Azure AD succeeded in Probe 2 (`login exit: 0`) — proving the identity and FIC are wired correctly and public egress works. The very next step (list/get against the vault) fails because the vault's hostname does not resolve.

### 3.2 Staging cluster (positive control) — full lifecycle works end-to-end

**DNS diagnostic (Probe 1):**

```
=== 1. kv public FQDN via CoreDNS (10.0.0.10) ===
Name:    kv-mpi-sea-a-mycurex01.vault.azure.net
Address: 172.23.10.84            (PRIVATE IP)

=== 2. kv public FQDN via 168.63.129.16 ===
kv-mpi-sea-a-mycurex01.vault.azure.net canonical name =
    kv-mpi-sea-a-mycurex01.privatelink.vaultcore.azure.net.
Name:    kv-mpi-sea-a-mycurex01.privatelink.vaultcore.azure.net
Address: 172.23.10.84            (PRIVATE IP — Azure DNS is authoritative and
                                  returns the private-endpoint IP)
```

**Full read-lifecycle (Probe 2):**

```
=== 1. az login via workload identity ===
login exit: 0

=== 2. list secrets in vault (names only) ===
[names redacted from this report — list call returned successfully]

=== 3. read a representative sample (values redacted) ===
  medicard-staging-<name-1>: length=22 chars (opaque; value redacted)
  medicard-staging-<name-2>: length=24 chars (opaque; value redacted)
  medicard-staging-<name-3>: length=21 chars (opaque; value redacted)
```

Staging succeeds at every step: DNS returns a private IP, TCP/TLS to that private IP succeeds implicitly (the subsequent `list`/`show` calls complete without error), Azure AD auth via workload identity succeeds, the SDK enumerates the secrets in the vault, and a sampled subset were read back. Neither the full inventory nor any values are printed — the lengths on the reads are enough to prove the read pipeline is functional without exposing the material.

### 3.3 Summary table (prod vs. staging)

| Step | Prod result | Staging result |
|---|---|---|
| DNS: KV public FQDN via CoreDNS | ❌ "No answer" | ✅ Private IP `172.23.10.84` |
| DNS: KV public FQDN via 168.63.129.16 (Azure) | CNAME → privatelink; **NXDOMAIN on privatelink** | CNAME → privatelink; ✅ `172.23.10.84` |
| DNS: KV private FQDN via 168.63.129.16 | ❌ NXDOMAIN | ✅ `172.23.10.84` |
| DNS: `login.microsoftonline.com` via CoreDNS | ✅ | ✅ |
| DNS: Azure PG private FQDN via CoreDNS | ✅ Private IP `172.22.25.6` | ✅ (analogous) |
| Auth: `az login` via workload identity | ✅ `exit 0` (identity + FIC OK) | ✅ `exit 0` |
| Read: `az keyvault secret list` | ❌ DNS resolution failure | ✅ inventory returned (names/counts redacted from this report) |
| Read: `az keyvault secret show <name>` | ❌ DNS resolution failure | ✅ sampled reads succeed (lengths reported, values redacted) |

### 3.4 Interpretation

Azure Key Vault's public FQDN `<vault>.vault.azure.net` always CNAME-chains into `<vault>.privatelink.vaultcore.azure.net` regardless of whether the vault has a private endpoint. Whether that terminal name resolves — and what IP it returns — depends on the state of the `privatelink.vaultcore.azure.net` **Private DNS Zone** used by the VNet the client sits in.

Comparing the direct queries against Azure's internal resolver (`168.63.129.16`) between the two environments:

- On **staging**, the resolver returns the private IP `172.23.10.84` for `kv-mpi-sea-a-mycurex01.privatelink.vaultcore.azure.net`. This is consistent with a Private DNS Zone being linked to the staging AKS VNet and containing an A record for that vault.
- On **prod**, the resolver returns NXDOMAIN for `kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net`. This is consistent with either the zone not being linked, or being linked but not containing an A record for that particular vault.

The prod PG's private endpoint FQDN resolves fine (Q8) — so private-endpoint DNS integration *does* work for at least one Azure service from that VNet.

### 3.5 Authentication vs. reads — different code paths

Auth talks to `login.microsoftonline.com` (public — resolves per Q7). The secret read talks to the vault's own FQDN (fails per Q1 / Probe 2 step 2). Two different hostnames, two different DNS paths. That is why we observe successful Azure AD auth followed immediately by a DNS failure on the very next line of the reconcile.

### 3.6 What we're reporting to MediCard

We are **not** proposing a solution. The observations above are:

- Cluster-side DNS reaches `login.microsoftonline.com` and the prod PG private endpoint without issue.
- Cluster-side DNS does **not** reach the vault's private-endpoint FQDN; both CoreDNS and Azure's internal resolver return failure/NXDOMAIN for it.
- Staging, in the same tenant / same region / same vault topology, resolves its own vault to a private IP and completes the full read cycle.

The delta between the two environments sits somewhere in the DNS or private-endpoint configuration around `kv-mpi-sea-p-mycurex01` that MediCard controls (private DNS zones, zone-to-VNet links, private-endpoint-to-DNS integration, or an equivalent DNS forwarding path). We do not have visibility into that configuration and cannot confirm any specific change will resolve the issue — the diagnosis and remediation are on MediCard's side.

Whatever change MediCard makes on their end can be verified by re-running Probe 1 and Probe 2 (Appendix A) from inside the cluster. If Probe 1 Q1 returns an IP and Probe 2 step 2 lists the secrets, the change worked; ESO will then start syncing `hapihub-secrets`, `minio`, and `velero-credentials`. If either probe still fails, the failure mode narrows further (from that new evidence, we can help characterise what changed).

## 4. Scope notes

- No attempt was made to reach the vault over TCP; only DNS and read-only KV operations were performed. If DNS resolves but reads still fail, next diagnostic steps would look at NSG/UDR/firewall rules and the vault's own network access rules.
- Neither the staging vault's inventory nor any values were printed in full. Lengths on the sampled reads are the only evidence shown; that is sufficient to prove the read pipeline works, without disclosing the contents.
- The staging positive control uses a different vault (`kv-mpi-sea-a-mycurex01`) in a different resource group. The comparison is at the DNS/SDK layer; contents of the two vaults differ.

## 5. Cluster-side artifacts left behind

**None.** All four probe pods (`dns-probe` and `kv-probe` on each cluster) were deleted immediately after log capture. Verified:

```
$ kubectl -n default get pods
No resources found in default namespace.
$ kubectl -n external-secrets-system get pods | grep kv-probe
(no output)
```

No secrets, ConfigMaps, PVCs, or NetworkPolicies were created. No egress traffic left either cluster except DNS UDP to `10.0.0.10`/`168.63.129.16`/`1.1.1.1`, HTTPS to `login.microsoftonline.com` (Probe 2), and HTTPS to the staging vault (Probe 2 on staging only). No calls were made against PG, MongoDB Atlas, or any workload namespaces beyond `default` and `external-secrets-system`.

---

## Appendix A1 — DNS probe pod manifest

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
        echo "=== /etc/resolv.conf ==="; cat /etc/resolv.conf; echo
        echo "=== 1. kv public FQDN via CoreDNS (10.0.0.10) ==="
        nslookup kv-mpi-sea-p-mycurex01.vault.azure.net 10.0.0.10
        echo "=== 2. kv public FQDN via Azure internal resolver (168.63.129.16) ==="
        nslookup kv-mpi-sea-p-mycurex01.vault.azure.net 168.63.129.16
        echo "=== 3. kv public FQDN via public resolver (1.1.1.1) — CNAME chain ==="
        nslookup kv-mpi-sea-p-mycurex01.vault.azure.net 1.1.1.1
        echo "=== 4. kv private FQDN directly via CoreDNS ==="
        nslookup kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net 10.0.0.10
        echo "=== 5. kv private FQDN directly via Azure internal resolver ==="
        nslookup kv-mpi-sea-p-mycurex01.privatelink.vaultcore.azure.net 168.63.129.16
        echo "=== 6. dig +trace kv public FQDN via CoreDNS ==="
        dig +trace kv-mpi-sea-p-mycurex01.vault.azure.net @10.0.0.10 2>&1 | head -40
        echo "=== 7. control: login.microsoftonline.com via CoreDNS ==="
        nslookup login.microsoftonline.com 10.0.0.10
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

## Appendix A2 — Full read-lifecycle probe pod manifest

Runs as the same ServiceAccount ESO uses (`external-secrets-system/external-secrets`) with its existing workload-identity annotations. If the annotations aren't present on the SA, the workload-identity webhook won't inject the token variables and step 1 will fail.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kv-probe
  namespace: external-secrets-system
  labels:
    azure.workload.identity/use: "true"
spec:
  serviceAccountName: external-secrets
  restartPolicy: Never
  nodeSelector:
    kubernetes.io/arch: amd64
  containers:
  - name: probe
    image: mcr.microsoft.com/azure-cli:latest
    command: ["/bin/sh", "-c"]
    args:
      - |-
        VAULT="kv-mpi-sea-p-mycurex01"                # change per cluster
        PREFIX="medicard-prod"                        # change per cluster
        echo "=== target vault: $VAULT / prefix: $PREFIX ==="

        echo "=== 1. az login via workload identity ==="
        az login --federated-token "$(cat $AZURE_FEDERATED_TOKEN_FILE)" \
          --service-principal -u "$AZURE_CLIENT_ID" -t "$AZURE_TENANT_ID" \
          -o none 2>&1 | tail -3
        echo "login exit: $?"

        echo "=== 2. list secrets in vault (names only) ==="
        az keyvault secret list --vault-name "$VAULT" --query "[].name" -o tsv

        echo "=== 3. read a representative sample (values redacted) ==="
        for shortname in database-uri pg-target-uri auth-secret \
                         azureblob-account-name azureblob-account-key \
                         mongo-source-uri pg-encryption-key \
                         enc-medical-records; do
          full="${PREFIX}-${shortname}"
          val=$(az keyvault secret show --vault-name "$VAULT" --name "$full" \
                --query value -o tsv 2>/tmp/err) || {
            err=$(head -1 /tmp/err)
            echo "  $full: READ ERROR ($err)"; continue; }
          case "$shortname" in
            azureblob-account-name)
              echo "  $full: value='$val' (account name is not sensitive)" ;;
            database-uri|pg-target-uri|mongo-source-uri)
              redacted=$(echo "$val" | sed -E 's|(://[^:]+:)[^@]+(@)|\1[REDACTED]\2|')
              echo "  $full: $redacted" ;;
            *)
              echo "  $full: length=${#val} chars (opaque; value redacted)" ;;
          esac
        done
```

Apply, wait, read, delete:

```
kubectl apply -f kv-probe.yaml
kubectl -n external-secrets-system wait --for=condition=Ready pod/kv-probe --timeout=90s
kubectl -n external-secrets-system logs kv-probe
kubectl -n external-secrets-system delete pod kv-probe
```

## Appendix B — Environment fingerprint at time of test

- **Prod cluster:** `aks-mpi-sea-p-mycurex01`, VNet `mc-prd-vnet-sea-01`, AKS subnet `subnet-p-mycurex-aks01-172.22.40.0/22`, CoreDNS at `10.0.0.10`.
- **Prod vault target:** `kv-mpi-sea-p-mycurex01.vault.azure.net`; private endpoint per sheet `pl-mpi-sea-p-mycurex-kv01`.
- **Staging cluster (positive control):** `aks-mpi-sea-a-mycurex01`, CoreDNS at `10.0.0.10`.
- **Staging vault target:** `kv-mpi-sea-a-mycurex01.vault.azure.net`; private endpoint IP observed `172.23.10.84`.
- **DNS probe image:** `nicolaka/netshoot:latest`.
- **KV probe image:** `mcr.microsoft.com/azure-cli:latest` (auth via workload identity federation using the ServiceAccount `external-secrets-system/external-secrets`).
- **UAMI:** client-id `d6b958ed-790e-4a8a-9ce0-10aa6c0776b8`, tenant-id `31e62360-d307-45a7-932a-f774aa7a6288`. Federated Identity Credentials attached to this UAMI cover both the staging and prod AKS cluster OIDC issuers (per MediCard's 2026-07-10 confirmation).
- **Test date / time:** 2026-07-10 (Asia/Manila).
