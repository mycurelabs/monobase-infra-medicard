# 2026-06-29 — Prod Cluster Database Connectivity Validation (round 2)

**Status:** PostgreSQL target now reachable; MongoDB Atlas source still blocked.
**Environment under test:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia, Private Link API).
**Access path:** kubectl was executed from an operator-side jumphost VM that has line-of-sight to the cluster's Private Link API endpoint.
**Relation to prior report:** Follow-up to [`2026-06-22-prod-cluster-database-connectivity-validation.md`](./2026-06-22-prod-cluster-database-connectivity-validation.md). The Postgres endpoint and user supplied today are **different** from the round-1 set; the Mongo endpoint is the **same**.

---

## 1. Scope

Validate, from inside the production Kubernetes cluster, whether two updated database endpoints are reachable end-to-end (DNS → TCP → TLS → authentication → basic query). Both endpoints were supplied by the client on 2026-06-29:

| Target | Endpoint | Change vs. 2026-06-22 |
|---|---|---|
| **PostgreSQL (target)** | `mpiazeppgdb0003.postgres.database.azure.com:5432`, db `postgres`, user `mycure_prod_app`, `sslmode=require` | **New server** (`…0003`, previously `…0001`) and **new user** (`mycure_prod_app`, previously `MyCure_ADM`). |
| **MongoDB Atlas (source)** | `mongodb+srv://stg_mycure_acct:***@mycure-stg-sh.q4trx.mongodb.net/admin?appName=mycure-stg-sh` | Same cluster, same user as 2026-06-22; query string trimmed (`retryWrites`/`w` removed). |

*Credentials redacted in this report. Both URIs are read-only verified — no data was modified on either database.*

This validation is **strictly non-destructive**: only `ping`, `version`, `listDatabases`, `\l`, `\conninfo`, and `SELECT`-class operations were issued. No `INSERT`, `UPDATE`, `DELETE`, `DROP`, or schema changes.

## 2. Methodology

Two short-lived diagnostic pods were created in the prod cluster's `default` namespace, ran a fixed probe script, and were deleted immediately after. Each probe ran **inside the cluster** (not from a laptop) so that the results reflect the actual network position of cluster workloads, including the future migrator.

