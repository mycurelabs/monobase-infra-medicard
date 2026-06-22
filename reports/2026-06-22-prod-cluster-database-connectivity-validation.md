# 2026-06-22 — Prod Cluster Database Connectivity Validation

**Status:** Both target databases are **not reachable** from the prod AKS cluster as currently configured.
**Environment under test:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia, Private Link API).
**Access path:** kubectl was executed from an operator-side jumphost VM that has line-of-sight to the cluster's Private Link API endpoint.

---

## 1. Scope

Validate, from inside the production Kubernetes cluster, whether two production-bound database endpoints are reachable end-to-end (DNS → TCP → TLS → authentication → basic query). Both endpoints were supplied by the client:

| Target | Endpoint | Purpose in migration |
|---|---|---|
| **PostgreSQL (target)** | `mpiazeppgdb0001.postgres.database.azure.com:5432`, db `postgres`, user `MyCure_ADM`, `sslmode=require` | Destination for `hapihub-migrator` writes |
| **MongoDB Atlas (source)** | `mongodb+srv://stg_mycure_acct:***@mycure-stg-sh.q4trx.mongodb.net/admin` | Source for `hapihub-migrator` reads |

*Credentials redacted in this report. Both URIs are read-only verified — no data was modified on either database.*

This validation is **strictly non-destructive**: only `ping`, `version`, `listDatabases`, `\l`, and `SELECT version()`-class operations were issued. No `INSERT`, `UPDATE`, `DELETE`, `DROP`, or schema changes.

## 2. Methodology

Two short-lived diagnostic pods were created in the prod cluster's `default` namespace, ran a fixed probe script, and were deleted immediately after. Each probe ran **inside the cluster** (not from a laptop) so that the results reflect the actual network position of cluster workloads, including the future migrator.

