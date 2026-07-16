# 2026-07-16 — Two brief prod outage windows observed overnight

**Status:** Two short prod outage windows on the overnight of 2026-07-15 → 2026-07-16 — both self-recovered before any in-flight capture, no user intervention taken at the time. Logged here for the running record; not root-caused.
**Environment:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia), tenant namespace `medicard`.
**Access path:** kubectl from operator jumphost `mc.remote.prd.bastion` via `ssh medicard.gateway`.

> This report is a **situation log**, not a root-cause investigation. Both windows were noticed after they had cleared. No pod restart history, event stream, or Prometheus/Loki data was captured mid-incident, and no forensic reconstruction was attempted after the fact. Anything more than the observed timestamps and self-recovery would be speculation.

---

## What was observed (timeline)

- **2026-07-15 ~21:15 (9:15 PM local, ~13:15 UTC):** brief prod outage window. Self-recovered before response. No user-visible-tickets, no manual intervention.
- **2026-07-16 ~01:31 (1:31 AM local, ~17:31 UTC):** second brief prod outage window a few hours later. Same shape — brief, self-recovered before any capture.

Both were surfaced as user-facing API blip windows. Duration in each case was short enough that the recovery had already happened by the time the observation was made.

## Scope of impact

- Gateway-adjacent, user-facing. No data-tier writes were interrupted in a way that surfaced downstream — Azure PG and Azure Blob both remained reachable throughout (external managed services, not affected by cluster-side blips).
- No lasting state change observed in ArgoCD (no long-running out-of-sync post-window; healthy at follow-up check the following morning).
- No data loss observed.

## What was NOT done

- No in-flight log capture (nothing pulled from CoreDNS, Envoy, hapihub, or kube-system during the windows).
- No pod-restart / OOM / crashloop histogram after the fact — the windows were too brief and too far-back-in-history to reconstruct reliably from the surviving event stream (`kubectl get events` has a 1-hour retention default in AKS).
- No root-cause assignment. Possible candidates that would fit the observed shape include: node pressure eviction on a single-replica component, Envoy gateway config-reload transient, Azure Load Balancer probe flap — but none of these were checked and any of them is speculation.

## Follow-ups

- **Real-time paging would have caught both.** Alertmanager receiver structure and PrometheusRules ship in the monitoring stack (see prod-hardening pass earlier in the running record); the Slack webhook binding is wired via ExternalSecret but the KV entry `medicard-prod-alertmanager-slack-webhook` is still a placeholder — no webhook URL populated. Once that KV entry has a real value, the two windows above would page immediately.
- Same story for ArgoCD notifications — the token binding is wired to `medicard-prod-argocd-slack-token`, KV entry still empty.
- No prescription attached to either — populating those KV entries is a MediCard-side action, noted here as an observation only.

## References

- Alertmanager routing structure: [`../charts/monitoring-resources/templates/alertmanager-config.yaml`](../charts/monitoring-resources/templates/alertmanager-config.yaml)
- KV entries pending population: see the prod-hardening notes in the standing record.
