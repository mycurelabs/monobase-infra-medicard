# MYCURE V5 — Deployment Process & Rollback Plan (MediCard)

**Prepared by:** MYCURE Engineering
**Prepared for:** MediCard Philippines — IT review and approval
**Scope:** MYCURE V5 (legacy platform) running on MediCard's Azure VMs — production
**Status:** For approval prior to the lab-changes deployment
**Source:** monobase-mycure#4995 — canonical copy posted as an [issue comment](https://github.com/mycurelabs/monobase-mycure/issues/4995#issuecomment-6031747982); handed to @russherr for submission to MediCard

---

## 1. Purpose

This document describes how MYCURE deploys new releases of the MYCURE V5
platform to MediCard's environments, and the rollback plan that applies if a
release must be reverted. It is submitted for review by MediCard IT ahead of
the upcoming lab-changes deployment; the same process applies to all V5
releases.

## 2. System overview

MYCURE V5 consists of two deployable components, plus managed external
services:

| Component | Production |
|---|---|
| API server (`hapihub` V5, service `mycure-api`) | Prod API VM (172.26.255.4) |
| Web client (MYCURE V5 web application, served by the web VM) | Prod web VM (172.26.255.132) |
| Database | MongoDB Atlas `medicard-production` |

Notes:

- The **database is a managed MongoDB Atlas cluster** and is *not* redeployed
  during an application release. Application releases change only the binaries
  / web assets on the VMs above.
- The on-premises sync nodes (Festival / Cebu) are **out of scope** for a
  standard V5 release; they are touched only by their own, separately planned
  maintenance.

## 3. Release artifacts and versioning

A V5 release consists of one or both of the following artifacts, each
versioned by MYCURE's release pipeline. A release that changes only one
component deploys only that component's artifact.

**API server**

- A **versioned, self-contained artifact** — e.g.
  `hapihub_linux_amd64_5.220.77.tgz`.
- Runs as a **single packaged binary** (`/srv/mycure/hapihub`) managed by
  systemd as the `mycure-api` service.

**Web client**

- A **versioned, self-contained artifact**, same as the API server — e.g.
  `webapp-cms_5.130.6-medicard.tgz`: a compressed tar of the built web
  application.
- The application itself is a **browser-delivered single-page application**
  — a build of static assets (HTML, JavaScript, CSS, images) produced from
  the MYCURE CMS codebase, with MediCard-specific versions tagged
  `<version>-medicard`.
- It is **served by the web server (nginx) on the web VM** as static files —
  there is no application process of its own to manage, and nothing is
  installed on end-user workstations. Users receive the deployed version
  simply by loading the site in their browser.
- The web server serves the build from a **fixed serving directory** on the
  web VM. On deploy, the currently served build's directory is **renamed
  aside — kept intact as the rollback copy** — and the new build is unpacked
  into the serving path in its place. Rollback is the reverse rename.
- The build's runtime settings (notably the API endpoint it talks to) are
  environment configuration, kept separate from the asset bundle in the same
  way as the API server's config.

**Common properties**

- **Configuration is separate from code.** Environment configuration (e.g.
  `/etc/mycure/apid.env` on the API VM, the web server configuration on the
  web VM) is *not* modified by a code release. Config changes, when needed,
  are their own change item with their own backup (the previous file is
  copied aside before any edit).
- Because artifacts are versioned and immutable, deploying and rolling back
  are the same mechanical operation pointed at different versions.

## 4. Access control and auditability

- All deployment access is made **through a single sanctioned SSH jump host**
  operated by MYCURE, connected to the MediCard VNet over VPN. No direct
  public access to the VMs is used.
- Access is **SSH public-key only**, restricted to named MYCURE engineers.
- All sessions are logged on the jump host (login accounting, SSH
  authentication logs, and systemd journal), giving an independent audit
  trail of exactly when MYCURE accessed MediCard's environment.

## 5. Deployment process

Every release follows the same pipeline: **QA verification, MediCard
approval, then production deployment in an agreed window.** Production is
never deployed a build that has not passed verification and sign-off.

### 5.1 Pre-deployment checklist

Before any deployment is scheduled:

- [ ] Release built, versioned, and its changelog shared with MediCard.
- [ ] **Release verified by MYCURE QA**: the changed functionality (for the
      lab changes: the laboratory workflows end-to-end) plus a standard
      regression smoke test (login, patient search, encounter).
