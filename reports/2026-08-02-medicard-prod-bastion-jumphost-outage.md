# 2026-08-02 — Prod kubectl jumphost unreachable ~22h (scheduled VM auto-shutdown)

**Affected system:** `mc.remote.prd.bastion` — the sole kubectl jump host to the medicard prod cluster
**Host:** `SEA-VM-STG-MYCURE-WEB`, `172.23.4.8` (Ubuntu, kernel `5.4.0-1109-azure`), staging VNet `172.23.4.0/24`
**Reached via:** `medicard.gateway` (VPN) → `mc.remote.prd.bastion`
**Protects:** private-link cluster `aks-mpi-sea-p-mycurex01` (namespace `medicard`) + its Azure PostgreSQL target — neither is reachable from outside the VNet, so this VM is the only operator path in.
**Severity:** High (operational) — no live-service impact, but **all operator access to prod K8s + PG was blocked for ~22h**, including an in-progress CDC-recovery.
**Status:** RESOLVED (VM auto-started 2026-08-02 23:00 UTC). Root cause is a standing schedule — will recur daily unless changed.

---

## Summary

On 2026-08-02, the prod kubectl jump host became unreachable (TCP/22 timeout, 100% ICMP loss) from the gateway at ~00:58 UTC and stayed down until ~23:01 UTC — ~22 hours. The gateway and the legacy API box (`mc.remote.prd.api`) were reachable throughout, so the outage was isolated to this one VM.

Root cause is **not** a crash or network fault: the VM is on a **scheduled auto-shutdown / auto-start cycle**. On-box `last -x` shows a boot every day at 23:00 UTC and a matching shutdown; the shutdown time was **moved earlier from 13:00 to 00:10 UTC on 2026-08-01**, collapsing the VM's daily availability from ~14h to ~1h. The observed "outage" was simply the VM's deallocated window (Aug 2 00:10 → 23:00 = 22h50m down). It "recovered" on its own only because the scheduled 23:00 auto-start brought it back.

The prior bastion access earlier in the same session succeeded because it happened *before* the 00:10 shutdown; the intervening investigation used `mc.remote.prd.api` (Mongo), which does not depend on the bastion, so the shutdown went unnoticed until the next bastion call at 00:58.

---

## Impact

- **No live-service impact.** The medicard app, the p-cluster workloads, and the Azure-managed K8s control plane run independently of this VM. Patients/clinics were unaffected.
- **Total loss of operator access to prod for ~22h** — no `kubectl` (pods, logs, scaling, jobs) and no path to the Azure PG target (both are private-link / VNet-only, reachable only through this jump host).
- **Blocked an active incident recovery.** The CDC Mongo→PG forward-sync repair (see `2026-08-02-cdc-changestream-oplog-break.md`) was mid-flight and could not proceed for the full window; the CDC pipeline stayed broken and the PG target kept diverging that entire time.
- **Incident-response risk.** With the current schedule the VM is up only ~1h/day (around 23:00 UTC). Any prod incident outside that window cannot be triaged until the next auto-start. The recovery this time succeeded only because it coincided with the 23:00 boot.

---

## Timeline (UTC)

| Time | Event |
|---|---|
| 2026-08-02 ~00:0x | Bastion in use (early investigation: `kubectl` on p-cluster succeeds). |
| 2026-08-02 00:10 | **Scheduled shutdown** of `SEA-VM-STG-MYCURE-WEB` (`last -x shutdown`: `00:10 - 23:00 (22:50)`). VM deallocated. |
| 2026-08-02 00:10–00:58 | Investigation continues via `mc.remote.prd.api` (Mongo) — no bastion needed, so the shutdown is not yet noticed. |
| 2026-08-02 00:58:37 | First failed bastion probe (TCP/22 timeout, 100% ICMP loss from gateway). Retry watcher started. |
| 2026-08-02 00:58 → 23:01 | 580 consecutive failed probes (every ~120s). Gateway + `mc.remote.prd.api` reachable throughout. |
| 2026-08-02 23:00:10 | **Scheduled auto-start** — VM boots (`uptime -s` = `2026-08-02 23:00:10`; `last -x reboot`: `Sun Aug 2 23:00 still running`). |
| 2026-08-02 23:01:40 | Bastion reachable again (probe 581 = UP). `kubectl` confirmed working. Recovery resumes. |

