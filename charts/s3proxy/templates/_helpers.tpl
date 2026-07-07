{{/*
Expand the name of the chart.
*/}}
{{- define "s3proxy.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified name — honours fullnameOverride (default "minio" so hapihub
finds us at the DNS name it already expects).
*/}}
{{- define "s3proxy.fullname" -}}
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

{{- define "s3proxy.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "s3proxy.labels" -}}
helm.sh/chart: {{ include "s3proxy.chart" . }}
{{ include "s3proxy.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "s3proxy.selectorLabels" -}}
app.kubernetes.io/name: {{ include "s3proxy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "s3proxy.namespace" -}}
{{- default .Release.Namespace .Values.global.namespace }}
{{- end }}

{{- define "s3proxy.gateway.name" -}}
{{- .Values.gateway.parentRefs | first | dig "name" .Values.global.gateway.name }}
{{- end }}

{{- define "s3proxy.gateway.namespace" -}}
{{- .Values.gateway.parentRefs | first | dig "namespace" .Values.global.gateway.namespace }}
{{- end }}

{{/*
Hostname for HTTPRoute. Default: storage.{global.domain}
*/}}
{{- define "s3proxy.gateway.hostname" -}}
{{- if .Values.gateway.hostname }}
{{- .Values.gateway.hostname }}
{{- else }}
{{- printf "storage.%s" .Values.global.domain }}
{{- end }}
{{- end }}
