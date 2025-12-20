{{/*
Expand the name of the chart.
*/}}
{{- define "minio.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "minio.fullname" -}}
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
{{- define "minio.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "minio.labels" -}}
helm.sh/chart: {{ include "minio.chart" . }}
{{ include "minio.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "minio.selectorLabels" -}}
app.kubernetes.io/name: {{ include "minio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the namespace to use
*/}}
{{- define "minio.namespace" -}}
{{- default .Release.Namespace .Values.namespaceOverride }}
{{- end }}

{{/*
Resolve the gateway name to use
*/}}
{{- define "minio.gateway.name" -}}
{{- $parentRef := .Values.minio.gateway.parentRefs | first | default dict -}}
{{- $globalGatewayName := "" -}}
{{- if and .Values.global .Values.global.gateway -}}
{{- $globalGatewayName = .Values.global.gateway.name -}}
{{- end -}}
{{- $parentRef | dig "name" $globalGatewayName | default "shared-gateway" }}
{{- end }}

{{/*
Resolve the gateway namespace to use
*/}}
{{- define "minio.gateway.namespace" -}}
{{- $parentRef := .Values.minio.gateway.parentRefs | first | default dict -}}
{{- $globalGatewayNamespace := "" -}}
{{- if and .Values.global .Values.global.gateway -}}
{{- $globalGatewayNamespace = .Values.global.gateway.namespace -}}
{{- end -}}
{{- $parentRef | dig "namespace" $globalGatewayNamespace | default "gateway-system" }}
{{- end }}

{{/*
Resolve the hostname for HTTPRoute
Default: storage.{global.domain}
*/}}
{{- define "minio.gateway.hostname" -}}
{{- if .Values.minio.gateway.hostname }}
{{- .Values.minio.gateway.hostname }}
{{- else }}
{{- printf "storage.%s" .Values.global.domain }}
{{- end }}
{{- end }}