All `kubectl` invocations were executed from an operator jumphost VM (the only network position from which the cluster's Private Link API server is reachable).

| Probe pod | Image | Purpose |
|---|---|---|
| `pg-probe-0003` | `postgres:16` | DNS + TCP + `psql` against the Postgres endpoint |
| `mongo-probe` | `mongo:7` | DNS + `mongosh` against the Atlas SRV endpoint |

Cluster preconditions, unchanged from the 2026-06-22 report:

- `default` namespace has **no** Pod Security Standard enforcement labels
- `default` namespace has **no** NetworkPolicies
- Gatekeeper / Azure Policy constraints are all in `enforcementAction: dryrun` (warn-only)

→ Workloads in `default` are subject to **no admission-time network or security restriction**. Any connectivity failure observed is therefore an upstream (database-side or network-routing) issue, not a cluster-side block.

## 3. Findings

### 3.1 PostgreSQL — `mpiazeppgdb0003.postgres.database.azure.com:5432` ✅

DNS resolves inside the cluster to private IP `172.22.25.6`. TCP `5432` completes; TLS 1.3 handshake succeeds; authentication as `mycure_prod_app` succeeds; the server is `PostgreSQL 17.9` and the default database is **2,264 GB**.

Probe output (verbatim):

```
--- DNS resolution ---
172.22.25.6     mpiazeppgdb0003.postgres.database.azure.com
--- TCP 5432 ---
TCP OK
--- psql version ---
psql (PostgreSQL) 16.14 (Debian 16.14-1.pgdg13+1)
--- connect + queries ---
You are connected to database "postgres" as user "mycure_prod_app" on host
"mpiazeppgdb0003.postgres.database.azure.com" (address "172.22.25.6") at port "5432".
SSL connection (protocol: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, compression: off)
                                   version
------------------------------------------------------------------------------
 PostgreSQL 17.9 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 13.2.0, 64-bit
(1 row)

  current_user   | current_database
-----------------+------------------
 mycure_prod_app | postgres
(1 row)

      datname      |  size
-------------------+---------
 postgres          | 2264 GB
 azure_sys         | 26 MB
 azure_maintenance | 7782 kB
 template1         | 7529 kB
 template0         | 7529 kB
(5 rows)
```

The `\l` output is omitted because the bundled `psql 16` client emits a benign `column d.daticulocale does not exist` error when listing databases on a PG 17 server (a known client/server version mismatch in the system catalog query that `\l` issues). The same information is shown above via the explicit `pg_database_size` query, which is forward-compatible.

### 3.2 MongoDB Atlas — `mycure-stg-sh.q4trx.mongodb.net` (SRV) ❌

SRV resolution succeeds; `mongosh` then waits 30 seconds for server selection and aborts with Atlas's diagnostic message verbatim:

```
MongoServerSelectionError: Server selection timed out after 30000 ms.
It looks like this is a MongoDB Atlas cluster.
Please ensure that your Network Access List allows connections from your IP.
```

This is the same failure mode reported on 2026-06-22. The cluster's network position relative to Atlas has not changed in the interval.

### 3.3 Summary table

| | PostgreSQL `…0003` | MongoDB Atlas |
|---|---|---|
| DNS resolution inside cluster | ✅ → private `172.22.25.6` | ✅ (Atlas SRV) |
| TCP handshake | ✅ | ❌ timeout (server selection 30 s) |
| TLS handshake | ✅ TLS 1.3 / `TLS_AES_256_GCM_SHA384` | n/a (no TCP) |
| Authentication | ✅ as `mycure_prod_app` | n/a (no TCP) |
| Basic query | ✅ `SELECT version()` → `PostgreSQL 17.9` | n/a (no TCP) |
| Server-side error message (if any) | none | `Server selection timed out after 30000 ms. ... Please ensure that your Network Access List allows connections from your IP.` |

### 3.4 Delta vs. 2026-06-22

| | 2026-06-22 | 2026-06-29 |
|---|---|---|
| PG endpoint | `mpiazeppgdb0001`, user `MyCure_ADM` | `mpiazeppgdb0003`, user `mycure_prod_app` |
| PG result | ❌ TCP timeout to private IP `172.22.25.5` (private endpoint not routable from cluster VNet) | ✅ end-to-end |
| Mongo endpoint | `mycure-stg-sh.q4trx.mongodb.net` | same |
| Mongo result | ❌ Atlas Network Access List | ❌ Atlas Network Access List (no change) |

The two PG endpoints have private endpoints in **the same `172.22.25.0/24` private subnet** (`.5` for `…0001`, `.6` for `…0003`) but the cluster can only reach `.6`. The 2026-06-22 routing/peering conclusion for `…0001` is unaffected by today's result on a different server.

## 4. Scope notes

- The previous Postgres target `mpiazeppgdb0001` was **not** re-probed today; this report covers only the two endpoints supplied for issue *Requirements validity checking* (mycurelabs/monobase-mycure#2023).
- No application workload validation was performed; the cluster still runs only system namespaces plus one unrelated transient pod (`net-test`, not owned by this validation; left in place).
- `hapihub-migrator` schema-init, encryption-key handling, and sync-tracking paths were **not** exercised — they are downstream of TCP connectivity to both databases.

## 5. Cluster-side artifacts left behind

**None.** Both probe pods (`pg-probe-0003`, `mongo-probe`) were deleted immediately after capturing logs. Verified at the end of the run:

```
$ kubectl -n default get pods
NAME       READY   STATUS    RESTARTS   AGE
net-test   1/1     Running   0          52m
```

`net-test` is a pre-existing pod not created by this validation and was not touched. No secrets, configmaps, or persistent volumes were created. No mutating calls were made on either database.

---

## Appendix A — Probe pod manifests

The exact YAML applied for each probe is reproduced below for transparency. All probes are read-only; passwords are masked.

### A.1 PostgreSQL probe

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: pg-probe-0003
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
        -c '\conninfo' \
        -c 'SELECT version();' \
        -c 'SELECT current_user, current_database();' \
        -c '\l' \
        -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size
            FROM pg_database ORDER BY pg_database_size(datname) DESC LIMIT 20;"
    env:
    - { name: PGHOST, value: "mpiazeppgdb0003.postgres.database.azure.com" }
    - { name: PGUSER, value: "mycure_prod_app" }
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
      value: "mongodb+srv://stg_mycure_acct:***@mycure-stg-sh.q4trx.mongodb.net/admin?appName=mycure-stg-sh"
```

---

## Appendix B — Environment fingerprint at time of test

- **Cluster:** `aks-mpi-sea-p-mycurex01`
- **Kubernetes API server:** `https://aks-mpi-sea-p-mycurex01-dns-ib3b6bgj.996c88f8-39f9-4501-9694-b5cbfda6f629.privatelink.southeastasia.azmk8s.io:443` (Azure Private Link)
- **Namespaces present:** `default`, `gatekeeper-system`, `kube-node-lease`, `kube-public`, `kube-system` (no application namespaces)
- **kubectl client version used:** v1.31.0
- **Test date / time:** 2026-06-29 (Asia/Manila)
- **Tracking:** issue [mycurelabs/monobase-mycure#2023](https://github.com/mycurelabs/monobase-mycure/issues/2023) — *Requirements validity checking*
