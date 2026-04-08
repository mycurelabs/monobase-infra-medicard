---
name: argocd-ops
description: This skill should be used whenever the user asks Claude to interact with ArgoCD in the medicard/infra repo — checking sync/health status, refreshing, force-syncing, hard-refreshing, watching a deployment, verifying that a deploy is fully rolled out, rolling back, or refreshing an ExternalSecret. It encodes the repo's GitOps conventions (app-of-apps, ApplicationSet, sync waves) and the documented "Health > Sync" rule.
version: 1.0.0
---

# argocd-ops

Operational playbook for ArgoCD in this repo. Every command below assumes the `kubectl-access` skill has already resolved the active kubeconfig and context — **always run that skill first** and prefix every `kubectl` here with `--kubeconfig <path> --context <ctx>` (omitted in the snippets for readability).

## Repo conventions you must know

- **ArgoCD namespace:** `argocd`.
- **Two-layer app-of-apps:**
  - `infrastructure` — the cluster-wide root Application that owns cert-manager, external-secrets, external-dns, gateway, velero, monitoring, etc.
  - `<namespace>-root` — created by the ApplicationSet at `charts/argocd-bootstrap/templates/applicationset-auto-discover.yaml`, one per file in `values/deployments/*.yaml`. Example: `medicard-staging-root`.
- **Per-client app naming:** `<namespace>-<component>`, e.g. `medicard-staging-postgresql`, `medicard-staging-hapihub`, `medicard-staging-api`.
- **Sync waves:** Wave -1 = namespace, Wave 0 = security baseline + infra, Wave 2 = data services (postgres, valkey, minio), Wave 3 = applications. Apps in Wave -1 and Wave 0 have `PruneLast=true` / `preserveResourcesOnDeletion: true` for a reason — **confirm with the user before any sync touches them.**
- **Authoritative docs:** `docs/operations/ARGOCD-SYNC-STATUS.md`, `docs/operations/SECRETS-MANAGEMENT.md`, `docs/operations/TROUBLESHOOTING.md`. Cite them when explaining decisions.

## The hard rule: Health > Sync

From `docs/operations/ARGOCD-SYNC-STATUS.md`:

