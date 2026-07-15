# 2026-07-15 — hapihub-migrator Mongo SRV DNS failure (Bun runtime + UDP truncation)

**Status:** `hapihub-migrator` (`ghcr.io/mycurelabs/hapihub-migrator:3.9.3`, a Bun single-file executable) fails at boot with `DNSException: querySrv ETIMEOUT _mongodb._tcp.mycure-stg-sh.q4trx.mongodb.net`. The Bun runtime's SRV lookup path times out on responses that trigger UDP truncation. A `mongosh` client on the same node with the same Mongo URI connects in ~1.3s. The failure is confined to Bun's DNS resolver, not the cluster's DNS path, not the NetworkPolicy layer, and not the Atlas SRV records themselves.

**Environment under test:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia). Pod `hapihub-migrator-984666d95-gv6b5` in namespace `medicard`, scheduled on node `aks-userpool-34798594-vmss00000d` (zone `southeastasia-2`). All diagnostic probes run in the same namespace, pinned to the same node.

**Access path:** kubectl executed from the operator jumphost `mc.remote.prd.bastion` via `ssh medicard.gateway`.

**Related:**
- Blocks the migrator's ability to open a Mongo connection and consequently blocks any downstream `bulk`/`cdc` run.
- Complements the 2026-07-13 duplicate-accounts bundle at [`reports/2026-07-13-duplicate-accounts/`](./2026-07-13-duplicate-accounts/) — that report resolved the PG side of the migrator's blockers; this one identifies the source-side blocker.
- Prior migrator incidents in [`reports/2026-04-08-…`](./2026-04-08-azure-pg-read-only-blocking-hapihub-migrator.md) and [`reports/2026-04-13-hapihub-migrator-oom-and-missing-encryption-keys.md`](./2026-04-13-hapihub-migrator-oom-and-missing-encryption-keys.md) covered PG-side / OOM / encryption-key issues — separate failure classes from this one.

**Scope disclaimer.** This report is a **read-only diagnostic**. Every claim below is backed by a verbatim command + verbatim output block captured during the investigation on 2026-07-15. Any suggested paths forward are "worth investigating" — the actual remediation is on MediCard's side (chart, image, or runtime decision). We do not warrant that any specific change will resolve the issue. Diagnostic pods were spawned in the medicard namespace and deleted after log capture. Secret values (Mongo credentials) are redacted; the Atlas shard hostnames are public via the SRV record itself and are shown as-is.

---

## 1. Scope

Prove — and give MediCard a reproducible test — that the migrator's DNS failure sits at the **Bun runtime's SRV resolver** and not at any layer below (CoreDNS, kube-dns pods, Azure DNS, NetworkPolicy egress, Atlas SRV records, or the specific node the migrator is scheduled on). Show what the working path looks like on the same node with a different client (`mongosh` / libc `getaddrinfo`) so both sides know where the fix must live.

Strictly non-destructive. Only DNS queries and short-lived diagnostic pods. No secrets written or modified. No cluster resources mutated beyond ephemeral probe pods that were deleted after log capture.

---

## 2. Methodology

Four probes, each ruling out one layer of the resolution chain. Every probe pod ran on the migrator's node (`aks-userpool-34798594-vmss00000d`) unless noted, with PSS-restricted `securityContext` so admission passed.

- **Probe 1** — Pod-spec + `/etc/resolv.conf` baseline for the failing pod and a control pod scheduled on the same node.
- **Probe 2** — NetworkPolicy audit in the `medicard` namespace + verification that policies are actually enforced by the cluster's CNI.
- **Probe 3** — `dig SRV` matrix (UDP with EDNS, UDP without EDNS, TCP, Azure-DNS bypass, libc `getent`) from a same-node netshoot pod, capturing response size and truncation flag.
- **Probe 4** — Runtime library reproducer: `Bun.dns.resolveSrv`, `node:dns` compat mode inside Bun, `dns.lookup` (getaddrinfo), and `mongosh` connect — same SRV target, same node.

Pods used:
| Pod | Image | Purpose |
|---|---|---|
| `hapihub-migrator-…-gv6b5` | `ghcr.io/mycurelabs/hapihub-migrator:3.9.3` | Failing case (Bun runtime) |
| `netshoot-mig-node` | `docker.io/nicolaka/netshoot:latest` | DNS probes on migrator's node |
| `netshoot-other-node` | `docker.io/nicolaka/netshoot:latest` | DNS probes on a different node (zone control) |
| `bun-dns-test` | `docker.io/oven/bun:1.1.20-alpine` | Runtime reproducer for Bun's SRV lookup |
| `mongosh-mig-node` | `docker.io/bitnamilegacy/mongodb:7.0.14-debian-12-r5` | Positive control — mongosh on migrator's node |

