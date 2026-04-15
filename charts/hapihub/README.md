# Monobase API Helm Chart

Helm chart for deploying the Monobase API backend service with PostgreSQL, Valkey (Redis), and optional MinIO.

## Overview

The Monobase API chart deploys:
- **API backend** - Node.js/Express REST API
- **PostgreSQL** - Primary database (with HA replication)
- **Valkey** - Redis-compatible cache
- **MinIO** (optional) - S3-compatible object storage

## Quick Start

```yaml
# deployments/myclient-prod/values.yaml
api:
  enabled: true
  replicaCount: 3
  image:
    repository: ghcr.io/monobaselabs/api
    tag: "5.215.2"

postgresql:
  enabled: true
  architecture: replication
  replicaCount: 2
```

Deploy via ArgoCD (GitOps) or Helm:

```bash
# GitOps (recommended)
git add deployments/myclient-prod/values.yaml && git commit && git push

# Manual Helm install
helm install myclient-api ./charts/api -f deployments/myclient-prod/values.yaml
```

## API Parameters

### api.enabled
- **Type:** boolean
- **Default:** `true`
- **Description:** Enable or disable API deployment

### api.replicaCount
- **Type:** integer
- **Default:** `2`
- **Minimum:** `1`
- **Production:** `3` (for HA)
- **Description:** Number of API pod replicas

### api.image.repository
- **Type:** string
- **Default:** `ghcr.io/monobaselabs/api`
- **Description:** Container image repository

### api.image.tag
- **Type:** string
- **Default:** `5.215.2`
- **Production:** Pin specific version (e.g., `5.215.2`)
- **Staging:** Can use `latest` for testing
- **Description:** Container image tag

### api.image.pullPolicy
- **Type:** string
- **Default:** `IfNotPresent`
- **Options:** `Always`, `IfNotPresent`, `Never`

## Resource Configuration

### api.resources.requests.cpu
- **Type:** string
- **Default:** `500m`
- **Staging:** `250m`
- **Production:** `1` (1 CPU)
- **Description:** Guaranteed CPU allocation

### api.resources.requests.memory
- **Type:** string
- **Default:** `1Gi`
- **Staging:** `512Mi`
- **Production:** `2Gi`
- **Description:** Guaranteed memory allocation

### api.resources.limits.cpu
- **Type:** string
- **Default:** `2`
- **Production:** `2-4`
- **Description:** Maximum CPU allowed

### api.resources.limits.memory
- **Type:** string
- **Default:** `4Gi`
- **Production:** `4-8Gi`
- **Description:** Maximum memory allowed

## Gateway Configuration

### api.gateway.hostname
- **Type:** string
- **Default:** Empty (uses `api.{global.domain}`)
- **Example:** `api.myclient.com` or `api.custom-domain.com`
- **Description:** Custom hostname for API. If empty, defaults to api.{global.domain}

## Autoscaling

### api.autoscaling.enabled
- **Type:** boolean
- **Default:** `false`
- **Production:** `true`
- **Description:** Enable Horizontal Pod Autoscaler

### api.autoscaling.minReplicas
- **Type:** integer
- **Default:** `2`
- **Production:** `3`

### api.autoscaling.maxReplicas
- **Type:** integer
- **Default:** `10`
- **Production:** `5-10`

### api.autoscaling.targetCPUUtilizationPercentage
- **Type:** integer
- **Default:** `70`
- **Range:** 1-100

## High Availability

### api.podDisruptionBudget.enabled
- **Type:** boolean
- **Default:** `true`
- **Production:** `true` (required for HA)

### api.podDisruptionBudget.minAvailable
- **Type:** integer
- **Default:** `1`
- **Description:** Minimum pods that must remain available during disruptions

## Security

### api.networkPolicy.enabled
- **Type:** boolean
- **Default:** `true`
- **Production:** `true` (required for security)

### api.externalSecrets.enabled
- **Type:** boolean
- **Default:** `true`
- **Description:** Sync secrets from KMS via External Secrets Operator

---

## PostgreSQL Dependency

The API chart includes PostgreSQL as a dependency for data persistence.

### postgresql.enabled
- **Type:** boolean
- **Default:** `true`
- **Description:** Deploy PostgreSQL (required for Monobase API)

### postgresql.architecture
- **Type:** string
- **Default:** `replicaset`
- **Options:** `standalone`, `replicaset`
- **Production:** `replicaset` (required for HA)

