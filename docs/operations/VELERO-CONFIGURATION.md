# Velero Backup Implementation

> **Note**: This document covers Velero-specific implementation details. For backup strategy, disaster recovery procedures, and runbooks, see:
> - [Backup & DR Strategy](../../docs/operations/BACKUP_DR.md)
> - [Disaster Recovery Runbooks](../../docs/operations/DISASTER_RECOVERY_RUNBOOKS.md)

## Current State — MediCard Prod (AKS)

Velero is **disabled** (`velero.enabled: false` in `values/infrastructure/main.yaml`).
The config is modernized to chart **12.0.1** (Velero 1.18, azure plugin v1.14.2)
and pre-wired for the azure provider using **storage-account-key auth**: the
`velero-credentials` secret is built by an ExternalSecret from the **same Key
Vault entry s3proxy uses** (`medicard-prod-azureblob-account-key`) — no
dedicated backup identity. Volume data goes through FSB (kopia → blob via
node-agent); there is no VSL because native managed-disk snapshots need an
Azure AD identity that key auth doesn't provide.

**Enable-time checklist:**
1. Create the backup container in the s3proxy storage account (velero does not
   auto-create it): `az storage container create --name velero-backups --account-name <account>`
   (the account key from KV also works for this).
2. Fill `velero.azure.storageAccount` in `values/infrastructure/main.yaml`
   (same account s3proxy writes to; the name is in KV as
   `medicard-prod-azureblob-account-name` — not secret).
3. Flip `velero.enabled: true` and merge. The velero pod may crashloop briefly
   until the ExternalSecret syncs (wave-1); ArgoCD retries cover it.
   Requires the ClusterSecretStore KV auth to be working (same blocker as
   s3proxy/hapihub secrets).
4. Verify: `kubectl -n velero get backupstoragelocation default` → Available,
   then `velero backup create test --wait`.

PSS note: the `velero` namespace is created by ArgoCD `CreateNamespace=true`
with no pod-security labels, so the privileged node-agent DaemonSet is fine.
If the namespace ever gets `restricted` labels, set
`pod-security.kubernetes.io/enforce=privileged` on it first.

---

## Overview

Velero is the current backup implementation for the monobase infrastructure. It provides:
- Cluster-level backups (infrastructure namespaces + cluster resources)
- Per-application backups (tenant namespaces via app charts)
- Multi-cloud support (AWS, Azure, GCP, DigitalOcean, MinIO)
- Cloud-native authentication (IRSA, Workload Identity)

## Prerequisites

### Cloud Identity (Automated)

Terraform modules automatically provision cloud identities:
- **AWS**: IRSA role for S3/EBS access
- **Azure**: Workload Identity for Blob Storage/Disk access
- **GCP**: Service Account for GCS/PD access

Check terraform outputs:
```bash
cd terraform/clusters/your-cluster
terraform output | grep velero
```

### Backup Storage (Manual Setup Required)

**Terraform does NOT create storage buckets** - create them manually:

#### AWS S3
```bash
aws s3 mb s3://my-cluster-velero-backups --region us-east-1
aws s3api put-bucket-versioning \
  --bucket my-cluster-velero-backups \
  --versioning-configuration Status=Enabled
```

#### Azure Blob Storage
```bash
az storage account create \
  --name myclustervelero \
  --resource-group my-cluster-rg \
  --sku Standard_GRS
az storage container create \
  --name velero-backups \
  --account-name myclustervelero
```

#### GCP Cloud Storage
```bash
gsutil mb -l us-central1 gs://my-cluster-velero-backups
gsutil versioning set on gs://my-cluster-velero-backups
```

#### DigitalOcean Spaces
```bash
doctl compute space create my-cluster-velero-backups --region nyc3
```

---

## Configuration

### Update `charts/argocd-infrastructure/values.yaml`

```yaml
velero:
  enabled: true
  provider: aws  # Options: aws, azure, gcp, digitalocean, minio
  
  # AWS Configuration
  aws:
    region: us-east-1
    bucket: my-cluster-velero-backups
    roleArn: ""  # Auto-populated from terraform
  
  # Schedule configuration
  schedules:
    infrastructure:
      daily:
        enabled: true
        retention: 720h  # 30 days
    cluster:
      weekly:
        enabled: true
        retention: 2160h  # 90 days
```

### Credentials

**AWS/GCP**: No credentials needed - uses cloud-native auth (IRSA/Workload Identity)

**Azure**: storage-account-key auth. The `velero-credentials` secret (key
`cloud`, dotenv format with `AZURE_STORAGE_ACCOUNT_ACCESS_KEY`) is synced
automatically by `charts/velero-resources/templates/velero-credentials-externalsecret.yaml`
from the same Key Vault entry s3proxy uses — nothing to create manually.

**DigitalOcean/MinIO**: Create secret manually:
```bash
kubectl create secret generic velero-credentials \
  --namespace velero \
  --from-literal=cloud="[default]
aws_access_key_id=YOUR_KEY
aws_secret_access_key=YOUR_SECRET"
```

See `credentials-template.yaml` for detailed examples.

### Deploy via GitOps

```bash
git add charts/argocd-infrastructure/values.yaml
git commit -m "feat: Enable Velero backups"
git push
```

ArgoCD will automatically deploy:
1. Velero operator (sync wave 0)
2. Backup locations and schedules (sync wave 1)

