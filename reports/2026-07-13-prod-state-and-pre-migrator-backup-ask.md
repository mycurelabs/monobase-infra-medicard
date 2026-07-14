# 2026-07-13 — Prod Cluster State + Pre-Migrator Backup Ask

**Status:** Prod cluster is HA-hardened, cache-tier live, observability + security operators fully deployed. All tenant apps (`hapihub`, `mycure`, `s3proxy`) are healthy at 2/2. The `hapihub-migrator` remains paused by design (`replicaCount: 0`) — it is a manually-triggered, one-shot bulk operation. **Before we schedule the migrator's first run, please confirm that Azure PG and Atlas Mongo backup coverage is in place** — details in §5.

**Environment under test:** Production AKS cluster `aks-mpi-sea-p-mycurex01`.
**Access path:** kubectl executed from `mc.remote.prd.bastion` via `ssh medicard.gateway`.
**Prior state:** see [`2026-07-10-prod-cluster-kv-connectivity-revalidation-round-3.md`](./2026-07-10-prod-cluster-kv-connectivity-revalidation-round-3.md). That report closed with the KV/DNS/RBAC/PG-grant chain fully green from our side.

**Scope disclaimer.** Observation only. No prescriptions to MediCard. Sample values shown below are redacted where sensitive.

---

## 1. Current state (as of report timestamp)

| Subsystem | Pods (ready / desired) | HA posture | Notable state | Changed since 2026-07-10 |
|---|---|---|---|---|
| **hapihub (API)** | 2/2 | 2 replicas + PDB + hostname anti-affinity | Healthy | ↑ HA shipped |
| **mycure (CMS)** | 2/2 | 2 replicas + PDB + anti-affinity | Healthy | ↑ HA shipped |
| **s3proxy (S3→Blob)** | 2/2 | 2 replicas + PDB + anti-affinity | Healthy | ↑ HA shipped |
| **hapihub-migrator** | 0/0 | Paused by design (`replicaCount: 0`) — un-paused manually per operation | Awaiting scheduled first run + backup confirmation (§5) | No change |
| **cadence (WebSocket sync)** | 0/0 | disabled | Chart re-backported from mycure prod (Rust rewrite, `cadence:0.7.10`, PG+Valkey). Re-enable attempted, stalled on Azure PG TLS handshake; flipped back to disabled pending resolution on our side. | ↑ chart backport shipped; live enable deferred |
| **valkey (in-cluster cache)** | 1/1 | Standalone (soft dep) | `valkey-primary-0` Running; password ESO-minted in-cluster; hapihub env wires `REDIS_URL` + `CACHE_ENABLED`. | NEW |
| **Envoy Gateway (controller + data-plane)** | 2/2 + 2/2 | Preferred hostname anti-affinity | Healthy | ↑ HA shipped |
| **ArgoCD server / repo-server / applicationset** | 2/2 each | Leader-elect on applicationset | Healthy. Application-controller + redis stay single-replica by design. | ↑ server-tier HA shipped |
| **External Secrets Operator (controller + webhook + cert-controller)** | 2/2 each | Leader-elect on controller / cert-controller | Healthy | ↑ HA shipped |
| **Kyverno (4 controllers)** | 2/2 each | Leader-elect on background/reports/cleanup | Healthy. `pod-security` and `require-labels` currently in `audit` mode. | ↑ operator install + policies + HA shipped |
| **Falco** | 3/3 (DaemonSet) | 1-per-node | Healthy. Chart bumped 4.6.1 → 9.1.0 for AKS 6.8-kernel `scap_init` compat. | ↑ install + chart bump shipped |
| **Prometheus** | 1/1 (StatefulSet) | Single-replica (HA out-of-scope, needs Thanos/Mimir) | Healthy. Chart pinned to 11.3.10. | ↑ chart pinned |
| **Grafana** | 2/2 + PG 1/1 | 2 replicas + in-cluster Postgres backend (single-replica soft-dep) | Healthy. Datasources: Prometheus + Loki. Password ESO-minted in-cluster. | ↑ HA shipped |
| **Alertmanager** | 3/3 (StatefulSet) | Gossip cluster peering; soft anti-affinity | Healthy. Slack routing gated behind `medicard-prod-alertmanager-slack-webhook` KV entry — currently unpopulated, so alerts render internally but do not page. | ↑ 3-replica cluster shipped |
| **Loki + Promtail** | 1/1 + 3/3 (DS) | Single-binary + DaemonSet | Healthy. HA mode migration (simple-scalable) is a separate project. | No change |
| **Velero** | 1/1 | Single-replica control plane (state in Azure Blob) | Healthy. Daily infra + weekly cluster-resources schedules active. | ↑ weekly schedule pinned |

## 2. What shipped since 2026-07-10 (grouped)

