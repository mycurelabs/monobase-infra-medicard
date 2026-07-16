# 2026-07-16 — hapihub-migrator Mongo source authentication failing (post `/admin` fix)

**Status:** The `/admin` path-segment bug from earlier today ([`2026-07-16-hapihub-migrator-mongo-db-path.md`](./2026-07-16-hapihub-migrator-mongo-db-path.md)) is **fixed** — the KV entry `medicard-prod-mongo-source-uri` now names `medicard-production` with `authSource=admin`. **But the credential in that URI no longer authenticates.** A read-only connection test against the Atlas source returns `MongoServerError: Authentication failed`, and the password parsed out of the URI is only ~4–5 characters — strongly consistent with either a truncated/incorrect password or an **unencoded special character** in the password that the connection-string parser splits on. This blocks any Mongo read: a triggered migration Job would fail at auth, and the GridFS/reconcile pre-checks cannot run until it is resolved. Single-field fix, entirely on MediCard's side (the Mongo credential in Azure Key Vault). No infra change on ours.
**Environment:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia). Namespace `medicard`. Mongo Atlas source `mycure-stg-sh.q4trx.mongodb.net`, database `medicard-production`, SCRAM user `stg_mycure_acct` (authSource `admin`). The migrator now runs as a read-only **dashboard** Deployment (`hapihub-migrator-dashboard`, PG-only) plus a **suspended** migration CronJob (`hapihub-migrator`); nothing is actively hammering Mongo, so this fails silently until a run is triggered.
**Access path:** kubectl from operator jumphost `mc.remote.prd.bastion` via `ssh medicard.gateway`.

**Scope disclaimer.** This report is a **read-only diagnostic**. No writes were made to Mongo, PostgreSQL, or Azure Key Vault. The one cluster action taken was a short-lived, read-only check Job (`kubectl apply` → read logs → deleted; manifest reproduced in §4). Secret values (Mongo credentials) are redacted throughout; the username `stg_mycure_acct` is shown only because it is the identifier MediCard needs to locate the Atlas user.

---

## §1 What is observed

The dashboard pod is healthy (it only talks to PostgreSQL). To exercise the Mongo path we ran a read-only connection test from inside the cluster (the only place whose egress IP is on the Atlas Network Access List — a laptop is not), reading the URI straight from the live secret `hapihub-migration-secrets/mongo-source-uri`.

**1a — the URI is now correctly formed** (path fixed, `authSource` present). Printed with the credentials redacted:

```
mongodb+srv://REDACTED@mycure-stg-sh.q4trx.mongodb.net/medicard-production?authSource=admin&appName=mycure-stg-sh
```

This is exactly the shape requested in the prior report — the `/admin` → `/medicard-production` change landed.