### postgresql.replicaCount
- **Type:** integer
- **Default:** `3`
- **Staging:** `1`
- **Production:** `3` (minimum for HA)

### postgresql.auth.enabled
- **Type:** boolean
- **Default:** `true`
- **Production:** `true` (required)

### postgresql.auth.existingSecret
- **Type:** string
- **Default:** `postgresql-credentials`
- **Description:** Secret name containing PostgreSQL passwords (managed by External Secrets)

### postgresql.persistence.enabled
- **Type:** boolean
- **Default:** `true`

### postgresql.persistence.storageClass
- **Type:** string
- **Default:** `longhorn`

### postgresql.persistence.size
- **Type:** string
- **Default:** `100Gi`
- **Staging:** `20Gi`
- **Production:** `50Gi-500Gi` (based on data volume)

### postgresql.resources.requests.cpu
- **Type:** string
- **Default:** `1.5`
- **Production:** `1.5-3`

### postgresql.resources.requests.memory
- **Type:** string
- **Default:** `6Gi`
- **Production:** `6-8Gi`

### postgresql.tls.enabled
- **Type:** boolean
- **Default:** `true`
- **Production:** `true` (recommended for security and compliance)

---

## Valkey (Redis) Dependency

Valkey provides caching and session storage.

### valkey.enabled
- **Type:** boolean
- **Default:** `false`
- **Description:** Deploy Valkey search engine

### valkey.replicas
- **Type:** integer
- **Default:** `3`
- **Production:** `3` (for HA)

### valkey.persistence.size
- **Type:** string
- **Default:** `50Gi`
- **Description:** Search index storage

---

## MinIO Dependency (Optional)

Self-hosted S3-compatible object storage. Use for <1TB data or when cost-sensitive.

### minio.enabled
- **Type:** boolean
- **Default:** `false`
- **Description:** Deploy self-hosted MinIO or use external S3
- **Enable when:** <1TB data, cost-sensitive, full control needed
- **Disable when:** >1TB data, using AWS S3/GCS/Azure Blob

### minio.mode
- **Type:** string
- **Default:** `distributed`
- **Options:** `standalone`, `distributed`
- **Staging:** `standalone`
- **Production:** `distributed` (for HA)

### minio.statefulset.replicaCount
- **Type:** integer
- **Default:** `6`
- **Description:** Number of MinIO nodes (6 for 1TB usable with EC:2)

### minio.persistence.size
- **Type:** string
- **Default:** `250Gi`
- **Description:** Storage per node (6 × 250Gi = 1.5TB raw → ~1TB usable with EC:2)

### minio.gateway.hostname
- **Type:** string
- **Default:** Empty (uses `storage.{global.domain}`)

---

## Configuration Examples

### Minimal Configuration (Staging)

```yaml
api:
  enabled: true
  replicaCount: 1
  image:
    tag: "latest"
  resources:
    requests:
      cpu: 250m
      memory: 512Mi

postgresql:
  enabled: true
  replicaCount: 1
  persistence:
    size: 20Gi

valkey:
  enabled: false

minio:
  enabled: false
```

### Production Configuration (HA)

```yaml
api:
  enabled: true
  replicaCount: 3
  image:
    tag: "5.215.2"  # Pin version
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 10
  resources:
    requests:
      cpu: 1
      memory: 2Gi
    limits:
      cpu: 2
      memory: 4Gi

postgresql:
  enabled: true
  architecture: replicaset
  replicaCount: 3
  persistence:
    size: 100Gi
  resources:
    requests:
      cpu: 1.5
      memory: 6Gi

valkey:
  enabled: true
  replicas: 3
  persistence:
    size: 50Gi

minio:
  enabled: false  # Use AWS S3/GCS/Azure Blob for production
```

## Related Documentation

- **[Chart Schema](values.schema.json)** - JSON schema for validation
- **[Chart Values](values.yaml)** - Default values
- **[../README.md](../README.md)** - Global parameters and overview
- **[../../deployments/README.md](../../deployments/README.md)** - Deployment configuration guide

## Next Steps

1. **Configure:** Create deployment values in `../../deployments/myclient-prod/values.yaml`
2. **Deploy:** Use ArgoCD GitOps or manual Helm install
3. **Monitor:** See `../../docs/operations/MONITORING.md`
4. **Scale:** See `../../docs/operations/SCALING-GUIDE.md`
