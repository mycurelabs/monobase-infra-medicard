# 2026-07-16 — hapihub-migrator Mongo source authentication failing (post `/admin` fix)

**Status:** The `/admin` path-segment bug from earlier today ([`2026-07-16-hapihub-migrator-mongo-db-path.md`](./2026-07-16-hapihub-migrator-mongo-db-path.md)) is **fixed** — the KV entry `medicard-prod-mongo-source-uri` now names `medicard-production` with `authSource=admin`. **But the password in that URI no longer authenticates.** A read-only connection test against the Atlas source returns `MongoServerError: Authentication failed`, and a proper URL parse of the URI decodes the password to just **5 characters**. The same credential fails **both** as-stored **and** after being correctly percent-encoded — so this is **not** a URI-encoding artifact; the password value itself is wrong (truncated or mistyped, most likely during the same KV edit that fixed the path). This blocks any Mongo read: a triggered migration Job would fail at auth, and the GridFS / reconcile pre-checks cannot run until it is resolved. Single-field fix, entirely on MediCard's side (the Mongo password in Azure Key Vault). No infra change on ours.
**Environment:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia). Namespace `medicard`. Mongo Atlas source `mycure-stg-sh.q4trx.mongodb.net`, database `medicard-production`, SCRAM user `stg_mycure_acct` (authSource `admin`). The migrator currently runs as a read-only **dashboard** Deployment (`hapihub-migrator-dashboard`, PG-only) plus a **suspended** migration CronJob (`hapihub-migrator`); nothing is actively hitting Mongo, so this fails silently until a run is triggered.
**Access path:** kubectl from operator jumphost `mc.remote.prd.bastion` via `ssh medicard.gateway`.

**Scope disclaimer.** This report is a **read-only diagnostic**. No writes were made to Mongo, PostgreSQL, or Azure Key Vault. The one cluster action taken was a short-lived, read-only check Job (`kubectl apply` → read logs → auto-deleted via TTL; the exact manifest is reproduced in §4). Secret values are redacted; the username `stg_mycure_acct` is shown only because it is the identifier MediCard needs to locate the Atlas user, and only the *length* of the password is ever surfaced — never the value.

---

## §1 What is observed

The dashboard pod is healthy (it only talks to PostgreSQL). To exercise the Mongo path we ran a read-only check **from inside the cluster** — the only place whose egress IP is on the Atlas Network Access List (a laptop is not) — reading the URI straight from the live secret `hapihub-migration-secrets/mongo-source-uri`. Verbatim job output (`mongo-auth-check-cphnc`, `Completed`):

```
uri_shape: mongodb+srv://REDACTED@mycure-stg-sh.q4trx.mongodb.net/medicard-production?authSource=admin&appName=mycure-stg-sh
parsed: host=mycure-stg-sh.q4trx.mongodb.net user=stg_mycure_acct decodedPassLen=5
A1_raw_uri: ERROR Authentication failed.
A2_reencoded: ERROR Authentication failed.
```

Reading each line:

- **`uri_shape`** — the `/admin` fix landed: the path is now `medicard-production` and `authSource=admin` is present. This is exactly the shape requested in the prior report.
- **`decodedPassLen=5`** — the password, extracted with the WHATWG URL parser (which correctly applies the "last `@` is the userinfo delimiter" rule and percent-decodes) is **5 characters**. A real Atlas password is not 5 characters. The host parsed cleanly (`mycure-stg-sh.q4trx.mongodb.net`), which also rules out a stray `/` or `?` in the password shifting the authority boundary.
- **`A1_raw_uri: Authentication failed`** — connecting with the URI exactly as stored (what the migrator does) is rejected by SCRAM. This is an authentication rejection (bad username/password), not the authorization error (`not authorized on admin …`) from the previous `/admin` issue, and not a parse/network error — the connection reached Atlas and auth was refused.
- **`A2_reencoded: Authentication failed`** — we then rebuilt the URI with the parsed username/password **correctly percent-encoded** and tried again. It **also** fails. This is the key diagnostic: if the only problem were an unencoded special character in the password, the re-encoded form would have succeeded. It did not, so the password *value* is wrong.

**The migrator would fail identically.** `mongosh` is built on the same MongoDB Node driver the migrator uses and consumes the URI the same way; `A1_raw_uri` is precisely the migrator's connect path. A migration Job started today would fail at the Mongo connect step.

For contrast, the earlier `/admin` run logged `"db":"admin","msg":"Connected to MongoDB"` — auth **succeeded** then (only authorization failed). Auth **fails** now. The password changed between the two KV edits and is no longer valid.