- [ ] Change approved by MediCard (this document's process followed).
- [ ] Deployment window agreed with MediCard (production: off-peak).
- [ ] Current (to-be-replaced) version number recorded; its artifact
      confirmed present on the target VM for instant rollback.
- [ ] **Pre-deployment database backup taken and verified** — an on-demand
      snapshot/dump of the production database, taken immediately before
      the production window and retained until the release is declared
      stable (end of soak, §5.4). Production is not deployed without it.
- [ ] Rollback owner and go/no-go decision maker named for the window.

### 5.2 Production deployment

Performed inside the agreed window, by a named engineer, with the rollback
owner on standby:

1. Announce start of window to MediCard contacts.
2. Upload the **verified artifacts** (same versions, same checksums as the
   builds that passed QA) to the production API and/or web VM via the jump
   host (e.g. `rsync hapihub_linux_amd64_<version>.tgz`,
   `rsync webapp-cms_<version>.tgz`).
3. Record the currently running version of each component being deployed;
   confirm its artifact/build directory is retained on disk.
4. **API server**: unpack the artifact and replace the service binary (the
   previous version's artifact and binary are retained on the VM), then
   restart the service: `sudo systemctl restart mycure-api`.
5. **Web client**: rename the currently served build directory aside
   (suffixed with its version) — it remains intact on the VM as the
   rollback copy — then unpack the new build into the serving directory in
   its place. The swap is a rename + unpack, taking seconds; no web-server
   restart is required — nginx serves the new files immediately.
6. Run the verification suite (§5.3).
7. Announce completion; begin the soak period (§5.4).

Expected service interruption: the `mycure-api` restart takes on the order of
seconds; the web client swap (rename + unpack) likewise takes seconds, with
nginx running throughout — already-open browser sessions keep working, and
users pick up the new version on their next page load. The deployment as a
whole fits comfortably inside a 30-minute window including verification.

### 5.3 Post-deployment verification

A deployment is only declared successful when all of the following pass:

**API server**

- `systemctl status mycure-api` active, all worker processes up, no restart
  loop in the journal.
- API health check over the real client path (the public API URL) and
  directly on `:7500` returns success.
- Application logs clean of new errors for the verification period.
- Version check confirms the new version is the one serving traffic.

**Web client**

- Site loads over the real client path; nginx serving the new build
  (version check in the app's about/build info matches the deployed
  version).
- Static assets load cleanly — no missing-asset (404) or console errors on
  the main screens.
- The web client authenticates and talks to the API successfully (login
  completes end-to-end through the deployed pair).

**Functional smoke test (through the web client)**

- Login, patient lookup, and the workflows changed by the release (for the
  lab changes: result entry/viewing via the lab module).

### 5.4 Soak period

For 24 hours after a production deployment, MYCURE remains on standby and
treats any regression report from MediCard with rollback-first priority
(see §6.2).

## 6. Rollback plan

### 6.1 Design principle

Rollback is **redeployment of the previous version**, which is still present
on the VM. No rebuild, no download dependency, no database restore is needed
in the normal case.

V5 releases are **backward compatible with the data**: MongoDB is
schema-flexible and V5 releases do not perform destructive data migrations,
so the previous binary runs correctly against the database as it exists
after the new version has been live. This is what makes rollback a
minutes-level, low-risk operation.

If a specific release ever required a non-backward-compatible data change,
it would be flagged as such in the change request, with its own tailored
rollback plan agreed before approval — the default plan in this document
assumes (and our release policy enforces) backward compatibility.

### 6.2 Rollback triggers

Rollback is initiated when any of the following occurs after a production
deployment:

| Trigger | Decision |
|---|---|
| Post-deployment verification (§5.3) fails and is not trivially fixable within the window | Roll back immediately, inside the window |
| Service unstable (crash loop, worker failures) | Roll back immediately |
| Functional regression in a critical workflow (patient care, lab results) confirmed during soak | Roll back; fix forward only with MediCard's agreement |

The named rollback owner for the window makes the call; MediCard can request
a rollback at any time during the soak period.

### 6.3 Rollback procedure (API server)

1. Announce rollback start to MediCard contacts.
2. On the production API VM (via the jump host): reinstall the retained
   previous artifact — the inverse of §5.2 step 4.
3. `sudo systemctl restart mycure-api`.
4. Run the verification suite (§5.3), including a version check confirming
   the previous version is serving.
5. Announce completion.

**Estimated time to restore service: 5–10 minutes** from the rollback
decision.

### 6.4 Rollback procedure (web client)

Because the replaced build is renamed aside — not deleted — at deploy time
(§5.2), web rollback is the reverse rename:

1. Announce rollback start to MediCard contacts.
2. On the web VM (via the jump host): move the faulty new build out of the
   serving directory and rename the preserved previous build back into
   place. Takes seconds; no web-server restart required.
3. Verify (§5.3 web checks): site loads, about/build info reports the
   previous version, assets clean, login works end-to-end.
4. Announce completion.

End-user effect: nothing to uninstall or push to workstations — browsers
receive the previous version on their next page load (build assets are
fingerprinted per version, so no stale-cache mixing between versions; at
most, users with the rolled-back-from version still open are asked to
refresh).

**Estimated time to restore service: under 5 minutes** from the rollback
decision. If the release deployed both components, the API server (§6.3) and
web client roll back together within the same 5–10 minute bound.

### 6.5 Configuration rollback

If the change included a config edit (`/etc/mycure/apid.env` on the API VM,
or the nginx/web-server configuration on the web VM), restore the backed-up
previous file and restart/reload the affected service.

### 6.6 After a rollback

- The release is treated as failed; a post-incident report with root cause
  is shared with MediCard.
- No redeployment of the same change is scheduled until the root cause is
  fixed, re-verified by MYCURE QA, and re-approved.

## 7. Roles and responsibilities

| Role | Responsibility |
|---|---|
| MYCURE release engineer | Builds artifact, executes the production deployment |
| MYCURE verification engineer | Runs the post-deployment verification suite (§5.3) and QA verification (§5.1) |
| MYCURE rollback owner | Go/no-go at each gate; executes rollback if triggered |
| MediCard IT | Change approval and sign-off; rollback request authority during soak |
| MediCard + MYCURE contacts | Window announcements, status during deploy/soak |

## 8. Summary

- QA-verified, sign-off-gated releases; production only in an agreed
  off-peak window.
- Versioned, immutable artifacts; config separated from code; previous
  version always retained on the VM.
- Rollback = switch back to the previous retained version — a service
  restart for the API, a seconds-level directory rename back for the web
  client: **5–10 minutes total**, no data restore required, enforced by a
  backward-compatibility release policy.
- A verified pre-deployment database backup gates every production deploy,
  as the last-resort safety net.
- All access via one audited, key-only SSH jump path.
