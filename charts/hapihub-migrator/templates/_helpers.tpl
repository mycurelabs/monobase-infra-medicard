{{/*
Expand the name of the chart.
*/}}
{{- define "hapihub-migrator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "hapihub-migrator.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "hapihub-migrator.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "hapihub-migrator.labels" -}}
helm.sh/chart: {{ include "hapihub-migrator.chart" . }}
{{ include "hapihub-migrator.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: mycure
{{- end }}

{{/*
Selector labels
*/}}
{{- define "hapihub-migrator.selectorLabels" -}}
app.kubernetes.io/name: {{ include "hapihub-migrator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "hapihub-migrator.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "hapihub-migrator.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Gateway hostname
*/}}
{{- define "hapihub-migrator.gateway.hostname" -}}
{{- if .Values.gateway.hostname }}
{{- .Values.gateway.hostname }}
{{- else }}
{{- printf "migrate.%s" .Values.global.domain }}
{{- end }}
{{- end }}

{{/*
Namespace - uses global.namespace or Release.Namespace
*/}}
{{- define "hapihub-migrator.namespace" -}}
{{- default .Release.Namespace .Values.global.namespace }}
{{- end }}

{{/*
Gateway parent reference name
*/}}
{{- define "hapihub-migrator.gateway.name" -}}
{{- default "shared-gateway" .Values.global.gateway.name }}
{{- end }}

{{/*
Gateway parent reference namespace
*/}}
{{- define "hapihub-migrator.gateway.namespace" -}}
{{- default "gateway-system" .Values.global.gateway.namespace }}
{{- end }}

{{/*
PostgreSQL host resolution
*/}}
{{- define "hapihub-migrator.postgresql.host" -}}
{{- .Values.postgresql.host | default "postgresql" }}
{{- end }}

{{/*
Node Pool
*/}}
{{- define "hapihub-migrator.nodePool" -}}
{{- if hasKey .Values "nodePool" -}}
  {{- if and .Values.nodePool (hasKey .Values.nodePool "enabled") (not .Values.nodePool.enabled) -}}
    {{- /* Component explicitly disabled node pool */ -}}
  {{- else if and .Values.nodePool .Values.nodePool.name -}}
    {{- .Values.nodePool.name -}}
  {{- else if and .Values.global .Values.global.nodePool -}}
    {{- .Values.global.nodePool -}}
  {{- end -}}
{{- else if and .Values.global .Values.global.nodePool -}}
  {{- .Values.global.nodePool -}}
{{- end -}}
{{- end -}}

{{/*
Shared DB + encryption env, used by both the dashboard Deployment and the
migration CronJob so the secret wiring stays in one place.
NOTE: PG_ENCRYPTION_KEY is intentionally NOT injected — the migrator never
reads it (AUDIT CRYPTO-1); injecting it falsely implied PG PII is encrypted.
*/}}
{{- define "hapihub-migrator.dbEnv" -}}
- name: MONGO_SOURCE_URI
  valueFrom:
    secretKeyRef:
      name: {{ .Values.migration.existingSecret }}
      key: mongo-source-uri
{{- if .Values.postgresql.uriSecret }}
- name: PG_TARGET_URI
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgresql.uriSecret.name }}
      key: {{ .Values.postgresql.uriSecret.key }}
{{- else }}
- name: POSTGRESQL_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgresql.existingSecret }}
      key: {{ .Values.postgresql.secretKey }}
- name: PG_TARGET_URI
  value: "postgresql://{{ .Values.postgresql.username }}:$(POSTGRESQL_PASSWORD)@{{ include "hapihub-migrator.postgresql.host" . }}:{{ .Values.postgresql.port }}/{{ .Values.postgresql.database }}"
{{- end }}
- name: ENC_PERSONAL_DETAILS
  valueFrom:
    secretKeyRef:
      name: {{ .Values.migration.existingSecret }}
      key: enc-personal-details
      optional: true
- name: ENC_MEDICAL_RECORDS
  valueFrom:
    secretKeyRef:
      name: {{ .Values.migration.existingSecret }}
      key: enc-medical-records
      optional: true
- name: ENC_BILLING_INVOICES
  valueFrom:
    secretKeyRef:
      name: {{ .Values.migration.existingSecret }}
      key: enc-billing-invoices
      optional: true
- name: ENC_BILLING_ITEMS
  valueFrom:
    secretKeyRef:
      name: {{ .Values.migration.existingSecret }}
      key: enc-billing-items
      optional: true
- name: ENC_BILLING_PAYMENTS
  valueFrom:
    secretKeyRef:
      name: {{ .Values.migration.existingSecret }}
      key: enc-billing-payments
      optional: true
{{- end }}

{{/*
Shared CDC env (only meaningful for cdc mode; harmless elsewhere).
*/}}
{{- define "hapihub-migrator.cdcEnv" -}}
{{- if .Values.cdc.enabled }}
{{- with .Values.cdc }}
{{- if .changelogCollectionPrefix }}
- name: CDC_CHANGELOG_COLLECTION_PREFIX
  value: {{ .changelogCollectionPrefix | quote }}
{{- end }}
{{- if .replayBatchSize }}
- name: CDC_REPLAY_BATCH_SIZE
  value: {{ .replayBatchSize | quote }}
{{- end }}
{{- if .replayIntervalMs }}
- name: CDC_REPLAY_INTERVAL_MS
  value: {{ .replayIntervalMs | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
GridFS → S3 storage-migration env. Only rendered when storage.enabled; the
migrator's GridFS→S3 path activates when STORAGE_BUCKET is set. Access key/secret
come from the storage secret (e.g. the s3proxy Secret's root-user/root-password).
*/}}
{{- define "hapihub-migrator.storageEnv" -}}
{{- if .Values.storage.enabled }}
- name: STORAGE_BUCKET
  value: {{ .Values.storage.bucket | quote }}
- name: STORAGE_S3_ENDPOINT
  value: {{ .Values.storage.endpoint | quote }}
- name: STORAGE_S3_REGION
  value: {{ .Values.storage.region | default "us-east-1" | quote }}
- name: STORAGE_DIRECTORY
  value: {{ .Values.storage.directory | default "files" | quote }}
- name: STORAGE_S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.storage.secretName }}
      key: {{ .Values.storage.accessKeyIdKey | default "root-user" }}
- name: STORAGE_S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.storage.secretName }}
      key: {{ .Values.storage.secretAccessKeyKey | default "root-password" }}
{{- end }}
{{- end }}