**Total observed outage: ~22h03m** (00:58:37Z → 23:01:40Z). **Actual VM-down window: ~22h50m** (00:10Z → 23:00Z per on-box records).

---

## Root cause

The VM runs on an automated start/stop schedule (consistent with an Azure auto-shutdown policy plus a scheduled start). On-box evidence:

```
$ last -x reboot
reboot  system boot  Sun Aug  2 23:00   still running
reboot  system boot  Sat Aug  1 23:00 - 00:10  (01:09)
reboot  system boot  Fri Jul 31 23:00 - 00:10  (01:09)
reboot  system boot  Thu Jul 30 23:00 - 13:00  (13:59)
reboot  system boot  Wed Jul 29 23:00 - 13:00  (13:59)
reboot  system boot  Tue Jul 28 23:00 - 13:00  (13:59)

$ last -x shutdown
shutdown system down  Sun Aug  2 00:10 - 23:00  (22:50)   <-- our outage
shutdown system down  Sat Aug  1 00:10 - 23:00  (22:50)
shutdown system down  Fri Jul 31 13:00 - 23:00  (10:00)
shutdown system down  Thu Jul 30 13:00 - 23:00  (10:00)
shutdown system down  Wed Jul 29 13:00 - 23:00  (10:00)
shutdown system down  Tue Jul 28 13:00 - 23:00  (10:00)
```

Daily availability window (UTC):

| Date | Up (boot → shutdown) | Down until next boot |
|---|---|---|
| Jul 28–31 | 23:00 → 13:00 (~14h up) | 13:00 → 23:00 (~10h) |
| **Aug 1 onward** | 23:00 → **00:10** (~1h up) | **00:10 → 23:00 (~22h50m)** |

The shutdown time moving from 13:00 to 00:10 on Aug 1 is what turned a tolerable ~10h nightly gap into a ~23h daily blackout — and is why the CDC recovery was blocked for so long.

---

## Detection

There was no alert. The outage was detected only because an operator was actively trying to use the jump host and set up a manual retry watcher (`/tmp/medicard/bastion-watch.log`, probe = `ssh medicard.gateway "ssh mc.remote.prd.bastion hostname"` every 120s).

Retry summary: **581 probes, 580 DOWN, 1 UP.** First DOWN `2026-08-02T00:58:37Z`; last DOWN `2026-08-02T22:59:23Z`; first UP `2026-08-02T23:01:40Z`.

---

## Resolution

None required from our side — the VM's scheduled 23:00 UTC auto-start brought it back and `kubectl` access was restored automatically. The condition will recur every day.

---

## Recommendations

1. **Remove or widen the auto-shutdown on `SEA-VM-STG-MYCURE-WEB`.** As the *sole* kubectl/PG path to prod, a ~1h/day availability window is unacceptable for incident response. Either disable the auto-shutdown, or restore a large business-hours window across the on-call timezone.
2. **If cost-driven shutdown must stay, provide an alternate prod-access path** that does not depend on this single VM (e.g., a second jump host on a different schedule, an Azure Bastion, or on-demand start automation the on-call can trigger).
3. **Alert on jump-host reachability** (and on the CDC/migrator health behind it) so a deallocated window during an incident is surfaced immediately rather than discovered by hand.
4. **Confirm the schedule owner/intent.** The shutdown time changed on 2026-08-01 (13:00→00:10) — verify this was intentional and understood, given the VM's role.

---

## Environment

- **Host:** `SEA-VM-STG-MYCURE-WEB` / `172.23.4.8`, Ubuntu `5.4.0-1109-azure`, TZ `Etc/UTC`, staging VNet `172.23.4.0/24`
- **Role:** prod kubectl jump host (holds kubeconfig for `aks-mpi-sea-p-mycurex01`, southeastasia, Azure Private Link) — the "bastion" label is about role, not network location
- **Access path:** local `~/.ssh/config` alias `medicard.gateway` (VPN) → `ssh mc.remote.prd.bastion`
- **Unaffected during outage:** `medicard.gateway`, `mc.remote.prd.api` (legacy Mongo access), the p-cluster workloads, the live app
