{{/*
Expand the name of the chart.
*/}}
{{- define "hapihub.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "hapihub.fullname" -}}
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
{{- define "hapihub.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "hapihub.labels" -}}
helm.sh/chart: {{ include "hapihub.chart" . }}
{{ include "hapihub.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: monobase
{{- end }}

{{/*
Selector labels
*/}}
{{- define "hapihub.selectorLabels" -}}
app.kubernetes.io/name: {{ include "hapihub.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "hapihub.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "hapihub.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Gateway hostname - defaults to api.{global.domain}
*/}}
{{- define "hapihub.gateway.hostname" -}}
{{- if .Values.gateway.hostname }}
{{- .Values.gateway.hostname }}
{{- else }}
{{- printf "hapihub.%s" .Values.global.domain }}
{{- end }}
{{- end }}

{{/*
Namespace - uses global.namespace or Release.Namespace
*/}}
{{- define "hapihub.namespace" -}}
{{- default .Release.Namespace .Values.global.namespace }}
{{- end }}

{{/*
Gateway parent reference name
*/}}
{{- define "hapihub.gateway.name" -}}
{{- default "shared-gateway" .Values.global.gateway.name }}
{{- end }}

{{/*
Gateway parent reference namespace
*/}}
{{- define "hapihub.gateway.namespace" -}}
{{- default "gateway-system" .Values.global.gateway.namespace }}
{{- end }}

{{/*
StorageClass name - auto-detects based on provider
*/}}
{{- define "hapihub.storageClass" -}}
{{- if .Values.global.storage.className -}}
{{- .Values.global.storage.className }}
{{- else if eq .Values.global.storage.provider "longhorn" -}}
longhorn
{{- else if eq .Values.global.storage.provider "ebs-csi" -}}
gp3
{{- else if eq .Values.global.storage.provider "azure-disk" -}}
managed-premium
{{- else if eq .Values.global.storage.provider "gcp-pd" -}}
pd-ssd
{{- else if eq .Values.global.storage.provider "local-path" -}}
local-path
{{- else -}}
{{- end -}}
{{- end }}

{{/*
MongoDB host - constructs hostname from MongoDB dependency
Supports both standalone and replicaset architectures
*/}}
{{- define "hapihub.mongodb.host" -}}
{{- $serviceName := .Values.mongodb.serviceName | default "mongodb" -}}
{{- $namespace := include "hapihub.namespace" . -}}
{{- $architecture := .Values.mongodb.architecture | default "replicaset" -}}
{{- if eq $architecture "replicaset" -}}
{{- printf "%s-headless.%s.svc.cluster.local" $serviceName $namespace -}}
{{- else -}}
{{- printf "%s.%s.svc.cluster.local" $serviceName $namespace -}}
{{- end -}}
{{- end }}

{{/*
MongoDB database name
*/}}
{{- define "hapihub.mongodb.database" -}}
{{- .Values.mongodb.database | default "hapihub" -}}
{{- end }}

{{/*
MongoDB username
*/}}
{{- define "hapihub.mongodb.username" -}}
{{- .Values.mongodb.username | default "root" -}}
{{- end }}

{{/*
MongoDB connection URL template (app must substitute password from MONGODB_PASSWORD env var)
*/}}
{{- define "hapihub.mongodb.connectionUrl" -}}
{{- $host := include "hapihub.mongodb.host" . -}}
{{- $database := include "hapihub.mongodb.database" . -}}
{{- $username := include "hapihub.mongodb.username" . -}}
{{- $replicaSet := .Values.mongodb.replicaSet | default "rs0" -}}
mongodb://{{ $username }}@{{ $host }}:27017/{{ $database }}?replicaSet={{ $replicaSet }}
{{- end }}

{{/*
PostgreSQL host - constructs hostname from PostgreSQL dependency
Supports both standalone and replication architectures
*/}}
{{- define "hapihub.postgresql.host" -}}
{{- $serviceName := .Values.postgresql.serviceName | default "postgresql" -}}
{{- $namespace := include "hapihub.namespace" . -}}
{{- printf "%s.%s.svc.cluster.local" $serviceName $namespace -}}
{{- end }}

{{/*
PostgreSQL database name
*/}}
{{- define "hapihub.postgresql.database" -}}
{{- .Values.postgresql.auth.database | default "hapihub" -}}
{{- end }}

{{/*
PostgreSQL username
*/}}
{{- define "hapihub.postgresql.username" -}}
{{- .Values.postgresql.auth.username | default "postgres" -}}
{{- end }}

{{/*
Valkey (Redis) URL - constructs connection URL from Valkey dependency
*/}}
{{- define "hapihub.valkey.url" -}}
{{- if .Values.valkey.enabled -}}
{{- $release := .Release.Name -}}
{{- $namespace := include "hapihub.namespace" . -}}
redis://{{ $release }}-valkey-master.{{ $namespace }}.svc.cluster.local:6379
{{- end -}}
{{- end }}

{{/*
MinIO URL - constructs connection URL from MinIO dependency
*/}}
{{- define "hapihub.minio.url" -}}
{{- if .Values.minio.enabled -}}
{{- $namespace := include "hapihub.namespace" . -}}
http://minio.{{ $namespace }}.svc.cluster.local:9000
{{- end -}}
{{- end }}

{{/*
Mailpit SMTP Host - constructs hostname for Mailpit SMTP service
Note: Mailpit is deployed as a standalone chart with instance name "mailpit"
*/}}
{{- define "hapihub.mailpit.host" -}}
{{- if .Values.mailpit.enabled -}}
{{- $namespace := include "hapihub.namespace" . -}}
mailpit-smtp.{{ $namespace }}.svc.cluster.local
{{- end -}}
{{- end }}

{{/*
External URL - constructs public HTTPS URL for HapiHub
Used for OAuth callbacks, webhooks, email links, etc.
*/}}
{{- define "hapihub.externalUrl" -}}
https://{{ include "hapihub.gateway.hostname" . }}
{{- end }}

{{/*
Node Pool - returns the effective node pool name (component-level or global)
Returns empty string if disabled or not configured
*/}}
{{- define "hapihub.nodePool" -}}
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