---

## Verification

```bash
# Check installation
kubectl get pods -n velero
kubectl get backupstoragelocation -n velero  # Should show: Available
kubectl get volumesnapshotlocation -n velero  # Should show: Available
kubectl get schedule -n velero  # Should show: infrastructure-daily, cluster-resources-weekly

# Monitor backup creation
kubectl get backup -n velero
velero backup describe infrastructure-daily-<timestamp> --details

# Verify cloud storage
aws s3 ls s3://my-cluster-velero-backups/infrastructure/
```

---

## Multi-Cloud Configuration Examples

### AWS (IRSA Authentication)
```yaml
velero:
  enabled: true
  provider: aws
  aws:
    region: us-east-1
    bucket: prod-cluster-velero-backups
    # roleArn: auto-populated from terraform
```

### Azure (storage-account key via Key Vault)
```yaml
velero:
  enabled: true
  provider: azure
  azure:
    storageAccount: prodclustervelero  # same account s3proxy uses
    blobContainer: velero-backups
  externalSecrets:
    secretStore: azure-secretstore
    azureBlobKeyKey: medicard-prod-azureblob-account-key
```
No Azure identity involved; FSB backs up volume data (no native disk
snapshots). If a workload identity is ever provisioned, restore the VSL in
`charts/velero-resources/templates/backup-locations.yaml` and add the
`azure.workload.identity/client-id` SA annotation +
`azure.workload.identity/use` pod label in
`charts/argocd-infrastructure/templates/velero.yaml`.

### GCP (Workload Identity)
```yaml
velero:
  enabled: true
  provider: gcp
  gcp:
    bucket: prod-cluster-velero-backups
    projectId: my-gcp-project
    region: us-central1
    # serviceAccount: auto-populated from terraform
```

### DigitalOcean (S3-Compatible)
```yaml
velero:
  enabled: true
  provider: digitalocean
  digitalocean:
    bucket: prod-cluster-velero-backups
    region: nyc3
    # Requires credentials secret
```

---

## Troubleshooting

### BackupStorageLocation Unavailable
```bash
# Check status
kubectl describe backupstoragelocation default -n velero

# Common fixes:
# 1. Verify bucket exists and name is correct
# 2. Check IAM/identity permissions
# 3. Verify region matches bucket location

# Check Velero logs
kubectl logs -n velero deployment/velero | grep -i error
```

### Cloud Authentication Issues

**AWS IRSA:**
```bash
# Verify service account annotation
kubectl get sa velero -n velero -o yaml | grep eks.amazonaws.com
# Should show: eks.amazonaws.com/role-arn: arn:aws:iam::...

# Test IAM role permissions
aws iam get-role --role-name my-cluster-velero
```

**Azure (storage-account key):**
```bash
# Verify the ExternalSecret synced the credentials
kubectl get externalsecret velero-credentials -n velero
kubectl get secret velero-credentials -n velero  # must have key `cloud`

# If missing: check the ClusterSecretStore (same KV auth s3proxy depends on)
kubectl get clustersecretstore azure-secretstore
```

**GCP Workload Identity:**
```bash
# Verify service account annotation
kubectl get sa velero -n velero -o yaml | grep iam.gke.io
# Should show gcp-service-account annotation

# Test permissions
gcloud projects get-iam-policy <project-id> \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:*velero*"
```

### Volume Snapshots Not Working
```bash
# Verify CSI driver installed
kubectl get csidriver

# For AWS: Check EBS CSI driver
kubectl get pods -n kube-system | grep ebs-csi

# Check snapshot configuration
kubectl get volumesnapshotlocation -n velero
kubectl describe volumesnapshotlocation default -n velero
```

### Scheduled Backups Not Running
```bash
# Check schedule status
kubectl get schedule -n velero
kubectl describe schedule infrastructure-daily -n velero

# Check for controller errors
kubectl logs -n velero deployment/velero | grep schedule

# Verify cron syntax (use https://crontab.guru/)
```

---

## File Reference

| File | Purpose |
|------|---------|
| `backup-locations.yaml` | BackupStorageLocation + VolumeSnapshotLocation for all clouds |
| `schedules.yaml` | Cluster-level backup schedules (infrastructure + cluster resources) |
| `credentials-template.yaml` | Credential setup examples for each cloud provider |
| `README.md` | This file - implementation setup guide |

**Per-app backups**: Configured in application Helm charts (e.g., `charts/api/templates/velero-schedules.yaml`)

---

## Resources

- **Backup Strategy**: [docs/operations/BACKUP_DR.md](../../docs/operations/BACKUP_DR.md)
- **DR Runbooks**: [docs/operations/DISASTER_RECOVERY_RUNBOOKS.md](../../docs/operations/DISASTER_RECOVERY_RUNBOOKS.md)
- **Velero Docs**: https://velero.io/docs/
- **Velero GitHub**: https://github.com/vmware-tanzu/velero

---

## Quick Commands

```bash
# Manual backup
velero backup create test-backup --include-namespaces cert-manager --wait

# List backups
velero backup get

# Restore from backup
velero restore create --from-backup infrastructure-daily-<timestamp>

# Check logs
kubectl logs -n velero deployment/velero
velero backup logs <backup-name>
```

For complete disaster recovery procedures, see the operations documentation.
