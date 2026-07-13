{{/*
Standard exclusion for operator / system namespaces.

Every ClusterPolicy in this chart validates workload specs against
production-tenant expectations (PSS restricted, ownership labels, image
provenance). Those expectations don't fit the pods that upstream
operators install into their own namespaces — controllers legitimately
run privileged, mount hostPaths, don't carry our `app/environment/client`
label taxonomy, and pull from vendor-specific registries.

Applying the policies to those namespaces would either admission-block
the operators (breaking the cluster) or generate a flood of policy-report
noise. Skip them at the rule level.

Usage inside a rule spec:

    rules:
    - name: ...
      match:
        any:
        - resources:
            kinds: [Pod]
      exclude:
{{- include "kyverno-resources.excludeSystemNs" . | nindent 8 }}
      validate: ...
*/}}
{{- define "kyverno-resources.excludeSystemNs" -}}
any:
- resources:
    namespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    - argocd
    - kyverno
    - falco
    - external-secrets-system
    - envoy-gateway-system
    - cert-manager
    - monitoring
    - loki
    - velero
{{- end }}
