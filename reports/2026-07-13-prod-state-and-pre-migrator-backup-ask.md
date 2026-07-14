# 2026-07-13 — Prod Cluster State + Pre-Migrator Backup Ask

**Status:** Prod cluster is HA-hardened, cache-tier live, observability + security operators fully deployed. `mycure` (CMS frontend) and `s3proxy` (Azure Blob facade) are healthy at 2/2. **`hapihub` (API) is currently CrashLoopBackOff at 0/2 replicas — 219 restarts on both pods over ~19h — blocked on the same Drizzle migration (`0054_accounts_email_lower_unique`) that gates the `hapihub-migrator` run.** The migrator itself is paused (`replicaCount: 0`). The one item that unblocks both: MediCard's decision on the 18 case-variant duplicate rows in the `accounts` table. Before that decision is executed, **please confirm that Azure PG and Atlas Mongo backup coverage is in place** — details in §5.

**Environment under test:** Production AKS cluster `aks-mpi-sea-p-mycurex01`.
**Access path:** kubectl executed from `mc.remote.prd.bastion` via `ssh medicard.gateway`.
**Prior state:** see [`2026-07-10-prod-cluster-kv-connectivity-revalidation-round-3.md`](./2026-07-10-prod-cluster-kv-connectivity-revalidation-round-3.md). That report closed with the KV/DNS/RBAC/PG-grant chain fully green from our side.

**Scope disclaimer.** Observation only. No prescriptions to MediCard. Read-only DB inspection was performed inside a session-level `SET default_transaction_read_only = on` guard; no writes were attempted or possible. Sample values shown below are redacted where sensitive.

---

## 1. Current state (as of report timestamp)

| Subsystem | Pods (ready / desired) | HA posture | Notable state | Changed since 2026-07-10 |
|---|---|---|---|---|
| **hapihub (API)** | **0/2** | 2 replicas configured + PDB + hostname anti-affinity | CrashLoopBackOff, 219 restarts. Boot fails on Drizzle migration `0054_accounts_email_lower_unique` (duplicate `lower(email)` values in `accounts`). API endpoint `api-mycurex.medicardphils.com` currently returns 503 (no ready endpoints). | ↑ HA scaffolding shipped; ↓ regressed to 0-ready once we re-attempted a rollout |
| **mycure (CMS)** | 2/2 | 2 replicas + PDB + anti-affinity | Healthy | ↑ HA shipped |
| **s3proxy (S3→Blob)** | 2/2 | 2 replicas + PDB + anti-affinity | Healthy | ↑ HA shipped |
| **hapihub-migrator** | 0/0 | Paused by design (`replicaCount: 0`) | Blocked pending duplicate-email decision + backup confirmation | No change |
| **cadence (WebSocket sync)** | 0/0 | disabled | Chart re-backported from mycure prod (Rust rewrite, `cadence:0.7.10`, PG+Valkey). Re-enable attempted, stalled on Azure PG TLS handshake; flipped back to disabled pending resolution. | ↑ chart backport shipped; live enable deferred |
| **valkey (in-cluster cache)** | 1/1 | Standalone (soft dep) | `valkey-primary-0` Running; password ESO-minted in-cluster; hapihub env wires `REDIS_URL` + `CACHE_ENABLED` when hapihub boots. | NEW |
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

`kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded` → **No resources found** (all non-Running-state slots are empty — the hapihub crashloops are pods in `Running` state whose container is `CrashLoopBackOff`, which does not exclude them from `phase=Running`).

## 2. What shipped since 2026-07-10 (grouped)

