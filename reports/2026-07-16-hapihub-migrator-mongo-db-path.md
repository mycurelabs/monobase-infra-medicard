# 2026-07-16 — hapihub-migrator failing on Mongo URI database path

**Status:** `hapihub-migrator` is in CrashLoopBackOff. The Mongo source URI in Azure Key Vault has `/admin` as its path segment; the migrator's Mongo driver uses that as the default target database, so every subsequent query lands on `admin.<collection>` — where those collections don't exist and the user credential has no privileges. Every read returns `not authorized on admin to execute command …`. Single-field fix, entirely on MediCard's side (change the KV entry's path segment). No infra change on ours.
**Environment:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia). Migrator Deployment `hapihub-migrator` in namespace `medicard`, Mongo Atlas source `mycure-stg-sh.q4trx.mongodb.net`.
**Access path:** kubectl from operator jumphost `mc.remote.prd.bastion` via `ssh medicard.gateway`.

**Scope disclaimer.** This report is a **read-only diagnostic**. Every claim is backed by a verbatim log excerpt captured during today's observation pass. Any suggested remediation is for MediCard to review and apply — we do not have write access to their Azure Key Vault and we did not touch anything on this pass. Secret values (Mongo credentials) are redacted.

---

## §1 What is observed

The migrator boots, connects to PostgreSQL cleanly, applies its embedded Drizzle migrations, initialises the PG schema, then connects to MongoDB — and every read against Mongo fails at authorisation. Verbatim from the current pod's logs (`hapihub-migrator-55945dbfb8-m2mbq`):

**Mongo connection succeeds, but the target database resolves to `admin`:**

```
{"level":30,"msg":"Connected to PostgreSQL"}
{"level":30,"migrationCount":65,"msg":"Applied embedded drizzle migrations"}
{"level":30,"msg":"PG schema initialized via drizzle migrate()"}
{"level":30,"db":"admin","msg":"Connected to MongoDB"}
```

**Every subsequent Mongo operation fails with the same shape.** Selected verbatim excerpts:

- Changelog collector initialisation:
  ```
  err: "not authorized on admin to execute command
    { createIndexes: '_migration_changelog',
      indexes: [ { unique: true, name: 'seq_1', key: { seq: 1 } } ],
      … $db: 'admin' }",
  msg: "Changelog collector failed to start"
  ```

- Phase 3 encryption-key sniff on `personal-details`:
  ```
  err: "not authorized on admin to execute command
    { find: 'personal-details',
      filter: { _eh: { $gt: '' } },
      limit: 1, singleBatch: true,
      … $db: 'admin' }",
  msg: "Encryption key verification warning — proceeding"
  ```

- Actual collection copy (`billing-invoices`, `billing-items`, `billing.invoices`, etc):
  ```
  error: "not authorized on admin to execute command
    { find: 'billing-invoices',
      filter: { $or: [ { _cd: { $lte: 1784167309461.0 } }, { _cd: { $exists: false } } ] },
      sort: { _id: 1 }, batchSize: 500,
      … $db: 'admin' }",
  msg: "Collection migration failed"
  ```

- Post-bulk verification — 85/85 collections fail the same way:
  ```
  err: "not authorized on admin to execute command
    { aggregate: 'accounts',
      pipeline: [ { $match: {} }, { $group: { _id: 1, n: { $sum: 1 } } } ],
      … $db: 'admin' }",
  msg: "Verification error"

  {"total": 85, "passed": 0, "warned": 0, "failed": 85, "msg": "Verification complete"}
  ```

Every one of these commands names `$db: "admin"`. The Mongo collections named in the queries (`personal-details`, `billing-invoices`, `accounts`, `medical-records`, …) do not live in the `admin` database; they live in the app database. The user credential in the URI has read privileges on the app database, not on `admin`, so Mongo rejects each command with its standard "not authorized" reply.