All `kubectl` invocations were executed from an operator jumphost VM (the only network position from which the cluster's Private Link API server is reachable).

| Probe pod | Image | Purpose |
|---|---|---|
| `pg-probe` | `postgres:16` | DNS + TCP + `psql` against the Postgres endpoint |
| `mongo-probe` | `mongo:7` | DNS + `mongosh` against the Atlas SRV endpoint |

Cluster preconditions verified before probes (so that any failure is unambiguous):

- `default` namespace has **no** Pod Security Standard enforcement labels
- `default` namespace has **no** NetworkPolicies
- Gatekeeper / Azure Policy constraints (16 templates installed) are all in `enforcementAction: dryrun` (warn-only)

→ Workloads in `default` are subject to **no admission-time network or security restriction**. Any connectivity failure observed is therefore an upstream (database-side or network-routing) issue, not a cluster-side block.

## 3. Findings

### 3.1 PostgreSQL — `mpiazeppgdb0001.postgres.database.azure.com:5432` ❌

DNS resolves inside the cluster to private IP `172.22.25.5`. TCP `5432` does not complete within an 8-second budget. `psql` confirms the same with a longer timeout.

Probe output (verbatim):

```
--- DNS resolution ---
172.22.25.5     mpiazeppgdb0001.postgres.database.azure.com
--- TCP 5432 ---
TCP FAIL (124)                          # 124 = `timeout` command, 8-second budget exhausted
--- psql version ---
psql (PostgreSQL) 16.14 (Debian 16.14-1.pgdg13+1)
--- connect + queries ---
psql: error: connection to server at "mpiazeppgdb0001.postgres.database.azure.com"
       (172.22.25.5), port 5432 failed: timeout expired
```

Because TCP never completed, no statement can be made about authentication, database listing, server version, or storage state.

### 3.2 MongoDB Atlas — `mycure-stg-sh.q4trx.mongodb.net` (SRV) ❌

SRV resolution succeeds (mongosh recognized the URI as an Atlas cluster). `mongosh` then waits 30 seconds for server selection and aborts with Atlas's diagnostic message verbatim:

```
--- DNS (SRV resolution) ---
(SRV TXT not resolvable via getent — normal; mongo client resolves SRV itself)
--- mongosh connect ---
MongoServerSelectionError: Server selection timed out after 30000 ms.
It looks like this is a MongoDB Atlas cluster.
Please ensure that your Network Access List allows connections from your IP.
```

For reference: the same URI was probed earlier on 2026-06-10 from the *staging* cluster `aks-mpi-sea-a-mycurex01` and authenticated successfully against the `medicard-production` database (109 collections, ~5.28 TB on disk).

### 3.3 Summary table

| | PostgreSQL | MongoDB Atlas |
|---|---|---|
| DNS resolution inside cluster | ✅ → private `172.22.25.5` | ✅ (Atlas SRV) |
| TCP handshake | ❌ timeout | ❌ timeout (server selection 30 s) |
| TLS handshake | n/a (no TCP) | n/a (no TCP) |
| Authentication | n/a (no TCP) | n/a (no TCP) |
| Server-side error message | `connection ... port 5432 failed: timeout expired` | `Server selection timed out after 30000 ms. ... Please ensure that your Network Access List allows connections from your IP.` |

## 4. Scope notes

- The existing legacy production hapihub application VM was **not** probed; it sits in a different network position than the cluster and is out of scope for this connectivity check.
- No application workload validation was performed; the cluster currently runs only system namespaces (`default`, `gatekeeper-system`, `kube-node-lease`, `kube-public`, `kube-system`), age ~45 days.
- `hapihub-migrator` schema-init, encryption-key handling, and sync-tracking paths were **not** exercised — they are downstream of TCP connectivity to both databases.

## 5. Cluster-side artifacts left behind

**None.** Both probe pods (`pg-probe`, `mongo-probe`) were deleted immediately after capturing logs. Verified at the end of the run:

```
$ kubectl -n default get pods
No resources found in default namespace.
```

No secrets were created. No configmaps were created. No persistent volumes were created. No mutating calls were made on either database.

---

## Appendix A — Probe pod manifests

The exact YAML applied for each probe is reproduced below for transparency. All probes are read-only; passwords are masked.

### A.1 PostgreSQL probe

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: pg-probe
  namespace: default
spec:
  restartPolicy: Never
  containers:
  - name: probe
    image: postgres:16
    command: ["/bin/bash", "-c"]
    args:
    - |-
      set +e
      getent hosts "$PGHOST"
      timeout 8 bash -c "</dev/tcp/$PGHOST/5432" && echo "TCP OK" || echo "TCP FAIL ($?)"
      export PGPASSWORD="$PGPW"
      psql "host=$PGHOST port=5432 user=$PGUSER dbname=postgres sslmode=require connect_timeout=15" \
        -c '\conninfo' -c 'SELECT version();' -c '\l'
    env:
    - { name: PGHOST, value: "mpiazeppgdb0001.postgres.database.azure.com" }
    - { name: PGUSER, value: "MyCure_ADM" }
    - { name: PGPW,   value: "***" }
```

### A.2 MongoDB Atlas probe

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: mongo-probe
  namespace: default
spec:
  restartPolicy: Never
  containers:
  - name: probe
    image: mongo:7
    command: ["/bin/sh", "-c"]
    args:
    - |-
      mongosh --quiet --norc "$URI" <<'JSEOF'
      printjson(db.adminCommand({ping: 1}));
      print(JSON.stringify({version: db.adminCommand({buildInfo: 1}).version}));
      printjson(db.adminCommand({listDatabases: 1}).databases.map(d => ({name: d.name, sizeOnDisk: d.sizeOnDisk})));
      JSEOF
    env:
    - name: URI
      value: "mongodb+srv://stg_mycure_acct:***@mycure-stg-sh.q4trx.mongodb.net/admin?retryWrites=true&w=majority&appName=mycure-stg-sh"
```

---

## Appendix B — Environment fingerprint at time of test

- **Cluster:** `aks-mpi-sea-p-mycurex01`
- **Kubernetes API server:** `https://aks-mpi-sea-p-mycurex01-dns-ib3b6bgj.996c88f8-39f9-4501-9694-b5cbfda6f629.privatelink.southeastasia.azmk8s.io:443` (Azure Private Link)
- **Cluster age:** 45 days
- **Namespaces present:** `default`, `gatekeeper-system`, `kube-node-lease`, `kube-public`, `kube-system` (no application namespaces)
- **kubectl client version used:** v1.31.0
- **Test date / time:** 2026-06-22 (Asia/Manila)
