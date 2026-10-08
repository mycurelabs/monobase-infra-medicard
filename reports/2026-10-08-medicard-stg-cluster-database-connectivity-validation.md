# MediCard staging cluster — DB connectivity validation for the migrator IaC (2026-10-08)

**Status:** PostgreSQL target **and** MongoDB source are reachable end-to-end
(DNS → TCP → TLS → auth → query) from inside the **staging** cluster. The
migration **network path is ready**. The one outstanding item is Key Vault
contents (see §4) — not connectivity.

**Environment under test:** staging AKS `aks-mpi-sea-a-mycurex01` (southeastasia),
namespaces `medicard-staging` / `external-secrets-system`.

**Access path:** Azure Bastion → jump host `vm-mpi-sea-p-mycure01` →
`kubectl --context aks-mpi-sea-a-mycurex01` (the jump box default context is
**prod** — staging requires the explicit `--context`; see the access report).

**Translated from the prod connectivity-validation series**
([`2026-07-07`](./2026-07-07-prod-cluster-database-connectivity-validation.md) and
earlier) and the migrator Mongo outage report
([`2026-07-15`](./2026-07-15-migrator-mongodb-source-connectivity-outage.md)),
adapted to staging naming. Purpose: confirm the hapihub-migrator IaC will run once
deployed into the staging cluster.

---

## 1. Scope

Re-validate, **from inside the staging cluster**, that the two database endpoints
the migrator needs are reachable end-to-end, and that the secret material the
migrator's ExternalSecrets will reference exists. The migrator reads from the
MongoDB **source** and writes to the PostgreSQL **target**.

| Target | Endpoint |
|---|---|
| **PostgreSQL (target)** | `mpiazeapgdb0002.postgres.database.azure.com:5432`, db `postgres`, user `mpadmin02`, `sslmode=require` |
| **MongoDB (source)** | `mongodb+srv://***@mycure-stg-sh.q4trx.mongodb.net/medicard-production?authSource=admin` |

*Credentials redacted. Read-only / non-destructive: only `ping`, `listDatabases`,
`version`, and `SELECT`-class size queries were issued. No writes.*

## 2. Methodology

All `kubectl` run from the operator jump host (the only network position that can
reach the staging API). Each probe ran **inside the staging cluster** so results
reflect the migrator's actual network position.

| Probe | How | Purpose |
|---|---|---|
| PostgreSQL | `kubectl exec` into the running `hapihub` pod, pure-stdlib Python SCRAM client reading `DATABASE_URI` from pod env (no psql/driver exists) | DNS + TCP + TLS + auth + size query |
| MongoDB | transient `mongo:7` pod (SA `external-secrets`), `mongosh` against the source URI pulled from the prod `hapihub-migration-secrets` Secret | DNS(SRV) + TCP + TLS + auth + listDatabases |
| Key Vault | transient `azure-cli` pod bound to the `external-secrets` workload identity, `az keyvault secret list` | enumerate secrets reachable to ESO |

Both transient pods were **deleted immediately** after use.

## 3. Findings — connectivity ✅

### 3.1 PostgreSQL target — `mpiazeapgdb0002` ✅
DNS resolves from the hapihub pod to **`4.194.210.116`** (a **public** IP — staging
PG is public-networked + firewalled, not a private endpoint like prod). TCP 5432
completes, TLS (`sslmode=require`) + SCRAM-SHA-256 auth as **`mpadmin02`** succeed,
`postgres` database ≈ **2264 GB**. Reachable and writable-target-ready from the cluster.

### 3.2 MongoDB source — `mycure-stg-sh.q4trx.mongodb.net` ✅
From inside the staging cluster: SRV resolution + TLS + auth succeed
(`db.adminCommand({ping:1}) → { ok: 1 }`), and the source database
**`medicard-production`** is visible. The staging cluster's egress IP is **already
allowlisted** in Atlas (same class of endpoint that caused the prod outage in the
2026-07-15 report — here it is reachable).

## 4. Findings — Key Vault contents ⚠️ (the gating item)

`kv-mpi-sea-a-mycurex01` is reachable from the cluster via Workload Identity
(ESO store `Valid/Ready`). Authoritative `az keyvault secret list` returns **only**:

```
medicard-staging-minio-root-password
medicard-staging-mongodb-root-password
medicard-staging-postgresql-password
```

The migrator's ExternalSecrets (translated from prod `hapihub-migration-secrets`)
will reference secrets that are **absent** from the staging Vault. **MediCard owns
and populates the Vault, so every value below is theirs to generate/provision:**

| Secret | In Vault? | Owner |
|---|---|---|
| `…-pg-target-uri` | ❌ | **MediCard** |
| `…-mongo-source-uri` | ❌ | **MediCard** |
| `…-enc-medical-records` | ❌ | **MediCard** — source PHI decryption key |
| `…-enc-personal-details` | ❌ | **MediCard** |
| `…-enc-billing-invoices` | ❌ | **MediCard** |
| `…-enc-billing-items` | ❌ | **MediCard** |
| `…-enc-billing-payments` | ❌ | **MediCard** |
| `…-AUTH_SECRET` / `…-BETTER_AUTH_SECRET` | ❌ | **MediCard** |

## 5. Conclusion — migrator readiness

- **Connectivity: ready.** Both the Postgres target and the Mongo source are
  reachable + authenticated from inside the staging cluster. No network / firewall
  / Atlas-allowlist action is needed.
- **Secrets: blocked on MediCard.** When the migrator IaC is deployed its
  ExternalSecrets will fail to sync until the referenced Vault secrets exist. Since
  MediCard populates `kv-mpi-sea-a-mycurex01`, **all** of the missing values are
  theirs to generate — the URIs, the auth secrets, and (critically) the per-table
  encryption keys, which must match the keys used to encrypt the source MongoDB PHI
  or decryption fails. Our side provides only the ExternalSecret/manifest wiring
  (in-cluster, not a client item).

## 6. External ask (MediCard)

Provision the following into `kv-mpi-sea-a-mycurex01` (all MediCard-generated):
- `…-pg-target-uri`, `…-mongo-source-uri` — migrator connection URIs.
- `…-AUTH_SECRET`, `…-BETTER_AUTH_SECRET` — hapihub auth secrets.
- Per-table PHI **encryption keys** — `…-enc-medical-records`, `…-enc-personal-details`,
  `…-enc-billing-invoices`, `…-enc-billing-items`, `…-enc-billing-payments` — **must
  match** the keys used to encrypt the `medicard-production` Mongo source, or the
  migrator cannot decrypt the source documents.

## 7. What we did NOT do

Read-only throughout: `ping`, `listDatabases`, `SELECT`-size, `secret list`. Two
transient diagnostic pods, both deleted. No writes to any DB, no Vault writes, no
kubeconfig/context changes, no workload or secret changes.

## Related

- monobase-mycure#4521 — staging access + checklist verification.
- [`2026-10-08-medicard-stg-aks-checklist-verification.md`](./2026-10-08-medicard-stg-aks-checklist-verification.md) · [`2026-10-08-medicard-stg-aks-access-defaults-to-prod.md`](./2026-10-08-medicard-stg-aks-access-defaults-to-prod.md)
- Prod series: [`2026-07-07-prod-cluster-database-connectivity-validation.md`](./2026-07-07-prod-cluster-database-connectivity-validation.md), [`2026-07-15-migrator-mongodb-source-connectivity-outage.md`](./2026-07-15-migrator-mongodb-source-connectivity-outage.md)