**Note on partial state**: bulk phases 1 and 2 log `"Already completed, skipping"` for every collection they touch, with real row counts (accounts: 2,856, organizations: 20,468, medical-encounters: 2,837,303, insurance-contracts: 570,198, personal-details: 5,336,046, medical-patients: 4,451,888, …). Those rows were loaded during an earlier run against a correctly-configured Mongo endpoint; that historical state persists in PG. The current run is resuming and hits the wrong-db wall on the collections that weren't already marked complete (primarily phase 3 onward).

## §2 Root cause

The KV entry `medicard-prod-mongo-source-uri` (synced into the cluster as `hapihub-secrets/MONGO_URI` via ExternalSecrets) has the shape:

```
mongodb+srv://<user>:<pass>@mycure-stg-sh.q4trx.mongodb.net/admin?appName=mycure-stg-sh
```

The path segment is **`/admin`**.

The migrator's MongoDB Node driver treats the URI's path segment as the default target database when the application calls `MongoClient.db()` without an explicit database argument. So `.db()` returns a handle bound to `admin`, and every subsequent operation carries `$db: "admin"` on the wire. That's what we see in every error line above.

The connection itself works because SCRAM authentication is a separate mechanism (the driver authenticates against whichever `authSource` the URI names, defaulting to the path segment if `authSource` is unset — which here is `admin`, so auth happens to work). But authentication succeeding on `admin` says nothing about query authorisation on `admin` — the user's role has no `find`/`aggregate`/`createIndexes` privileges there.

## §3 The ask (MediCard-side)

Update the KV entry `medicard-prod-mongo-source-uri` in `kv-mpi-sea-p-mycurex01` so that the path segment names the actual application database on Atlas, keeping SCRAM auth against `admin`:

```
mongodb+srv://<user>:<pass>@mycure-stg-sh.q4trx.mongodb.net/<APP-DB-NAME>?authSource=admin&appName=mycure-stg-sh
```

- **Path segment** (`/<APP-DB-NAME>`) — the app database where the source collections live. Based on the internal running record this is most likely `medicard-production`, but MediCard should confirm the exact name against their Atlas configuration before writing the value.
- **`authSource=admin`** — keeps SCRAM auth against the admin database, where the Atlas user credential lives (Atlas convention). This preserves the current successful auth behaviour.
- **`appName`** — cosmetic, mirror the current value.

After the KV value is updated:
- ExternalSecrets Operator picks it up on its 1-hour refresh interval (or immediately if the ES resource is annotated `force-sync=<epoch>` on our side — we can do that kick when MediCard confirms the update).
- Migrator picks up the new value on next pod restart (`kubectl delete pod` cycles the deployment).

**No change on our IaC side** — no chart edit, no PR, no image tag bump. The URI is a KV value that MediCard owns and populates; the migrator consumes it as-is.

## §4 What we did NOT do

- **No writes against Mongo.** Source of truth stays untouched. All observations here are from the migrator's own log stream on the medicard cluster.
- **No cluster edits.** No pod restarts forced, no secret patched, no ES annotated during this observation pass.
- **No changes to Azure Key Vault** on our side. MediCard owns that vault; we do not have write credentials for it and did not attempt any.
- **No forced migrator restart** to try a bulk re-run — waiting on the KV fix first so the rerun uses the correct target db.

## §5 Handover

MediCard-side action, single field in Azure Key Vault. Once the entry is updated on MediCard's side and MediCard confirms, we will:
1. Annotate `externalsecret/hapihub-secrets` in `medicard` ns with `force-sync=<epoch>` to trigger an immediate ESO fetch.
2. Delete the migrator pod so it restarts and picks up the new URI.
3. Watch the pod logs for `"db":"<APP-DB-NAME>"` in the "Connected to MongoDB" line and confirm phase 3 collection copies proceed without the "not authorized" pattern.

## References

- Prior connectivity investigation format template: [`2026-07-10-prod-cluster-kv-connectivity-revalidation-round-3.md`](./2026-07-10-prod-cluster-kv-connectivity-revalidation-round-3.md)
- Prior PG-side data investigation (duplicate accounts): [`2026-07-13-duplicate-accounts/README.md`](./2026-07-13-duplicate-accounts/README.md)