- **Prod hardening pass** — hapihub session-prune CronJob (Better Auth never expires its own rows), Alertmanager routing structure + ExternalSecret wired to a placeholder KV entry (`medicard-prod-alertmanager-slack-webhook`, currently unpopulated by design — alerts render but don't page until MediCard populates it), same shape for ArgoCD deploy notifications (`medicard-prod-argocd-slack-token`), Kyverno operator + three ClusterPolicies (`pod-security`, `require-labels`, `restrict-registries`), Falco with two custom rulesets (api / database), `allow-*` NetworkPolicies for hapihub↔s3proxy and gateway→apps, weekly Velero cluster-resource schedule, Grafana + Loki datasource wired for from-a-single-pane log/metric queries.
- **Crashloop remediation** — three tiers of self-inflicted breakage from the hardening pass got fixed: Kyverno's cleanup CronJobs pulled `bitnami/kubectl` which Bitnami delisted in mid-2025 (redirected to `bitnamilegacy/kubectl`); the three Kyverno ClusterPolicies had no operator-namespace exclusions (added a shared exclude list covering kube-system/argocd/kyverno/falco/ESO/envoy-gateway-system/cert-manager/monitoring/loki/velero); Falco 0.38.1 (chart 4.6.1) failed `scap_init` on AKS's 6.8.0-azure kernel, bumped to chart 9.1.0 shipping Falco 0.44.1; and Kyverno's `pod-security` + `require-labels` in enforce mode admission-blocked the 1→2 tenant rollout because MediCard's chart templates don't yet set `securityContext.runAsNonRoot=true` or the `app/environment/client` label taxonomy — flipped both to `audit` (violations still visible in PolicyReports; enforcement pending chart-side compliance work).
- **HA rollout** — every stateless / leader-elect-capable tier moved to 2 replicas (hapihub, mycure, s3proxy, Envoy Gateway controller + data-plane, ArgoCD server + repo-server + applicationset, ExternalSecrets controller + webhook + cert-controller, Kyverno all four controllers) or 3 replicas (Alertmanager, for gossip quorum). Grafana went 1→2 with an in-cluster Postgres backend replacing the per-pod SQLite (needed for shared state across replicas). Two zones today (`southeastasia-1` + `southeastasia-2`, 3 nodes total) is enough for 2-replica spread. Prometheus and Loki stay single-replica — real HA needs mode changes / Thanos-class projects.
- **Valkey response cache** — Bitnami valkey subchart (chart 2.2.1, image `bitnamilegacy/valkey:8.0.1-debian-12-r2`, standalone architecture). Same instance intended to back cadence too. Password minted once in-cluster by an ESO Password generator — no client KV entry needed. Hapihub's chart wires the env plumbing (`REDIS_URL` with `$(VALKEY_PASSWORD)` expansion, `CACHE_ENABLED=true`) so the cache is active on every hapihub pod.
- **Cadence chart backport** — MediCard's `charts/cadence/` was the legacy Mongo-based `syncd` chart, incompatible with MediCard's external-Atlas topology. Replaced wholesale with the current mycure-prod cadence chart (Rust rewrite, image `ghcr.io/mycurelabs/cadence:0.7.10`, uses PG + Valkey backends). Added a new `postgresql.external: true` mode so the chart can mount `CADENCE_PRIMARY_DB_URL` from a Secret directly (preserves `?sslmode=require` and other connection-string flags). Enable attempt stalled on TLS handshake failure between cadence's Rust PG driver and Azure PG (`error performing TLS handshake` — same `DATABASE_URI` that works for hapihub); flipped back to `enabled: false` while we investigate on our side. Chart + values scaffolding all in place; re-enable is a one-flag change once the TLS path is proven.
- **Chart-version alignment** — full audit vs `mycure/infra` showed almost no drift. Kyverno, Velero, Envoy Gateway, ExternalSecrets all match. Falco is intentionally *ahead* (9.1.0 vs mycure 4.6.1, driven by the AKS-kernel fix above). Pinned the Bitnami kube-prometheus chart at 11.3.10 (previously the ArgoCD Application resolved `.Values.monitoring.version` with no default, silently pulling `latest` at render time).

## 3. What backup coverage we ship vs what we don't

- **Ships (our side):**
  - **Velero** — daily backup of infrastructure namespaces (kube-system, argocd, envoy-gateway-system, external-secrets-system, monitoring, cert-manager, kyverno, falco, velero) with 30-day retention. Weekly backup of cluster-scoped resources (CRDs, ClusterRoles, StorageClasses, webhooks) with 90-day retention. Backup objects land in the `blobmpseapmycurex01` Azure Blob container.
  - Scope: Kubernetes API objects (Deployments, Secrets, ConfigMaps, PVCs and their contents). Restores redeploy the cluster state, not the source data behind external services.
- **Does NOT ship (out of our scope):**
  - **Azure Postgres `mpiazeppgdb0003`** — this is the managed Azure DB for PostgreSQL Flexible Server behind hapihub + migrator + cadence. Its backup posture (Point-In-Time Restore retention, geo-redundant backup) is set on MediCard's Azure subscription. Velero does not read from or back up managed DBs.
  - **MongoDB Atlas source** (per the KV `medicard-prod-mongo-source-uri`) — Atlas's own continuous-backup / snapshot policy applies. Set on MediCard's Atlas project.

## 4. The ask

The `hapihub-migrator` is a manually-un-paused, bulk-write operation targeting the Azure PG (source Mongo Atlas → target PG). Before the first scheduled run, MediCard's confirmation on the following would materially reduce downside risk. This is observation only — the operational settings are on MediCard's side of the boundary.

1. **Azure PG PITR / retention confirmation.** For `mpiazeppgdb0003.postgres.database.azure.com`:
   - Is PITR enabled?
   - What retention window is configured?
   - Does that window cover the intended operation timeline plus a soak period afterward (i.e. is there enough headroom to roll back if a downstream effect is discovered days later)?
2. **Atlas Mongo backup coverage.** For the source database referenced by `medicard-prod-mongo-source-uri`:
   - Is continuous backup or an on-demand snapshot policy in place?
   - Does the retention cover the migrator run + soak?
   - Note: the migrator reads-only from Mongo, so Atlas won't be mutated by our runs; but if any re-run or drift-analysis is needed, the Mongo source at run-time is the reference-of-record and should be recoverable.

Both are questions, not asks-to-act. Once MediCard confirms the coverage, we can schedule the migrator run and produce a run-book proposal for the execution window.

## 5. Handover

This report is being handed to russherr on `mycurelabs/monobase-mycure#2247` for MediCard-side confirmation of the two backup coverage questions above.
