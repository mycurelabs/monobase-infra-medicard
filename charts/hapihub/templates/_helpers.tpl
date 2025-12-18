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
app.kubernetes.io/part-of: mycure
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
Gateway hostname - defaults to hapihub.{global.domain}
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
MongoDB host - constructs hostname from MongoDB dependency
*/}}
{{- define "hapihub.mongodb.host" -}}
{{- $serviceName := .Values.mongodb.serviceName | default "mongodb" -}}
{{- $namespace := include "hapihub.namespace" . -}}
{{- printf "%s.%s.svc.cluster.local" $serviceName $namespace -}}
{{- end }}

{{/*
MongoDB connection URL (without password - app substitutes from env var)
*/}}
{{- define "hapihub.mongodb.connectionUrl" -}}
{{- $host := include "hapihub.mongodb.host" . -}}
{{- $database := .Values.mongodb.database | default "hapihub" -}}
{{- $replicaSet := .Values.mongodb.replicaSet | default "rs0" -}}
mongodb://$(MONGODB_USER):$(MONGODB_PASSWORD)@{{ $host }}:27017/{{ $database }}?authSource=admin&replicaSet={{ $replicaSet }}
{{- end }}

{{/*
Valkey (Redis) URL - constructs connection URL from Valkey dependency
*/}}
{{- define "hapihub.valkey.url" -}}
{{- if .Values.valkey.enabled -}}
{{- $namespace := include "hapihub.namespace" . -}}
redis://valkey-master.{{ $namespace }}.svc.cluster.local:6379
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
*/}}
{{- define "hapihub.mailpit.host" -}}
{{- if .Values.mailpit.enabled -}}
{{- $namespace := include "hapihub.namespace" . -}}
mailpit-smtp.{{ $namespace }}.svc.cluster.local
{{- end -}}
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