> **"Healthy + OutOfSync" is the normal steady state** for cert-manager, gateway controllers, external-secrets, and other apps with controller-managed resources. ArgoCD has known bugs (#21308, #18344, #9678) where `ignoreDifferences` doesn't fully suppress drift on these.

Therefore:

- **Always report Health first, Sync second.**
- **Never** suggest a force-sync just because something is `OutOfSync`. Only suggest sync when:
  - Health is `Degraded` or `Missing`, **or**
  - The user explicitly wants to apply a fresh git commit (i.e. they pushed and want it live now).
- When listing apps, group by Health, not by Sync.

## a. Discover what's deployed

```bash
# All apps with health + sync side by side
kubectl -n argocd get applications -o custom-columns=NAME:.metadata.name,HEALTH:.status.health.status,SYNC:.status.sync.status,REVISION:.status.sync.revision

# All ApplicationSets
kubectl -n argocd get applicationsets

# Single app, compact
kubectl -n argocd get app <name> -o jsonpath='{.status.health.status}/{.status.sync.status}{"\n"}'
```

The list of "what apps *should* exist" lives in `values/deployments/*.yaml` — read that if the user asks "what's deployed for `<client>`?".

## b. Check status the right way

```bash
kubectl -n argocd get app <name> -o json | jq '{
  health:   .status.health.status,
  sync:     .status.sync.status,
  revision: .status.sync.revision,
  conditions: .status.conditions
}'
```

Drill into unhealthy resources only:

```bash
kubectl -n argocd get app <name> -o json \
  | jq '.status.resources[] | select(.health.status != null and .health.status != "Healthy")'
```

## c. Refresh (cheap — re-reads git, does not re-apply)

```bash
# Normal refresh — re-fetches manifests from git
kubectl -n argocd annotate app <name> argocd.argoproj.io/refresh=normal --overwrite

# Hard refresh — also busts the manifest cache. Use when you suspect cache poisoning
# or after a chart dependency update that ArgoCD didn't notice.
kubectl -n argocd annotate app <name> argocd.argoproj.io/refresh=hard --overwrite
```

A refresh is the right first move 90% of the time. It is **not** a sync — it does not touch the cluster.

## d. Force sync (with safety preamble)

**Before syncing**, check the app name. If it matches any of these, **stop and confirm with the user** before proceeding:

- `*-namespace` (Wave -1)
- `*-security-baseline` (Wave 0)
- `cert-manager`, `external-secrets`, `external-dns`, `gateway-resources` (Wave 0 infra)
- `infrastructure` (the cluster-wide root)

These have prune protections for good reason; an unintended sync can cascade.

### Path A — `argocd` CLI is on PATH (preferred)

First log in. The repo provides a helper:

```bash
mise run admin --service argocd
```

This port-forwards `argocd-server` and prints the admin password. Then in another terminal:

```bash
argocd login localhost:8080 --insecure --username admin --password '<from-mise-output>'
```

Then:

```bash
# Plain sync — apply the latest git revision, no prune
argocd app sync <name> --prune=false

# Targeted sync — only one resource
argocd app sync <name> --resource <group>:<kind>:<name>

# Force sync — only when the user explicitly says "force"
argocd app sync <name> --force
```

### Path B — kubectl-only fallback (no argocd CLI)

```bash
kubectl -n argocd patch app <name> --type merge -p '{"operation":{"sync":{"revision":"HEAD"}}}'
```

Watch the result with:

```bash
kubectl -n argocd get app <name> -w
```

## e. Force-refresh an ExternalSecret

The default `refreshInterval` is 1 hour. After rotating a secret in the upstream store, force the ESO controller to re-pull it now:

```bash
kubectl -n <ns> annotate externalsecret <name> force-sync=$(date +%s) --overwrite
```

Source: `docs/operations/SECRETS-MANAGEMENT.md`. This is the right tool when the user says "I just rotated the secret" or "the new credential isn't being picked up."

## f. Watch a deployment in flight

```bash
# Argo's view of the app
kubectl -n argocd get app <name> -w

# Pods rolling over
kubectl -n <target-ns> get pods -w

# Specific Deployment rollout
kubectl -n <target-ns> rollout status deploy/<name>
```

## g. Verify a deployment is *actually* done

A deploy is "done" only when **all five** of these are true. Run the composite block below and report each line:

```bash
APP=<app-name>
NS=<target-namespace>

# 1. Health status
kubectl -n argocd get app "$APP" -o jsonpath='{.status.health.status}{"\n"}'

# 2. Synced revision matches what the Application targets
kubectl -n argocd get app "$APP" -o jsonpath='target={.spec.source.targetRevision} synced={.status.sync.revision}{"\n"}'

# 3. All Deployments + StatefulSets fully available
kubectl -n "$NS" get deploy,statefulset \
  -o custom-columns=KIND:.kind,NAME:.metadata.name,DESIRED:.spec.replicas,READY:.status.readyReplicas,AVAILABLE:.status.availableReplicas

# 4. No Warning events in the last few minutes
kubectl -n "$NS" get events --field-selector type=Warning --sort-by=.lastTimestamp | tail -20

# 5. HTTPRoutes accepted (only if the app exposes one)
kubectl -n "$NS" get httproute -o json 2>/dev/null \
  | jq -r '.items[] | "\(.metadata.name): " + ([.status.parents[].conditions[] | select(.type=="Accepted") | .status] | join(","))'
```

A "Healthy" app whose `synced revision` is **older** than the `targetRevision` means the deploy is in flight, not done — keep watching.

## h. Rollback

```bash
argocd app history <name>
argocd app rollback <name> <revision-id>
```

**Stateful safety:** Rollback only undoes the manifest sync, not data migrations. Before rolling back any app whose name matches `*postgres*`, `*valkey*`, `*minio*`, or `*migrator*`, **stop and confirm with the user** that they understand a schema/data migration may have already run forward.

## i. Bootstrap / unbootstrap shortcuts

These already exist in the repo — use them, do not reinvent:

```bash
mise run bootstrap                  # Bootstrap cluster with GitOps (interactive)
mise run bootstrap -- --wait        # Bootstrap and wait for full first sync
mise run bootstrap -- --destroy     # Unbootstrap (tear down ArgoCD + apps)
mise run admin --service argocd     # Port-forward + show admin creds
```

The script is `scripts/bootstrap.ts`. Do not write a new bootstrap path.

## Decision recipes

| User says | Do |
|---|---|
| "is medicard-staging healthy?" | section (a) + (b), report Health first |
| "X is OutOfSync, fix it" | First check Health. If Healthy, explain the "Health > Sync" rule and ask whether they actually want a sync. |
| "I just pushed, deploy it" | section (c) `refresh=normal`, then watch with section (f) |
| "the chart cache is stale" | section (c) `refresh=hard` |
| "force-sync X" | section (d), apply safety preamble |
| "is the deploy done?" | section (g), all 5 checks |
| "I rotated the DB password" | section (e) on the relevant ExternalSecret |
| "rollback X" | section (h), apply stateful-safety check |
| "bring up a fresh cluster" | section (i), `mise run bootstrap` |