**1b — authentication is rejected.** Connecting with `mongosh` (same connection-string parser the migrator's Node driver uses) against `medicard-production` with `authSource=admin`:

```
host=mycure-stg-sh.q4trx.mongodb.net  user=stg_mycure_acct  passlen=5
MongoServerError: Authentication failed.
```

- `Authentication failed` is a **SCRAM rejection** — the server received a username/password and refused it. (It is not a "not authorized" authorization error like the previous `/admin` issue, and not a `MongoParseError`/network error — the connection reached Atlas and attempted auth.)
- `passlen=5` is the length of the password as extracted from the URI (greedy match: everything between `user:` and the **last** `@` before the host). A real Atlas password is not 4–5 characters. Two readings, both point at the credential:
  1. the password stored in KV is **truncated/incorrect**, or
  2. the password contains a **special character that is not percent-encoded**, so the RFC-3986 userinfo parser (in `mongosh`, the Node driver, and our extraction alike) cuts it at that character.

**1c — the migrator would fail identically.** `mongosh` is built on the same MongoDB Node driver the migrator uses, and both consume the URI verbatim. A `mongosh "<full-uri>"` attempt (no field extraction — exactly what the migrator does) failed with the same `Authentication failed`. So this is not a `mongosh`-only artifact: a migration Job started today would fail at the Mongo connect step.

For context, the earlier `/admin` run's log showed `"db":"admin","msg":"Connected to MongoDB"` — i.e. auth **succeeded** then. It fails **now**. Something about the credential changed between the two KV updates.

## §2 Root cause

The KV entry `medicard-prod-mongo-source-uri` was updated to fix the database path (good), but the **password portion of the URI no longer produces a valid SCRAM credential**. The most likely mechanisms, in order of probability:

1. **Unencoded special character in the password.** MongoDB connection strings are URIs: any of `@ : / ? # [ ] %` in a password **must be percent-encoded**, or the parser mis-splits the userinfo. A password like `xxxx@yyyy` in `mongodb+srv://user:xxxx@yyyy@host/...` is ambiguous — the parser can take the wrong `@` as the userinfo delimiter and send only `xxxx` as the password → auth fails. A 4–5 character parsed password is the classic signature of exactly this.
2. **Truncated or mistyped password** during the KV edit (e.g. a copy that stopped at a special character).
3. **Rotated Atlas password** not reflected in KV, or a user/password mismatch.

We cannot distinguish (1) from (2)/(3) without seeing the secret value, which we deliberately did not print. MediCard can distinguish them trivially with the field-vs-URI test in §4.

## §3 The ask (MediCard-side)

Re-verify and, if needed, re-write the password inside `medicard-prod-mongo-source-uri` in `kv-mpi-sea-p-mycurex01`:

1. Confirm the Atlas SCRAM user `stg_mycure_acct` and its current password (Atlas → Database Access), against database `medicard-production`, authSource `admin`.
2. **Percent-encode every special character in the password** before placing it in the URI. Reference:

   | Char | Encoded | Char | Encoded | Char | Encoded |
   |------|---------|------|---------|------|---------|
   | `@`  | `%40`   | `/`  | `%2F`   | `:`  | `%3A`   |
   | `?`  | `%3F`   | `#`  | `%23`   | `[`  | `%5B`   |
   | `]`  | `%5D`   | `%`  | `%25`   | `&`  | `%26`   |

   Final shape (keep path + `authSource` as they already are):
   ```
   mongodb+srv://stg_mycure_acct:<PERCENT-ENCODED-PASS>@mycure-stg-sh.q4trx.mongodb.net/medicard-production?authSource=admin&appName=mycure-stg-sh
   ```
3. Confirm the Atlas **Network Access List** still allows the AKS egress IP (it must — the earlier run connected; this is just a sanity check).

Once KV is updated: ExternalSecrets picks it up on its 1-hour refresh, or we annotate `externalsecret/hapihub-migration-secrets` with `force-sync=<epoch>` for an immediate fetch on MediCard's confirmation. **No IaC change on our side** — the URI is a KV value MediCard owns.

## §4 Verification methodology (client-runnable)

Two independent ways to verify the credential. **Method A** is the quickest if you have an Atlas-allowlisted host; **Method B** is what we run from inside the cluster (no allowlist change needed) and is fully reproducible.

Success criterion for both: `db.runCommand({ ping: 1 })` returns `{ ok: 1 }`. Anything else (`Authentication failed`, timeout) means not-yet-fixed.

### Method A — direct `mongosh` (from any Atlas-allowlisted machine)

Rules out vs. confirms the "unencoded special character" theory in one comparison.

```bash
# A1 — full URI, exactly as stored (this is what the migrator does):
mongosh "mongodb+srv://stg_mycure_acct:<PASS-AS-IN-URI>@mycure-stg-sh.q4trx.mongodb.net/medicard-production?authSource=admin" \
  --quiet --eval 'db.runCommand({ ping: 1 })'

# A2 — same credential, password passed as an explicit FIELD (bypasses URI parsing):
mongosh "mongodb+srv://mycure-stg-sh.q4trx.mongodb.net/medicard-production" \
  --authenticationDatabase admin \
  --username 'stg_mycure_acct' --password '<RAW-PASS>' \
  --quiet --eval 'db.runCommand({ ping: 1 })'
```

Interpretation:
- **A2 succeeds, A1 fails** → the password is correct but **not percent-encoded** in the URI. Fix = encode it (§3.2). This is the expected outcome given `passlen=5`.
- **Both fail** → the password itself is wrong/rotated. Fix = correct it in Atlas + KV.
- **Both succeed** → credential is fine; re-run the ESO sync + re-test in-cluster (Method B) in case the in-cluster secret is stale.

### Method B — in-cluster read-only check Job (no allowlist change)

This is the exact, minimal Job we ran (PodSecurity-`restricted`-compliant, labelled so the migrator NetworkPolicy permits Atlas egress, secret-mounted so **no credential is ever typed or logged**, auto-deletes via TTL). It only issues a `ping` + read-only `listCollections`/counts. Save as `mongo-auth-check.yaml` and `kubectl -n medicard apply -f` it, then read `kubectl -n medicard logs job/mongo-auth-check`.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: mongo-auth-check
  namespace: medicard
  labels: { app.kubernetes.io/name: hapihub-migrator, app.kubernetes.io/instance: hapihub-migrator }
spec:
  ttlSecondsAfterFinished: 300
  backoffLimit: 0
  template:
    metadata:
      labels: { app.kubernetes.io/name: hapihub-migrator, app.kubernetes.io/instance: hapihub-migrator }
    spec:
      restartPolicy: Never
      securityContext: { runAsNonRoot: true, runAsUser: 1001, fsGroup: 1001, seccompProfile: { type: RuntimeDefault } }
      containers:
      - name: check
        image: docker.io/bitnamilegacy/mongodb:7.0   # allowed by the restrict-registries policy
        securityContext:
          allowPrivilegeEscalation: false
          runAsNonRoot: true
          runAsUser: 1001
          capabilities: { drop: ["ALL"] }
        env:
        - name: MONGO_URI
          valueFrom: { secretKeyRef: { name: hapihub-migration-secrets, key: mongo-source-uri } }
        command: ["sh","-c"]
        args:
        - |
          # Never echo the URI/credential.
          mongosh "$MONGO_URI" --quiet --eval '
            print("ping: " + JSON.stringify(db.getSiblingDB("medicard-production").runCommand({ ping: 1 })));
          '
```

Expected on success:
```
ping: {"ok":1}
```
Currently it prints `MongoServerError: Authentication failed`.

### After auth is green — the GridFS question this was blocking

Once `ping` returns `ok:1`, the same Job template answers the still-open GridFS question (does the source keep file bytes in Mongo GridFS, which would need the storage→S3 migration) by swapping the `--eval` for:
```javascript
const d = db.getSiblingDB("medicard-production");
print("storage.files by storageType: " + JSON.stringify(
  d.getCollection("storage.files").aggregate([{ $group: { _id: "$storageType", n: { $sum: 1 } } }]).toArray()));
["files","fs"].forEach(function(b){ try {
  var f=d.getCollection(b+".files").estimatedDocumentCount(), c=d.getCollection(b+".chunks").estimatedDocumentCount();
  if (f||c) print(b+".files="+f+"  "+b+".chunks="+c);
} catch(e){} });
```
Any `storageType: "gfs"` rows or non-zero `*.chunks` ⇒ GridFS is in use and storage migration must be configured; otherwise `storage.files` is metadata-only and no GridFS work is needed.

## §5 What we did NOT do

- **No writes against Mongo.** Source of truth untouched — only `ping`, `listCollections`, and count/aggregate reads.
- **No changes to Azure Key Vault.** MediCard owns that vault; we have no write credentials and attempted none.
- **No credential exposure.** The password was never printed; the check Job reads it from the secret via `secretKeyRef` and never echoes it.
- **No migration triggered.** The CronJob stays suspended; we did not create a migration Job.
- **No forced ESO/pod restart** — waiting on the KV credential fix first.

## §6 Handover

MediCard-side action, single field (the password) in Azure Key Vault. Once updated and confirmed:
1. We annotate `externalsecret/hapihub-migration-secrets` in `medicard` with `force-sync=<epoch>` for an immediate ESO fetch.
2. We re-run the Method-B check Job and confirm `ping: {"ok":1}`.
3. We then run the GridFS storageType check (§4) and report whether storage migration is required, clearing the last unknown before a migration run.

## References

- Immediate predecessor (the `/admin` path fix that landed): [`2026-07-16-hapihub-migrator-mongo-db-path.md`](./2026-07-16-hapihub-migrator-mongo-db-path.md)
- First occurrence of source-side connectivity trouble: [`2026-07-15-migrator-mongodb-source-connectivity-outage.md`](./2026-07-15-migrator-mongodb-source-connectivity-outage.md)
- Prod state + pre-migrator backup ask: [`2026-07-13-prod-state-and-pre-migrator-backup-ask.md`](./2026-07-13-prod-state-and-pre-migrator-backup-ask.md)