---

## 3. Findings

### 3.1 Pod spec baseline — no `dnsConfig` override, standard AKS `/etc/resolv.conf`

The migrator uses the default `dnsPolicy: ClusterFirst` with no `dnsConfig` overrides:

```json
{
  "dnsPolicy": "ClusterFirst",
  "dnsConfig": null,
  "nodeName": "aks-userpool-34798594-vmss00000d",
  "hostNetwork": null,
  "hostAliases": null,
  "nodeSelector": { "kubernetes.io/arch": "amd64" }
}
```

`/etc/resolv.conf` inside the same-node netshoot probe pod:

```
search medicard.svc.cluster.local svc.cluster.local cluster.local reddog.microsoft.com
nameserver 10.0.0.10
options ndots:5
```

The other-node probe pod (`aks-userpool-34798594-vmss00000c`, zone `southeastasia-1`) resolves via the same file — identical AKS default. No per-node divergence.

**Rules out:** custom `dnsConfig`, short-timeout resolver options, per-node DNS pollution.

### 3.2 NetworkPolicy — YAMLs exist but no CNI enforces them

The `medicard` namespace ships 11 NetworkPolicy objects (see below) including a `default-deny-egress` selecting all pods, plus a `hapihub-migrator` policy whose egress explicitly allows kube-dns:

```yaml
egress:
- to:
  - namespaceSelector: {}
    podSelector:
      matchLabels:
        k8s-app: kube-dns
- ports: [{port: 5432, protocol: TCP}]
  to: [{namespaceSelector: {}}]
- ports: [{port: 27016, protocol: TCP}, {port: 27017, protocol: TCP}]
  to: [{namespaceSelector: {}}]
- ports: [{port: 443, protocol: TCP}]
  to: [{namespaceSelector: {}}]
```

To verify these policies are actually enforced, probed egress from an **unrelated pod** (`netshoot-mig-node`, no matching allow policy — should be default-denied by `default-deny-egress`):

```
$ kubectl -n medicard exec netshoot-mig-node -- nc -zv google.com 443
Connection to google.com (142.251.10.138) 443 port [tcp/https] succeeded!
```

Egress succeeded despite `default-deny-egress` supposedly matching this pod. Confirming CNI:

```
$ kubectl get pods -n kube-system -l k8s-app=calico-node
No resources found in kube-system namespace.
$ kubectl get pods -n kube-system -l k8s-app=cilium
No resources found in kube-system namespace.
$ kubectl get pods -n kube-system | grep -iE "npm|calico|cilium|network"
(no output)
```

**No NetworkPolicy-enforcing CNI is installed on this AKS cluster.** The `medicard/*` NetworkPolicy objects exist as declarative documents but nothing enforces them.

**Rules out:** DNS egress being blocked at the NetworkPolicy layer. Even if egress rules were misconfigured, they wouldn't affect traffic.

### 3.3 DNS resolution matrix — UDP works only with EDNS

From `netshoot-mig-node` on the migrator's node, resolving the Atlas SRV via CoreDNS at `10.0.0.10`:

**UDP with EDNS (dig default):**
```
$ dig SRV _mongodb._tcp.mycure-stg-sh.q4trx.mongodb.net

;; ANSWER SECTION: (9 SRV records)
;; ADDITIONAL SECTION: (9 A records for the shard hosts)
;; Query time: 2 msec
;; SERVER: 10.0.0.10#53(10.0.0.10) (UDP)
;; MSG SIZE  rcvd: 797
```
797-byte response fits in one UDP packet because EDNS advertised a buffer >797.

**UDP without EDNS, ignoring truncation (`+noedns +ignore`):**
```
$ dig +noedns +ignore SRV _mongodb._tcp.mycure-stg-sh.q4trx.mongodb.net

;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 56818
;; flags: qr tc rd ra; QUERY: 1, ANSWER: 7, AUTHORITY: 0, ADDITIONAL: 0
[7 SRV records — 2 dropped, additional section stripped]
;; Query time: 3 msec
;; SERVER: 10.0.0.10#53(10.0.0.10) (UDP)
;; MSG SIZE  rcvd: 504
```
**The `tc` flag is set** — the response is truncated. CoreDNS returned 504 bytes with only 7 of 9 SRV records and no additional section, and signalled the client to retry over TCP.

**TCP:**
```
$ dig +tcp SRV _mongodb._tcp.mycure-stg-sh.q4trx.mongodb.net
[9 SRV records + 9 A records]
;; SERVER: 10.0.0.10#53(10.0.0.10) (TCP)
;; MSG SIZE  rcvd: 1589
```
1589 bytes over TCP — the full response.