- **Prod hardening pass** — hapihub session-prune CronJob (Better Auth never expires its own rows), Alertmanager routing structure + ExternalSecret wired to a placeholder KV entry (`medicard-prod-alertmanager-slack-webhook`, currently unpopulated by design — alerts render but don't page until MediCard populates it), same shape for ArgoCD deploy notifications (`medicard-prod-argocd-slack-token`), Kyverno operator + three ClusterPolicies (`pod-security`, `require-labels`, `restrict-registries`), Falco with two custom rulesets (api / database), `allow-*` NetworkPolicies for hapihub↔s3proxy and gateway→apps, weekly Velero cluster-resource schedule, Grafana + Loki datasource wired for from-a-single-pane log/metric queries.
- **Crashloop remediation** — three tiers of self-inflicted breakage from the hardening pass got fixed: Kyverno's cleanup CronJobs pulled `bitnami/kubectl` which Bitnami delisted in mid-2025 (redirected to `bitnamilegacy/kubectl`); the three Kyverno ClusterPolicies had no operator-namespace exclusions (added a shared exclude list covering kube-system/argocd/kyverno/falco/ESO/envoy-gateway-system/cert-manager/monitoring/loki/velero); Falco 0.38.1 (chart 4.6.1) failed `scap_init` on AKS's 6.8.0-azure kernel, bumped to chart 9.1.0 shipping Falco 0.44.1; and Kyverno's `pod-security` + `require-labels` in enforce mode admission-blocked the 1→2 tenant rollout because MediCard's chart templates don't yet set `securityContext.runAsNonRoot=true` or the `app/environment/client` label taxonomy — flipped both to `audit` (violations still visible in PolicyReports; enforcement pending chart-side compliance work).
- **HA rollout** — every stateless / leader-elect-capable tier moved to 2 replicas (hapihub, mycure, s3proxy, Envoy Gateway controller + data-plane, ArgoCD server + repo-server + applicationset, ExternalSecrets controller + webhook + cert-controller, Kyverno all four controllers) or 3 replicas (Alertmanager, for gossip quorum). Grafana went 1→2 with an in-cluster Postgres backend replacing the per-pod SQLite (needed for shared state across replicas). Two zones today (`southeastasia-1` + `southeastasia-2`, 3 nodes total) is enough for 2-replica spread. Prometheus and Loki stay single-replica — real HA needs mode changes / Thanos-class projects.
- **Valkey response cache** — Bitnami valkey subchart (chart 2.2.1, image `bitnamilegacy/valkey:8.0.1-debian-12-r2`, standalone architecture). Same instance intended to back cadence too. Password minted once in-cluster by an ESO Password generator — no client KV entry needed. Hapihub's chart now includes the env plumbing (`REDIS_URL` with `$(VALKEY_PASSWORD)` expansion, `CACHE_ENABLED=true`) so once hapihub's boot blocker clears, the cache activates automatically.
- **Cadence chart backport** — MediCard's `charts/cadence/` was the legacy Mongo-based `syncd` chart, incompatible with MediCard's external-Atlas topology. Replaced wholesale with the current mycure-prod cadence chart (Rust rewrite, image `ghcr.io/mycurelabs/cadence:0.7.10`, uses PG + Valkey backends). Added a new `postgresql.external: true` mode so the chart can mount `CADENCE_PRIMARY_DB_URL` from a Secret directly (preserves `?sslmode=require` and other connection-string flags). Enable attempt stalled on TLS handshake failure between cadence's Rust PG driver and Azure PG (`error performing TLS handshake` — same `DATABASE_URI` that works for hapihub); flipped back to `enabled: false` while we investigate. Chart + values scaffolding all in place; re-enable is a one-flag change once the TLS path is proven.
- **Chart-version alignment** — full audit vs `mycure/infra` showed almost no drift. Kyverno, Velero, Envoy Gateway, ExternalSecrets all match. Falco is intentionally *ahead* (9.1.0 vs mycure 4.6.1, driven by the AKS-kernel fix above). Pinned the Bitnami kube-prometheus chart at 11.3.10 (previously the ArgoCD Application resolved `.Values.monitoring.version` with no default, silently pulling `latest` at render time).

## 3. hapihub boot + migrator status

Both are blocked on the same root cause:

- **hapihub**: on boot, runs Drizzle migrations against Azure PG. Migration `0054_accounts_email_lower_unique` attempts `CREATE UNIQUE INDEX ON accounts(lower(email))`. Azure PG rejects with `Key (lower(email))=(REDACTED@example.com) is duplicated` (SQLSTATE 23505). Node process exits (Bun v1.3.11), pod restarts, boot retries — 219 restarts and counting. Effect: `api-mycurex.medicardphils.com` currently has zero backends behind the HTTPRoute.
- **hapihub-migrator**: paused (`replicaCount: 0`). When flipped on it will try to bulk-migrate Mongo Atlas → Azure PG; the same `0054` migration path applies during its own boot sequence, so it will fail identically until the duplicates are resolved.

Read-only DB inspection performed earlier today (via an ephemeral `psql` pod with `default_transaction_read_only=on`, session-scoped, no writes possible):

- **18 duplicate groups**, exactly 2 rows each, 36 rows total (~0.6% of the 2,860 accounts). All 100% case-variant duplicates — the second row differs from the first only in email casing (e.g. `Alpha@example.com` vs `alpha@example.com`).
- All 36 rows are **dormant**: `signins_count = 0`, `last_active_at = NULL`, `is_email_verified = false`, `updated_at = NULL`. Each has a stored password but the account was never activated. Likely root cause: early Mongo→PG data-import pipeline didn't normalise email casing, either ran twice with different casings or interacted with self-registration that produced a same-day duplicate.
- **What was NOT swept:** `accounts.uid` has no formal PG FK constraints referencing it, but the schema has ~100+ text-typed reference columns across 141 tables (`created_by`, `account`, `owner_id`, etc.) — any of the 36 uids may be silently referenced. `activity_logs` alone has 84M rows; `billing_items` 6.2M; `billing_invoices` 2.9M. A naive delete of one side of a pair could silently orphan real records.

## 4. What backup coverage we ship vs what we don't

- **Ships (our side):**
  - **Velero** — daily backup of infrastructure namespaces (kube-system, argocd, envoy-gateway-system, external-secrets-system, monitoring, cert-manager, kyverno, falco, velero) with 30-day retention. Weekly backup of cluster-scoped resources (CRDs, ClusterRoles, StorageClasses, webhooks) with 90-day retention. Backup objects land in the `blobmpseapmycurex01` Azure Blob container.
  - Scope: Kubernetes API objects (Deployments, Secrets, ConfigMaps, PVCs and their contents). Restores redeploy the cluster state, not the source data behind external services.
- **Does NOT ship (out of our scope):**
  - **Azure Postgres `mpiazeppgdb0003`** — this is the managed Azure DB for PostgreSQL Flexible Server behind hapihub + migrator + cadence. Its backup posture (Point-In-Time Restore retention, geo-redundant backup) is set on MediCard's Azure subscription. Velero does not read from or back up managed DBs.
  - **MongoDB Atlas source** (`mycure-stg-sh.q4trx.mongodb.net`, per the KV `medicard-prod-mongo-source-uri`) — Atlas's own continuous-backup / snapshot policy applies. Set on MediCard's Atlas project.

## 5. The ask

Before the duplicate-email decision is executed (any DELETE or UPDATE against the `accounts` table), and before the hapihub-migrator is un-paused, MediCard's confirmation on the following would materially reduce downside risk. This is observation only — the operational settings are on MediCard's side of the boundary.

1. **Azure PG PITR / retention confirmation.** For `mpiazeppgdb0003.postgres.database.azure.com`:
   - Is PITR enabled?
   - What retention window is configured?
   - Does that window cover the intended operation timeline plus a soak period afterward (i.e. is there enough headroom to roll back if a downstream effect is discovered days later)?
2. **Atlas Mongo backup coverage.** For the source database referenced by `medicard-prod-mongo-source-uri`:
   - Is continuous backup or an on-demand snapshot policy in place?
   - Does the retention cover the migrator run + soak?
   - Note: the migrator reads-only from Mongo, so Atlas won't be mutated by our runs; but if any re-run or drift-analysis is needed, the Mongo source at run-time is the reference-of-record and should be recoverable.

Both are questions, not asks-to-act. Once MediCard confirms the coverage, the sequence downstream is theirs to decide (resolve duplicates → un-pause migrator → observe → un-block hapihub). We can produce a run-book proposal if useful, but only after backup coverage is confirmed.

## 6. Handover

This report is being handed to russherr on `mycurelabs/monobase-mycure#2247` for MediCard-side follow-up on the backup confirmation questions and the duplicate-email decision.
