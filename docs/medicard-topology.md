# MediCard Topology — Legacy vs. K8s (prod + staging)

Scope: only MediCard-owned components. Everything we don't run — we reach it
through its provided interface (API / connection string / S3 endpoint) — is drawn
as a **blackbox** (`([ ... ])`, dashed). We don't model their internals.

Sources: `values/deployments/medicard.yaml` (prod, `main`) and the same file on
the `staging` branch.

Legend:
- Solid box = we run/operate it.
- `([blackbox])` dashed = external, accessed only via its connection method.
- Edge labels = the actual protocol/port/URI used.

---

## 1. Legacy — Production

Reached for ops via the `medicard.gateway` jump host (VPN). Real client traffic
enters through Azure's App Gateway + WAF, which forwards straight to hapihub
`:7500` (bypasses local nginx). hapihub runs the **MediCard CPS integration
plugin** (`apid-plugin-medicard-cps`), which submits claims/billing to MediCard's
CPS API.

```mermaid
flowchart TB
    clients([Clients / browsers])
    appgw([Azure App Gateway v2 + WAF<br/>PIP 20.212.27.66])

    subgraph OPS[Ops access]
        gw[medicard.gateway<br/>SSH jump host]
    end

    subgraph CLOUD[Azure VNet — cloud prod]
        api["mc.remote.prd.api (172.26.255.4)<br/>hapihub fleet :7500 · hl7d · syncctl · nginx"]
        web["mc.remote.prd.web (172.26.255.132)<br/>web server"]
        io["mycure-io.medicardphils.com<br/>syncd (sync server)"]
    end

    subgraph ONPREM[On-prem — Festival LAN]
        festival["mc.onprem.festival (10.10.72.50)<br/>hapihub :7500 · syncd :7801 · mongo :27017"]
        cebu["mc.onprem.cebu (10.10.49.171)<br/>medicard-production mongo (~1TB, PII)"]
    end

    atlas([MongoDB Atlas<br/>mycure.q4trx.mongodb.net<br/>db medicard-production])
    cps([MediCard CPS API<br/>medicardapi02-app.medicardphils.com<br/>claims / billing submission])

    clients -->|HTTPS| appgw
    appgw -->|"HTTP :7500"| api
    api -->|mongodb+srv| atlas
    api -->|"HTTPS claims (basic auth)"| cps
    festival -->|syncd :7801 sync| io
    cebu -->|LAN| festival
    io -->|sync| api

    gw -.SSH.-> api
    gw -.SSH.-> web
    gw -.SSH.-> festival
    gw -.SSH.-> cebu

    classDef bb fill:#f5f5f5,stroke:#999,stroke-dasharray:5 4,color:#333;
    class clients,appgw,atlas,cps bb;
```

---

## 2. Legacy — Staging

Same jump-host access pattern; two dedicated staging VMs. DB backing follows the
prod pattern — a MongoDB Atlas staging database — and hapihub runs the same
MediCard CPS integration plugin against MediCard's CPS staging API.

```mermaid
flowchart TB
    clients([Clients / browsers])

    subgraph OPS[Ops access]
        gw[medicard.gateway<br/>SSH jump host]
    end

    subgraph STG[Azure VNet — staging 172.23.4.0/24]
        stgapi["mc.remote.stg.api (172.23.4.7)<br/>hapihub / api server"]
        stgweb["mc.remote.stg.web (172.23.4.8)<br/>web server (SEA-VM-STG-MYCURE-WEB)"]
    end

    atlas([MongoDB Atlas — staging DB])
    cps([MediCard CPS API — staging<br/>claims / billing submission])

    clients -->|HTTPS| stgweb
    clients -->|HTTPS| stgapi
    stgapi -->|mongodb+srv| atlas
    stgapi -->|"HTTPS claims (basic auth)"| cps

    gw -.SSH.-> stgapi
    gw -.SSH.-> stgweb

    classDef bb fill:#f5f5f5,stroke:#999,stroke-dasharray:5 4,color:#333;
    class clients,atlas,cps bb;
```

---

## 3. K8s — Production

Azure AKS `aks-mpi-sea-p-mycurex01` (southeastasia, **private link** — API server
only reachable in-VNet, hence the bastion). GitOps via ArgoCD app-of-apps tracking
`main`. hapihub is **PostgreSQL-only** (external Azure PG); object storage is
s3proxy translating S3→Azure Blob. Mongo appears only as the migrator's source.

