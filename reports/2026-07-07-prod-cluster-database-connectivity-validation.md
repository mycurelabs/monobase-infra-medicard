# 2026-07-07 — Prod Cluster Database Connectivity Validation (round 3)

**Status:** Both endpoints reachable end-to-end from the prod cluster.
**Environment under test:** Production AKS cluster `aks-mpi-sea-p-mycurex01` (Azure, southeastasia, Private Link API).
**Access path:** kubectl was executed from an operator-side jumphost VM that has line-of-sight to the cluster's Private Link API endpoint.
**Relation to prior reports:** Follow-up to [`2026-06-29-prod-cluster-database-connectivity-validation.md`](./2026-06-29-prod-cluster-database-connectivity-validation.md) (round 2) and [`2026-06-22-prod-cluster-database-connectivity-validation.md`](./2026-06-22-prod-cluster-database-connectivity-validation.md) (round 1). Same PostgreSQL server and user as round 2. Same MongoDB endpoint as rounds 1 and 2.

---

## 1. Scope

Re-validate, from inside the production Kubernetes cluster, that both database endpoints supplied by the client are reachable end-to-end (DNS → TCP → TLS → authentication → basic query):

| Target | Endpoint |
|---|---|
| **PostgreSQL (target)** | `mpiazeppgdb0003.postgres.database.azure.com:5432`, db `postgres`, user `mycure_prod_app`, `sslmode=require` |
| **MongoDB Atlas (source)** | `mongodb+srv://stg_mycure_acct:***@mycure-stg-sh.q4trx.mongodb.net/admin?appName=mycure-stg-sh` |

*Credentials redacted in this report. Both URIs are read-only verified — no data was modified on either database.*

This validation is **strictly non-destructive**: only `ping`, `version`, `listDatabases`, `\conninfo`, and `SELECT`-class operations were issued. No `INSERT`, `UPDATE`, `DELETE`, `DROP`, or schema changes.

## 2. Methodology

Two short-lived diagnostic pods were created in the prod cluster's `default` namespace, ran a fixed probe script, and were deleted immediately after. Each probe ran **inside the cluster** (not from a laptop) so that the results reflect the actual network position of cluster workloads, including the future migrator.

All `kubectl` invocations were executed from an operator jumphost VM (the only network position from which the cluster's Private Link API server is reachable).

| Probe pod | Image | Purpose |
|---|---|---|
| `pg-probe` | `postgres:16` | DNS + TCP + `psql` against the Postgres endpoint |
| `mongo-probe` | `mongo:7` | DNS + `mongosh` against the Atlas SRV endpoint |

## 3. Findings

### 3.1 PostgreSQL — `mpiazeppgdb0003.postgres.database.azure.com:5432` ✅

DNS resolves inside the cluster to private IP `172.22.25.6`. TCP `5432` completes; TLS 1.3 handshake succeeds; authentication as `mycure_prod_app` succeeds; the server is `PostgreSQL 17.9` and the default database is **2,264 GB**.

Probe output (verbatim, whitespace preserved):

```
172.22.25.6     mpiazeppgdb0003.postgres.database.azure.com
TCP OK
You are connected to database "postgres" as user "mycure_prod_app" on host "mpiazeppgdb0003.postgres.database.azure.com" (address "172.22.25.6") at port "5432".
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

### 3.2 MongoDB Atlas — `mycure-stg-sh.q4trx.mongodb.net` (SRV) ✅

SRV resolution succeeds, TCP and TLS complete, `ping` returns `{ ok: 1 }`, and `listDatabases` returns one visible database (`medicard-production`, ~5.286 TB on disk). The `stg_mycure_acct` user is scoped so `admin` / `config` / `__mdb_internal_atlas` are not listed — this is a permission-level filter on the Atlas side, not a defect.

Probe output (verbatim):

```
{
  ok: 1,
  '$clusterTime': {
    clusterTime: Timestamp({ t: 1783390568, i: 3 }),
    signature: {
      hash: Binary.createFromBase64('CUP+PpEOHPUmfgOxl8Ti0zhwg+M=', 0),
      keyId: Long('7598203557904384005')
    }
  },
  operationTime: Timestamp({ t: 1783390568, i: 3 })
}
{"version":"7.0.37"}
[
  {
    name: 'medicard-production',
    sizeOnDisk: Long('5285653291008')
  }
]
```

### 3.3 Summary table

| | PostgreSQL | MongoDB Atlas |
|---|---|---|
| DNS resolution inside cluster | ✅ → private `172.22.25.6` | ✅ (Atlas SRV) |
| TCP handshake | ✅ | ✅ |
| TLS handshake | ✅ TLS 1.3 / `TLS_AES_256_GCM_SHA384` | ✅ |
| Authentication | ✅ as `mycure_prod_app` | ✅ as `stg_mycure_acct` |
| Basic query | ✅ `SELECT version()` → `PostgreSQL 17.9` | ✅ `ping` → `{ ok: 1 }`, `listDatabases` |
| Server version | PostgreSQL 17.9 | MongoDB 7.0.37 (Atlas mongos) |
| Data size seen | `postgres` = 2,264 GB | `medicard-production` = 5,285,653,291,008 B (~5.286 TB) |

### 3.4 Delta vs. 2026-06-29

| | 2026-06-29 | 2026-07-07 |
|---|---|---|
| PG endpoint | `mpiazeppgdb0003` / `mycure_prod_app` | same |
| PG result | ✅ end-to-end (PG 17.9, 2,264 GB) | ✅ end-to-end (PG 17.9, 2,264 GB) — **no change in reported size** |
| Mongo endpoint | `mycure-stg-sh` / `stg_mycure_acct` | same |
| Mongo result | ❌ 30 s server-selection timeout (Atlas allowlist missing prod egress IP) | ✅ end-to-end (Mongo 7.0.37, `medicard-production` ~5.286 TB) |
| Mongo server version | n/a (no TCP) | 7.0.37 (was 7.0.35 on 2026-06-10 staging probe — Atlas minor upgrade) |

The observable change between round 2 and today is on the MongoDB side only: the Atlas Network Access List now admits the prod cluster's egress IP.

## 4. Scope notes

- The previous Postgres target `mpiazeppgdb0001` (round 1) was **not** re-probed today; it has been superseded by `…0003`.
- `hapihub-migrator` schema-init, encryption-key handling, and sync-tracking paths were **not** exercised — they are downstream of TCP connectivity to both databases.
- No application workloads were probed; the cluster still runs only system namespaces (`default`, `gatekeeper-system`, `kube-node-lease`, `kube-public`, `kube-system`).

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
        -c '\conninfo' \
        -c 'SELECT version();' \
        -c 'SELECT current_user, current_database();' \
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
- **Test date / time:** 2026-07-07 (Asia/Manila)