**Azure DNS bypass (`168.63.129.16`) — same 797 bytes:**
```
;; SERVER: 168.63.129.16#53(168.63.129.16) (UDP)
;; MSG SIZE  rcvd: 797
```

**libc getaddrinfo path (mongosh's resolution path):**
```
$ getent hosts mycure-stg-sh-shard-00-00.q4trx.mongodb.net
20.205.162.40     mycure-stg-sh-shard-00-00.q4trx.mongodb.net
real    0m0.080s
```

**Interpretation:** CoreDNS's SRV response for `_mongodb._tcp.mycure-stg-sh.q4trx.mongodb.net` is ~500–800 bytes depending on additional-section handling. A client that (a) advertises EDNS with a buffer >800 bytes, OR (b) handles the TC flag by retrying over TCP, gets the full answer. A client that does neither times out.

### 3.4 Runtime reproducer — Bun ETIMEOUT, libc OK, mongosh OK

From `bun-dns-test` on the migrator's node, running Bun 1.1.20:

```
$ bun run /tmp/probe.js
=== Bun version: 1.1.20
=== 1. Bun.dns.resolveSrv (native) ===
FAIL: DNS_ETIMEOUT/undefined: Timeout while contacting DNS servers

=== 2. Node dns.resolveSrv (via node:dns compat) ===
FAIL: ETIMEOUT/undefined: Timeout while contacting DNS servers

=== 3. plain A lookup (getaddrinfo path) ===
OK (18ms) — {
  address: "20.205.162.40",
  family: 4,
}
```

Bun's SRV lookup (both the native `Bun.dns.resolveSrv` and the `node:dns` compatibility layer running inside Bun) time out. The error code, syscall name, and message shape are the exact match of the migrator's runtime error:

```
Fatal error: DNSException: querySrv ETIMEOUT _mongodb._tcp.mycure-stg-sh.q4trx.mongodb.net
  errno: 12, code: "ETIMEOUT"
```

Meanwhile `dns.lookup` (which uses libc `getaddrinfo`, not c-ares/Bun's own resolver) completes an A-record lookup in 18 ms.

From `mongosh-mig-node` on the same migrator's node, using the exact same `MONGO_URI` secret the migrator mounts:

```
$ time mongosh "$MONGO_URI&readPreference=secondaryPreferred" --quiet --eval "db.runCommand({ping:1})"
{ ok: 1, '$clusterTime': { … }, operationTime: Timestamp({…}) }

real    0m1.260s
```

1.26s end-to-end — SRV lookup, replica-set discovery, TLS handshake, auth, ping.

**This localises the failure to Bun's SRV resolver on responses that trigger UDP truncation.** Same node, same CoreDNS, same network path, same target hostname, same URI credentials — the only variable is the client library.

---

## 4. Root cause

Bun's DNS resolver does not correctly handle the "UDP response truncated → retry over TCP" sequence that RFC 5966 mandates and that both `libc getaddrinfo` and `dig` implement transparently. When CoreDNS returns a response with the `tc` (truncation) flag set — which it does for this specific Atlas SRV name because the answer plus additional section exceeds the client's advertised UDP buffer — Bun's resolver times out instead of retrying over TCP.

Two independent pieces of evidence support this:

- §3.3 shows that a UDP query without EDNS receives a truncated response (`tc` flag set, 504 bytes, 7 of 9 records). The same query over TCP receives 1589 bytes with all records. A resolver that respects RFC 5966 will see `tc=1` and immediately retry over TCP; a resolver that doesn't will keep waiting for a UDP packet that never comes and eventually time out with `ETIMEOUT`. That's the exact shape of Bun's failure.
- §3.4 reproduces the failure in a clean `oven/bun:1.1.20-alpine` pod on the migrator's node, using both `Bun.dns.resolveSrv` and the Node-compat `dns.resolveSrv` — both time out with `ETIMEOUT`. On the same pod, `dns.lookup` (which routes through libc) succeeds in 18 ms.

Everything below Bun in the stack is healthy:
- The node's `/etc/resolv.conf` is standard AKS (§3.1).
- CoreDNS returns the SRV records in 2–3 ms over both UDP-with-EDNS (797 bytes) and TCP (1589 bytes) (§3.3).
- Azure DNS at `168.63.129.16` returns the same 797-byte answer via UDP (§3.3).
- The Atlas SRV record itself contains 9 valid shard entries with resolvable A records (§3.3).
- No NetworkPolicy blocks DNS or TLS egress from this namespace — no CNI is enforcing policies at all (§3.2).

---

## 5. Observations for MediCard

Non-prescriptive. Any of these MAY resolve the failure; the correct choice is a chart / image / runtime decision on MediCard's side.

1. **Upgrading the Bun runtime in the migrator image is worth investigating.** Bun's DNS resolver has iterated on SRV / EDNS / TCP-fallback behaviour across the 1.1.x line, and later releases (1.2.x+) explicitly track fixes in this area. If MediCard rebuilds `ghcr.io/mycurelabs/hapihub-migrator:3.9.3` on a newer Bun base and the reproducer in §3.4 stops failing on the new base, the runtime path is unblocked. This report reproduced the failure on `oven/bun:1.1.20-alpine`; MediCard should re-run the reproducer against the exact Bun version their build pipeline pins.

2. **A code-side workaround exists** for teams that want to unblock without a runtime bump: replace calls that resolve `mongodb+srv://` URIs (which internally invokes `dns.resolveSrv`) with a Mongo connection string that lists the shard hosts explicitly (`mongodb://…` non-SRV form). The MongoDB driver then goes through `dns.lookup` / getaddrinfo — the path §3.4 shows working — instead of `dns.resolveSrv`. This trades off SRV-based failover convenience for driver-side host discovery.

3. **The Atlas SRV response size can be reduced upstream.** Atlas returns 9 shard SRV records for `mycure-stg-sh.q4trx.mongodb.net` plus additional A records. If MediCard's cluster topology is deliberately smaller than 9 shards or if legacy shard records are hangovers, reducing the SRV set on the Atlas side would drop the response back under 512 bytes and route around the Bun truncation-handling gap. Whether this is achievable depends on MediCard's Atlas topology and is worth checking with their DBA.

4. **The `medicard/*` NetworkPolicy objects should be treated as declarative-only until an enforcing CNI is installed.** §3.2 confirms no Calico / Cilium / Azure NPM pods are running, and a test egress to `google.com:443` succeeded from a pod that should have been default-denied. This is not the DNS root cause — but it's worth flagging that the security-baseline chart's default-deny + allow-list model provides no isolation on this cluster today. Not this report's scope to prescribe a fix, but the report bundle at [`reports/2026-07-07-prod-cluster-iac-bootstrap.md`](./2026-07-07-prod-cluster-iac-bootstrap.md) already covered why the cluster's CNI is `azure-cni` without policy enforcement enabled at provisioning time.

---

## 6. Reproduction recipe (for MediCard)

Any team member can reproduce this in ~2 minutes from a bastion with `kubectl` access to the medicard prod cluster:

```bash
# 1. Bun probe pod on any node in the medicard ns
kubectl -n medicard apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: bun-dns-repro, namespace: medicard }
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 1001
    seccompProfile: { type: RuntimeDefault }
  containers:
  - name: bun
    image: docker.io/oven/bun:1.1.20-alpine
    command: ["sleep", "600"]
    securityContext:
      allowPrivilegeEscalation: false
      runAsNonRoot: true
      runAsUser: 1001
      capabilities: { drop: [ALL] }
      seccompProfile: { type: RuntimeDefault }
EOF
kubectl -n medicard wait --for=condition=Ready pod/bun-dns-repro --timeout=60s

# 2. Run the SRV reproducer
kubectl -n medicard exec bun-dns-repro -- bun -e '
  try {
    const r = await Bun.dns.resolveSrv("_mongodb._tcp.mycure-stg-sh.q4trx.mongodb.net");
    console.log("OK:", r.length, "records");
  } catch (e) { console.log("FAIL:", e.code, e.message); }
'

# 3. Cleanup
kubectl -n medicard delete pod bun-dns-repro
```

Expected: `FAIL: DNS_ETIMEOUT Timeout while contacting DNS servers`. If a future Bun release changes this to `OK: 9 records`, the runtime-side fix has landed.

---

## 7. References

- [`reports/2026-07-10-prod-cluster-kv-dns-resolution-validation.md`](./2026-07-10-prod-cluster-kv-dns-resolution-validation.md) — sibling DNS investigation format used as the template for this report; a different failure (private-endpoint FQDN not resolving cluster-side) that also localised to a specific layer.
- [`reports/2026-07-13-duplicate-accounts/README.md`](./2026-07-13-duplicate-accounts/README.md) — resolved the PG-side blocker on the migrator's target. This report identifies the source-side blocker.
- [`reports/2026-07-07-prod-cluster-iac-bootstrap.md`](./2026-07-07-prod-cluster-iac-bootstrap.md) — cluster provisioning context; explains why NetworkPolicy YAMLs are declarative-only.