```mermaid
flowchart TB
    clients([Clients / browsers])
    edge([Azure App Gateway<br/>terminates TLS])
    ghcr([GHCR<br/>ghcr.io/mycurelabs/*])
    repo([GitHub<br/>monobase-infra-medicard.git @ main])

    subgraph AKS["AKS aks-mpi-sea-p-mycurex01 · ns: medicard"]
        argo[ArgoCD<br/>app-of-apps]
        eso[External Secrets Operator]
        envoy[Envoy Gateway<br/>shared-gateway]

        hapihub["hapihub 11.20.87 x2<br/>:7500 · api-mycurex"]
        mycure["mycureapp 10.25.110 x2<br/>cms-mycurex"]
        s3proxy["s3proxy x2<br/>:9000 · storage-mycurex"]
        valkey["valkey (standalone)<br/>:6379 cache"]
        migrator["hapihub-migrator 3.12.8<br/>dashboard + suspended Job"]
        cadence["cadence 0.9.23<br/>(DISABLED — PG TLS blocked)"]:::off
    end

    pg([Azure PG Flexible<br/>mpiazeppgdb0003...:5432<br/>sslmode=require])
    blob([Azure Blob<br/>blobmpseapmycurex01])
    kv([Azure Key Vault<br/>kv-mpi-sea-p-mycurex01])
    atlas([MongoDB Atlas<br/>mycure-stg-sh · medicard-production])

    clients -->|HTTPS| edge
    edge -->|"HTTP :80"| envoy
    envoy --> hapihub
    envoy --> mycure
    envoy --> s3proxy
    mycure -->|API_URL / wss| hapihub

    hapihub -->|"SQL (DATABASE_URI)"| pg
    hapihub -->|"S3 :9000"| s3proxy
    hapihub -->|cache| valkey
    s3proxy -->|Azure Blob API| blob

    migrator -->|read| atlas
    migrator -->|"SQL write"| pg
    migrator -->|"S3 (GridFS→bucket)"| s3proxy

    eso -->|pull secrets| kv
    argo -->|reconcile| repo
    hapihub -.image.- ghcr
    mycure -.image.- ghcr

    classDef bb fill:#f5f5f5,stroke:#999,stroke-dasharray:5 4,color:#333;
    classDef off fill:#eee,stroke:#bbb,color:#999,stroke-dasharray:3 3;
    class clients,edge,ghcr,repo,pg,blob,kv,atlas bb;
```

---

## 4. K8s — Staging

Same AKS/GitOps model, `staging` branch → ns `medicard-staging`, domain
`*-mycurex-dev`. hapihub (11.2.9) serves the API against external Azure PG
(`DATABASE_URI`) and external Mongo / Atlas (`MONGO_URI`); mycureapp (10.4.2) is
the CMS frontend. In-cluster data services are **MinIO** (S3 storage) and
**Mailpit** (email testing), with hapihub-migrator (3.7.7) run on-demand.

```mermaid
flowchart TB
    clients([Clients / browsers])
    edge([Azure App Gateway<br/>terminates TLS])
    repo([GitHub<br/>...-medicard.git @ staging])
    kv([Azure Key Vault])

    subgraph AKS["AKS aks-mpi-sea-a-mycurex01 · ns: medicard-staging"]
        argo[ArgoCD app-of-apps]
        eso[External Secrets Operator]
        envoy[Envoy Gateway<br/>shared-gateway]

        hapihub["hapihub 11.2.9<br/>:7500 · api-mycurex-dev"]
        mycure["mycureapp 10.4.2<br/>cms-mycurex-dev"]
        minio["minio :9000<br/>storage-mycurex-dev (in-cluster S3)"]
        mailpit["mailpit<br/>email testing"]
        migrator["hapihub-migrator 3.7.7<br/>(on-demand)"]
    end

    pg([Azure PG Flexible<br/>external DATABASE_URI])
    atlas([MongoDB Atlas<br/>external MONGO_URI])

    clients -->|HTTPS| edge
    edge -->|HTTP| envoy
    envoy --> hapihub
    envoy --> mycure
    envoy --> minio
    mycure -->|API_URL| hapihub

    hapihub -->|"SQL (DATABASE_URI)"| pg
    hapihub -->|"mongo (MONGO_URI)"| atlas
    hapihub -->|"S3 :9000"| minio
    hapihub -->|SMTP| mailpit
    migrator -->|read| atlas
    migrator -->|SQL write| pg

    eso -->|pull secrets| kv
    argo -->|reconcile| repo

    classDef bb fill:#f5f5f5,stroke:#999,stroke-dasharray:5 4,color:#333;
    class clients,edge,repo,kv,pg,atlas bb;
```

---

## Blackboxes (external — accessed only via the listed interface)

| Blackbox | Interface we use | Used by |
|---|---|---|
| MediCard CPS API | HTTPS REST (basic auth) — claims/billing submission | legacy hapihub CPS plugin (prod + staging) |
| MongoDB Atlas | `mongodb+srv://` conn string | legacy hapihub; k8s staging hapihub (`MONGO_URI`); k8s migrator source (both envs) |
| Azure PG Flexible Server | `postgres://…?sslmode=require` | k8s hapihub / migrator (both envs) |
| Azure Blob | Azure Blob API (via s3proxy) | k8s **prod** storage only (staging uses in-cluster MinIO) |
| Azure Key Vault | ESO ClusterSecretStore (`azure-secretstore`) | k8s both envs |
| Azure App Gateway + WAF | HTTPS in → HTTP to our edge | all client-facing traffic |
| GHCR | image pulls | k8s workloads |
| GitHub (infra repo) | ArgoCD reconcile | k8s GitOps |