## §2 Root cause

The KV edit that corrected the database path also left the **password portion of the URI invalid**. The evidence narrows it to a wrong password value, not a formatting issue:

- The password decodes (via a correct URL parser) to **5 characters** — far too short for an Atlas SCRAM password (the prior working value was 13).
- Re-encoding the parsed credential and retrying (`A2_reencoded`) **still fails**, which eliminates the "unencoded special character mis-split a longer password" hypothesis.
- Auth is *rejected* (not *unauthorized*), so the server received a username/password pair and refused it.

Most likely the password was **truncated or mistyped** during the KV edit (e.g. a paste that stopped at a special character, or a partial copy). Less likely but possible: the Atlas password was **rotated** and KV holds the old/partial value, or the wrong user's password was pasted.

## §3 The ask (MediCard-side)

Correct the password inside `medicard-prod-mongo-source-uri` in `kv-mpi-sea-p-mycurex01`. Keep the path + `authSource` exactly as they already are — only the password is wrong.

1. In Atlas → Database Access, confirm the SCRAM user `stg_mycure_acct` and set/copy its **full** current password. (The value currently in KV parses to 5 characters — it is not the full password.)
2. **Percent-encode any special character** in the password before placing it in the URI (this is not the current failure, but it prevents the *next* one). Reference:

   | Char | Encoded | Char | Encoded | Char | Encoded |
   |------|---------|------|---------|------|---------|
   | `@`  | `%40`   | `/`  | `%2F`   | `:`  | `%3A`   |
   | `?`  | `%3F`   | `#`  | `%23`   | `%`  | `%25`   |
   | `&`  | `%26`   | `[`  | `%5B`   | `]`  | `%5D`   |

   Final shape:
   ```
   mongodb+srv://stg_mycure_acct:<FULL-PERCENT-ENCODED-PASS>@mycure-stg-sh.q4trx.mongodb.net/medicard-production?authSource=admin&appName=mycure-stg-sh
   ```
3. Sanity-check that the Atlas **Network Access List** still allows the AKS egress IP (the earlier run connected, so this should be unchanged).

After KV is updated: ExternalSecrets picks it up on its 1-hour refresh, or we annotate `externalsecret/hapihub-migration-secrets` with `force-sync=<epoch>` for an immediate fetch on MediCard's confirmation. **No IaC change on our side.**

## §4 Verification methodology (client-runnable)

Two independent ways to verify. **Method A** is quickest if you have an Atlas-allowlisted host; **Method B** is exactly what we ran from inside the cluster (no allowlist change needed) and is what produced the §1 evidence.

Success criterion for both: a `ping` returns `{ ok: 1 }`. Anything else (`Authentication failed`, timeout) = not yet fixed.

### Method A — direct `mongosh` (from any Atlas-allowlisted machine)

```bash
# A1 — full URI, exactly as it will be stored (this is the migrator's path):
mongosh "mongodb+srv://stg_mycure_acct:<PASS-AS-IN-URI>@mycure-stg-sh.q4trx.mongodb.net/medicard-production?authSource=admin" \
  --quiet --eval 'db.runCommand({ ping: 1 })'

# A2 — same credential, password passed as an explicit FIELD (bypasses URI parsing):
mongosh "mongodb+srv://mycure-stg-sh.q4trx.mongodb.net/medicard-production" \
  --authenticationDatabase admin --username 'stg_mycure_acct' --password '<RAW-PASS>' \
  --quiet --eval 'db.runCommand({ ping: 1 })'
```

