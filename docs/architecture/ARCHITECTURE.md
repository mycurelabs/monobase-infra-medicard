# Architecture Documentation

Technical architecture of the Monobase Infrastructure template.

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Gateway Architecture](#gateway-architecture)
4. [Storage Architecture](#storage-architecture)
5. [Security Architecture](#security-architecture)
6. [Backup Architecture](#backup-architecture)
7. [Monitoring Architecture](#monitoring-architecture)

---

## Overview

### Design Principles

1. **No Overengineering** - Simple, proven technologies for <500 users
2. **Security by Default** - Zero-trust, encryption everywhere
3. **Fork-Based Workflow** - Reusable template, client-specific configuration
4. **Cloud-Native** - Kubernetes-native, CNCF projects preferred
5. **Cost-Effective** - Shared infrastructure, optional components

### High-Level System Architecture

```mermaid
graph TB
    subgraph "Internet"
        Users["Users/Clients"]
    end
    
    subgraph "Kubernetes Cluster"
        subgraph "gateway-system namespace"
            Gateway["Envoy Gateway<br/>shared-gateway<br/>2 replicas"]
        end
        
        subgraph "client-a-prod namespace"
            MonobaseAPI1["Monobase API<br/>3 replicas"]
            MonobaseAccount1["Monobase Account<br/>2 replicas"]
            APIWorker1["API Worker<br/>2 replicas"]
            PostgreSQL1[("PostgreSQL<br/>3-node replica")]
            MinIO1[("MinIO<br/>6-node distributed")]
        end
        
        subgraph "client-b-prod namespace"
            MonobaseAPI2["Monobase API"]
            Apps2["Apps..."]
        end
        
        subgraph "Infrastructure"
            CloudStorage["Cloud Storage"]
            ArgoCD["ArgoCD GitOps"]
            ExtSecrets["External Secrets"]
            CertMgr["cert-manager"]
            Velero["Velero Backups"]
        end
    end
    
    subgraph "Cloud Provider KMS"
        KMS["AWS Secrets Manager<br/>Azure Key Vault<br/>GCP Secret Manager"]
    end
    
    Users -->|HTTPS| Gateway
    Gateway -->|HTTPRoute| MonobaseAPI1
    Gateway -->|HTTPRoute| MonobaseAccount1
    Gateway -->|HTTPRoute| MonobaseAPI2
    MonobaseAPI1 --> PostgreSQL1
    MonobaseAPI1 --> MinIO1
    APIWorker1 --> PostgreSQL1
    ArgoCD -.->|manages| MonobaseAPI1
    ArgoCD -.->|manages| MonobaseAccount1
    ExtSecrets -->|fetches| KMS
    ExtSecrets -.->|injects| MonobaseAPI1
    Velero -.->|backups| PostgreSQL1
    CloudStorage -.->|provides storage| PostgreSQL1
```

### Technology Stack

**Core (Always Deployed):**
- Kubernetes 1.27+ (EKS, AKS, GKE, or self-hosted)
- Envoy Gateway (Gateway API)
- cloud storage (distributed storage)
- ArgoCD (GitOps)
- External Secrets Operator (KMS integration)
- cert-manager (TLS automation)

**Applications:**
- Monobase API (API backend)
- Monobase Account (Vue.js frontend)
- PostgreSQL 7.x (primary database)

**Optional:**
- API Worker (real-time sync)
- MinIO (self-hosted S3)
- Valkey (Redis-compatible cache)
- Velero (Kubernetes backups)
- Prometheus + Grafana (monitoring)

**NOT Included (Deliberately):**
- ❌ Service Mesh (Istio/Linkerd) - Overkill for 3 services
- ❌ Self-hosted Vault - Use cloud KMS instead
- ❌ Rook-Ceph - cloud storage + MinIO simpler

---

## System Architecture

### Request Flow Diagram

```mermaid
sequenceDiagram
    participant U as User
    participant DNS as DNS
    participant LB as LoadBalancer
    participant GW as Envoy Gateway
    participant API as Monobase API
    participant DB as PostgreSQL
    participant S3 as MinIO/S3
    
    U->>DNS: api.client-a.com
    DNS-->>U: LoadBalancer IP
    U->>LB: HTTPS Request
    LB->>GW: Forward to Gateway
    Note over GW: Rate Limiting<br/>Security Headers<br/>TLS Termination
    GW->>GW: Match HTTPRoute<br/>(api.client-a.com)
    GW->>API: Route to Monobase API<br/>(client-a-prod ns)
    API->>DB: Query Data
    DB-->>API: Response
    API->>S3: Fetch File
    S3-->>API: File Data
    API-->>GW: JSON Response
    GW-->>LB: Response
    LB-->>U: HTTPS Response
```

### Multi-Tenant Architecture

```mermaid
graph TB
    subgraph "Single Kubernetes Cluster"
        subgraph "Shared Gateway"
            GW[Envoy Gateway<br/>LoadBalancer IP: X.X.X.X]
        end
        
        subgraph "client-a-prod namespace"
            R1[HTTPRoute<br/>api.client-a.com]
            H1[Monobase API-A]
            DB1[(PostgreSQL-A)]
        end
        
        subgraph "client-b-prod namespace"
            R2[HTTPRoute<br/>api.client-b.com]
            H2[Monobase API-B]
            DB2[(PostgreSQL-B)]
        end
        
        subgraph "client-c-staging namespace"
            R3[HTTPRoute<br/>api.client-c-staging.com]
            H3[Monobase API-C]
            DB3[(PostgreSQL-C)]
        end
        
        subgraph "Infrastructure (Shared)"
            NP[NetworkPolicies<br/>Namespace Isolation]
            Storage[cloud storage<br/>Distributed Storage]
        end
    end
    
    GW --> R1
    GW --> R2
    GW --> R3
    R1 --> H1
    R2 --> H2
    R3 --> H3
    H1 --> DB1
    H2 --> DB2
    H3 --> DB3
    NP -.->|isolates| H1
    NP -.->|isolates| H2
    NP -.->|isolates| H3
    Storage -.->|provides PVCs| DB1
    Storage -.->|provides PVCs| DB2
    Storage -.->|provides PVCs| DB3
```

### Component Diagram

```mermaid
graph TB
    Internet["Internet / DNS"]
    LB["LoadBalancer IP"]

    subgraph "gateway-system namespace"
        EnvoyGW["Shared Envoy Gateway<br/>- HTTPS listener 443<br/>- HA: 2 replicas<br/>- Rate limiting<br/>- Security headers"]
    end

    subgraph "myclient-prod namespace"
        Routes["HTTPRoutes per service<br/>- api.myclient.com<br/>- app.myclient.com<br/>- sync.myclient.com"]
        MonoAPI["Monobase API App<br/>2-3 replicas"]
        Worker["API Worker<br/>2 replicas"]
        Account["Account App<br/>2 replicas"]
        PG["PostgreSQL<br/>Replica Set<br/>3 nodes"]
        MIO["MinIO<br/>Distributed<br/>6 nodes"]
        CloudSt["Cloud Storage<br/>- 3x replication<br/>- Snapshots<br/>- Encryption"]
    end

    Internet --> LB
    LB --> EnvoyGW
    EnvoyGW --> Routes
    Routes --> MonoAPI
    Routes --> Worker
    Routes --> Account
    MonoAPI --> PG
    MonoAPI --> MIO
    Worker --> PG
    PG --> CloudSt
    MIO --> CloudSt
```

### Data Flow

**1. User Request → Monobase API:**
```
Browser → DNS → LoadBalancer → Gateway (443) 
  → HTTPRoute (api.myclient.com) → Monobase API Service (7500) 
  → Monobase API Pod → PostgreSQL (5432)
```

**2. User Request → Frontend:**
```
Browser → DNS → LoadBalancer → Gateway (443)
  → HTTPRoute (app.myclient.com) → Monobase Account Service (80)
  → Monobase Account Pod (nginx serving static files)
```

**3. File Upload Flow:**
```
Client → Monobase API → MinIO S3 API (9000)
  → Cloud Storage PVC → Cloud provider block storage
```

**4. File Download Flow:**
```
Client → Monobase API (generates presigned URL)
  → Client downloads directly from MinIO via Gateway
  → HTTPRoute (storage.myclient.com) → MinIO (9000)
```

---

## Gateway Architecture

### Shared Gateway Strategy

**Key Decision: 1 Gateway + Dynamic HTTPRoutes**

```mermaid
graph TB
    subgraph "gateway-system namespace (shared)"
        SharedGW["Shared Gateway<br/>- Single HTTPS listener<br/>- Wildcard: *.myclient.com<br/>- HA: 2 Envoy replicas<br/>- Single LoadBalancer IP"]
    end

    ClientA["Client A<br/>HTTPRoutes"]
    ClientB["Client B<br/>HTTPRoutes"]
    ClientC["Client C<br/>HTTPRoutes"]

    SharedGW -->|References| ClientA
    SharedGW -->|References| ClientB
    SharedGW -->|References| ClientC
```

**Benefits:**
- ✅ **Zero-downtime client onboarding** - HTTPRoutes added dynamically
- ✅ **Single LoadBalancer IP** - Cost-effective
- ✅ **Independent routing** - Each client controls their routes
- ✅ **Flexible hostnames** - Any domain per service

**HTTPRoute Pattern:**
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
spec:
  parentRefs:
    - name: shared-gateway  # References shared Gateway
      namespace: gateway-system
  hostnames:
    - api.client.com       # Client-specific domain
  rules:
    - backendRefs:
        - name: api
          port: 7500
```

---

## Storage Architecture

### cloud storage Distributed Block Storage

```mermaid
graph TB
    subgraph "Cloud Storage Cluster"
        Node1["Node 1<br/>Replica A<br/>Replica B"]
        Node2["Node 2<br/>Replica A<br/>Replica B"]
        Node3["Node 3<br/>Replica A<br/>Replica B"]
        Info["Data replicated 3x across nodes<br/>Can lose 2 nodes without data loss"]
    end

    SSets["StatefulSets<br/>- PostgreSQL<br/>- MinIO<br/>- Valkey"]

    SSets -->|"iSCSI / NVMe"| Node1
    SSets -->|"iSCSI / NVMe"| Node2
    SSets -->|"iSCSI / NVMe"| Node3
```

**Features:**
- **3-way replication** - Data on 3 nodes
- **Automatic failover** - Rebuilds replicas on node failure
- **Snapshots** - Hourly local snapshots
- **Backups** - Daily S3 backups
- **Encryption** - dm-crypt volume encryption
- **Expansion** - Online volume resize

### MinIO Distributed Storage (Optional)

```mermaid
graph TB
    subgraph "MinIO Erasure Coding EC:2<br/>6 Nodes x 250Gi = 1.5TB raw<br/>4 data + 2 parity = ~1TB usable 66%"
        D1["Data 1<br/>250Gi"]
        D2["Data 2<br/>250Gi"]
        D3["Data 3<br/>250Gi"]
        D4["Data 4<br/>250Gi"]
        P1["Parity 1"]
        P2["Parity 2"]
    end

    Tolerance["Can lose 2 nodes without data loss"]

    D1 --- D2
    D2 --- D3
    D4 --- P1
    P1 --- P2
    D1 --- D4
    D3 --- P2
```

**Why MinIO:**
- S3-compatible API
- No egress fees (self-hosted)
- <1TB data (cost-effective)
- Full control

**Why External S3:**
- >1TB data (scale better)
- Global CDN integration
- Managed service
- Built-in redundancy

---

## Security Architecture

### Zero-Trust Network Model

```mermaid
graph TB
    DenyAll["Default: DENY ALL"]
    Blocked["All traffic blocked by default"]
    AllowRules["Explicit ALLOW rules"]
    Allowed["ALLOW: Gateway to Apps<br/>ALLOW: Apps to PostgreSQL<br/>ALLOW: Apps to Storage<br/>ALLOW: Apps to Internet HTTPS"]
    Denied["BLOCKED: Cross-namespace<br/>BLOCKED: Direct pod access"]

    DenyAll --> Blocked
    Blocked --> AllowRules
    AllowRules --> Allowed
    AllowRules --> Denied
```

### Defense in Depth

**Layer 1: Network (NetworkPolicies)**
- Default deny all traffic
- Explicit allow rules only
- Cross-namespace isolation
- DNS and K8s API allowed

**Layer 2: Pod (Pod Security Standards)**
- Non-root containers
- No privilege escalation
- Drop ALL capabilities
- Read-only root filesystem
- seccomp profile enforced

**Layer 3: Application (RBAC)**
- Dedicated service accounts
- Least-privilege roles
- No default SA usage
- Namespace-scoped permissions

**Layer 4: Data (Encryption)**
- At rest: cloud storage + PostgreSQL encryption
- In transit: TLS everywhere (cert-manager)
- Backups: S3 + KMS encryption

**Layer 5: Access (External Secrets)**
- Secrets never in Git
- KMS integration (AWS/Azure/GCP)
- Automatic rotation
- Audit logging

---

## Backup Architecture

### 3-Tier Backup Strategy

```mermaid
graph TB
    T1["Tier 1: Hourly Snapshots (Fast)<br/>- Storage: Local cloud storage nodes<br/>- Retention: 72 hours<br/>- Recovery: ~5 minutes<br/>- Use: Quick rollback, recent issues"]
    T2["Tier 2: Daily Backups (Medium)<br/>- Storage: S3 off-cluster<br/>- Retention: 30 days<br/>- Recovery: ~1 hour<br/>- Use: Last month recovery"]
    T3["Tier 3: Weekly Archive (Long-term)<br/>- Storage: S3 Glacier cold<br/>- Retention: 90+ days HIPAA<br/>- Recovery: ~4 hours<br/>- Use: Compliance, disaster recovery"]

    T1 --> T2
    T2 --> T3
```

**Backup Methods:**

1. **cloud storage Snapshots** - Volume-level, COW snapshots
2. **Velero Backups** - Kubernetes-native, application-aware
3. **PostgreSQL dumps** - Application-level (optional)

**Recovery Time Objectives (RTO):**
- Tier 1: 5 minutes
- Tier 2: 1 hour
- Tier 3: 4 hours

**Recovery Point Objectives (RPO):**
- Tier 1: 1 hour (max data loss)
- Tier 2: 24 hours
- Tier 3: 1 week

---

## Monitoring Architecture

### Optional Monitoring Stack

```mermaid
graph TB
    Apps["Applications<br/>Monobase API, API Worker, Account<br/>/metrics endpoints"]
    Prom["Prometheus<br/>- 15d retain<br/>- 50Gi PVC<br/>- HA: 2 replicas"]
    Graf["Grafana<br/>Dashboards"]
    Alert["Alertmanager<br/>Slack / PagerDuty"]

    Apps -->|scrape| Prom
    Prom --> Graf
    Prom --> Alert
```

**When to Enable:**
- Production environments
- >100 active users
- After baseline established
- Business-critical services

**Resource Overhead:**
- ~3-5% additional CPU/memory
- ~60Gi additional storage
- Worth it for production visibility

---

## High Availability

### Component HA Strategy

| Component | Replicas | Strategy | Downtime on Failure |
|-----------|----------|----------|---------------------|
| Monobase API | 2-3 | Rolling update + PDB | 0s (other pods serve) |
| Monobase Account | 2 | Rolling update + PDB | 0s |
| API Worker | 2 | Rolling update + PDB | 0s |
| PostgreSQL | 3 | Replica set | <30s (auto-failover) |
| MinIO | 6 | Erasure coding | 0s (2 node tolerance) |
| Envoy Gateway | 2 | Anti-affinity | <1s (pod swap) |
| cloud storage | 3 | Volume replication | 0s (auto-rebuild) |

### Update Strategy

**Zero-Downtime Updates:**
1. Rolling update with `maxSurge: 1`, `maxUnavailable: 0`
2. PodDisruptionBudget ensures `minAvailable: 1`
3. Health checks prevent unhealthy pod traffic
4. Gateway routes to healthy pods only

**Example Update:**
```
Before: Pod A (v1), Pod B (v1)
Step 1: Pod A (v1), Pod B (v1), Pod C (v2) ← new pod
Step 2: Pod A terminating, Pod B (v1), Pod C (v2)
Step 3: Pod B (v1), Pod C (v2), Pod D (v2) ← new pod
Step 4: Pod B terminating, Pod C (v2), Pod D (v2)
After: Pod C (v2), Pod D (v2) ← 100% v2, zero downtime
```

---

## Namespace Architecture

### Per-Client + Per-Environment Isolation

```mermaid
graph TB
    Cluster["Cluster"]

    GWSys["gateway-system (shared)<br/>shared-gateway, 1 Gateway, HA: 2 replicas"]
    CloudSys["cloud-default-system (shared)<br/>cloud storage components"]
    ExtSec["external-secrets-system (shared)<br/>External Secrets Operator"]
    VeleroNS["velero (shared)<br/>Velero backup controller"]
    ArgoNS["argocd (shared)<br/>ArgoCD components"]
    MonNS["monitoring (shared, optional)<br/>Prometheus + Grafana"]

    ClientAProd["client-a-prod<br/>api, api-worker, account<br/>postgresql, minio, valkey<br/>HTTPRoutes to shared-gateway"]
    ClientAStag["client-a-staging<br/>api, account<br/>postgresql<br/>HTTPRoutes to shared-gateway"]
    ClientBProd["client-b-prod<br/>api, api-worker, account<br/>postgresql, minio<br/>HTTPRoutes to shared-gateway"]

    Cluster --> GWSys
    Cluster --> CloudSys
    Cluster --> ExtSec
    Cluster --> VeleroNS
    Cluster --> ArgoNS
    Cluster --> MonNS
    Cluster --> ClientAProd
    Cluster --> ClientAStag
    Cluster --> ClientBProd
```

**Benefits:**
- **Isolation** - Each client in separate namespace
- **Security** - NetworkPolicies prevent cross-namespace traffic
- **Resource Control** - ResourceQuotas per namespace
- **Independent Scaling** - Scale clients independently
- **Cost Allocation** - Track resources per client

---

## Security Zones

### Zone Model

```mermaid
graph TB
    DMZ["DMZ (Public Internet)<br/>- Gateway LoadBalancer public IP<br/>- TLS termination<br/>- Rate limiting<br/>- DDoS protection"]
    AppZone["Application Zone<br/>- Monobase API, API Worker, Account<br/>- NetworkPolicy: allow from Gateway<br/>- Pod Security: restricted"]
    DataZone["Data Zone<br/>- PostgreSQL TLS + auth<br/>- MinIO IAM auth<br/>- NetworkPolicy: allow from apps only<br/>- Encryption at rest"]

    DMZ -->|"HTTPS only"| AppZone
    AppZone -->|"Authenticated connections"| DataZone
```

---

## Disaster Recovery

### RTO/RPO Targets

| Scenario | RTO | RPO | Recovery Method |
|----------|-----|-----|-----------------|
| Pod failure | 0s | 0 | Auto-restart + HA |
| Node failure | <30s | 0 | Pod rescheduling |
| AZ failure | <5min | 1h | cloud storage snapshot restore |
| Database corruption | <1h | 24h | Velero daily backup |
| Cluster failure | <4h | 1w | Velero weekly + new cluster |
| Region failure | <8h | 1w | Cross-region backup restore |

### Failure Scenarios

**1. Single Pod Failure:**
- **Detection:** Health check fails
- **Action:** Kubernetes restarts pod automatically
- **Impact:** None (other replicas serve traffic)
- **RTO:** <30s

**2. Node Failure:**
- **Detection:** Node goes NotReady
- **Action:** Pods rescheduled to healthy nodes
- **Impact:** Brief degradation if node had replicas
- **RTO:** 1-5 minutes
- **cloud storage:** Rebuilds volume replicas automatically

**3. PostgreSQL Replica Failure:**
- **Detection:** Replica set monitoring
- **Action:** Automatic failover to secondary
- **Impact:** <30s connection interruption
- **RTO:** <30s

**4. Complete Cluster Failure:**
- **Detection:** All nodes down
- **Action:** Restore to new cluster from Velero backup
- **Impact:** Full outage during restore
- **RTO:** 2-4 hours
- **RPO:** Last successful backup (24h max)

---

## Scalability

### Horizontal Scaling

**Application Pods (via HPA):**
```
Traffic increases → CPU >70% → HPA adds pods
  → More replicas → CPU normalizes → Stable
```

**Storage (via Volume Expansion):**
```
Storage fills → Expand PVC → cloud storage expands volume
  → No downtime → More space available
```

### Scaling Limits (Current Architecture)

| Component | Max Replicas | Bottleneck |
|-----------|--------------|------------|
| Monobase API | 10 | PostgreSQL connections |
| Monobase Account | 20 | None (stateless) |
| API Worker | 5 | WebSocket connections |
| PostgreSQL | 5 | Replication overhead |
| MinIO | 16 | Erasure coding limit |

**For >500 users:**
- Add PostgreSQL sharding
- Add read replicas
- Consider external S3
- Add caching layer (Redis)

---

## Summary

The Monobase Infrastructure template provides:

✅ **Modern Architecture** - Gateway API, GitOps, cloud-native
✅ **High Availability** - Multi-replica, auto-failover, zero-downtime
✅ **Security** - Zero-trust, encryption everywhere
✅ **Disaster Recovery** - 3-tier backups, tested procedures
✅ **Scalability** - HPA, storage expansion, multi-tenant
✅ **Observability** - Metrics, logs, alerts, dashboards

**Target:** <500 users, <1TB data per client
**Architecture:** Simple, proven, production-ready

For detailed operational procedures, see:
- [DEPLOYMENT.md](../getting-started/DEPLOYMENT.md) - Deployment steps
- [STORAGE.md](../operations/STORAGE.md) - Storage operations
- [BACKUP_DR.md](../operations/BACKUP_DR.md) - DR procedures
- [SCALING-GUIDE.md](../operations/SCALING-GUIDE.md) - Scaling guide