Interpretation: **both succeed** → fixed. **A2 succeeds, A1 fails** → the password is right but needs percent-encoding in the URI (§3.2). **Both fail** → the password value is still wrong (this is today's state).

### Method B — in-cluster read-only check Job (no allowlist change; what we ran)

This is the exact Job that produced the §1 output. It is PodSecurity-`restricted`-compliant, labelled so the migrator NetworkPolicy permits Atlas egress, and **reads the credential from the secret so nothing is ever typed or logged** — it prints only the redacted URI shape, the password *length*, and the two connection results. It auto-deletes via `ttlSecondsAfterFinished`. Save as `mongo-auth-check.yaml`, then `kubectl -n medicard apply -f mongo-auth-check.yaml` and read `kubectl -n medicard logs job/mongo-auth-check`.

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
        image: docker.io/bitnamilegacy/mongodb:7.0   # allowed by the restrict-registries policy; ships mongosh
        securityContext:
          allowPrivilegeEscalation: false
          runAsNonRoot: true
          runAsUser: 1001
          capabilities: { drop: ["ALL"] }
        env:
        - name: MONGO_URI
          valueFrom: { secretKeyRef: { name: hapihub-migration-secrets, key: mongo-source-uri } }
        command: ["mongosh"]
        args:
        - "--nodb"
        - "--quiet"
        - "--eval"
        - |
          try {
            const uri = process.env.MONGO_URI;
            print("uri_shape: " + uri.replace(/:\/\/[^@]+@/, "://REDACTED@"));
            const u = new URL(uri);
            const user = decodeURIComponent(u.username);
            const pass = decodeURIComponent(u.password);
            print("parsed: host=" + u.host + " user=" + user + " decodedPassLen=" + pass.length);
            function tryConn(label, connStr) {
              try { const m = new Mongo(connStr); print(label + ": " + JSON.stringify(m.getDB("medicard-production").runCommand({ ping: 1 }))); }
              catch (e) { print(label + ": ERROR " + e.message); }
            }
            tryConn("A1_raw_uri", uri);
            const rebuilt = "mongodb+srv://" + encodeURIComponent(user) + ":" + encodeURIComponent(pass) + "@" + u.host + "/medicard-production?authSource=admin";
            tryConn("A2_reencoded", rebuilt);
          } catch (e) { print("FATAL " + e.message); }
```

Expected once the password is corrected:
```
parsed: host=mycure-stg-sh.q4trx.mongodb.net user=stg_mycure_acct decodedPassLen=<real length>
A1_raw_uri: {"ok":1}
A2_reencoded: {"ok":1}
```
It currently prints (verbatim, this pass):
```
parsed: host=mycure-stg-sh.q4trx.mongodb.net user=stg_mycure_acct decodedPassLen=5
A1_raw_uri: ERROR Authentication failed.
A2_reencoded: ERROR Authentication failed.
```

### After auth is green — the GridFS question this was blocking

Once `A1_raw_uri` returns `{ ok: 1 }`, swap the `--eval` for the following to answer the still-open GridFS question (does the source keep file *bytes* in Mongo GridFS, which would require the storage→S3 migration to be configured):

```javascript
const m = new Mongo(process.env.MONGO_URI);
const d = m.getDB("medicard-production");
print("storage.files by storageType: " + JSON.stringify(
  d.getCollection("storage.files").aggregate([{ $group: { _id: "$storageType", n: { $sum: 1 } } }]).toArray()));
["files","fs"].forEach(function(b){ try {
  var f = d.getCollection(b+".files").estimatedDocumentCount(), c = d.getCollection(b+".chunks").estimatedDocumentCount();
  if (f || c) print(b+".files="+f+"  "+b+".chunks="+c);
} catch (e) {} });
```
Any `storageType: "gfs"` rows or non-zero `*.chunks` ⇒ GridFS is in use and storage migration must be enabled; otherwise `storage.files` is metadata-only and no GridFS work is needed.

## §5 What we did NOT do

- **No writes against Mongo.** Only `ping` (via a `runCommand`) — no reads of application data, no writes.
- **No changes to Azure Key Vault.** MediCard owns that vault; we have no write credentials and attempted none.
- **No credential exposure.** The password was never printed — the check reads it from the secret via `secretKeyRef` and surfaces only its length and the connection result.
- **No migration triggered.** The CronJob stays suspended; we did not create a migration Job.
- **No forced ESO/pod restart** — waiting on the KV password fix first.

## §6 Handover

MediCard-side action, single field (the password) in Azure Key Vault. Once updated and confirmed:
1. We annotate `externalsecret/hapihub-migration-secrets` in `medicard` with `force-sync=<epoch>` for an immediate ESO fetch.
2. We re-run the Method-B check Job and confirm `A1_raw_uri: {"ok":1}`.
3. We then run the GridFS storageType check (§4) and report whether storage migration is required — clearing the last unknown before a migration run.

## References

- Immediate predecessor (the `/admin` path fix that landed): [`2026-07-16-hapihub-migrator-mongo-db-path.md`](./2026-07-16-hapihub-migrator-mongo-db-path.md)
- First occurrence of source-side connectivity trouble: [`2026-07-15-migrator-mongodb-source-connectivity-outage.md`](./2026-07-15-migrator-mongodb-source-connectivity-outage.md)
- Prod state + pre-migrator backup ask: [`2026-07-13-prod-state-and-pre-migrator-backup-ask.md`](./2026-07-13-prod-state-and-pre-migrator-backup-ask.md)
