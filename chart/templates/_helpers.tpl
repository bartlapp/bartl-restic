{{- define "bartl-restic.name" -}}
{{- printf "%s-restic" .Release.Name | trunc 20 | trimSuffix "-" -}}
{{- end -}}

{{/* Validate the selected service against the same shipped schema used for its documentation. */}}
{{- define "restic.validate" -}}
{{- $schema := .schema -}}
{{- if hasKey $schema "$ref" -}}{{- $schema = index .definitions (trimPrefix "#/definitions/" (index $schema "$ref")) -}}{{- end -}}
{{- $value := .value -}}
{{- $path := .path -}}
{{- $type := $schema.type -}}
{{- $valid := false -}}
{{- if eq $type "object" -}}{{- $valid = kindIs "map" $value -}}
{{- else if eq $type "array" -}}{{- $valid = kindIs "slice" $value -}}
{{- else if eq $type "string" -}}{{- $valid = kindIs "string" $value -}}
{{- else if eq $type "boolean" -}}{{- $valid = kindIs "bool" $value -}}
{{- else if eq $type "integer" -}}
  {{- if or (kindIs "float64" $value) (kindIs "int" $value) (kindIs "int64" $value) -}}{{- $valid = eq (float64 $value) (floor (float64 $value)) -}}{{- end -}}
{{- end -}}
{{- if not $valid -}}{{- fail (printf "%s must be %s" $path $type) -}}{{- end -}}
{{- if and (hasKey $schema "enum") (not (has $value $schema.enum)) -}}{{- fail (printf "%s has an unsupported value" $path) -}}{{- end -}}
{{- if eq $type "object" -}}
  {{- range $schema.required -}}{{- if not (hasKey $value .) -}}{{- fail (printf "%s.%s is required" $path .) -}}{{- end -}}{{- end -}}
  {{- range $key, $item := $value -}}
    {{- if hasKey $schema.properties $key -}}
      {{- include "restic.validate" (dict "schema" (index $schema.properties $key) "definitions" $.definitions "value" $item "path" (printf "%s.%s" $path $key)) -}}
    {{- else if eq (toString $schema.additionalProperties) "false" -}}{{- fail (printf "%s.%s is unknown" $path $key) -}}
    {{- end -}}
  {{- end -}}
{{- else if eq $type "array" -}}
  {{- range $index, $item := $value -}}{{- include "restic.validate" (dict "schema" $schema.items "definitions" $.definitions "value" $item "path" (printf "%s[%d]" $path $index)) -}}{{- end -}}
{{- else if eq $type "string" -}}
  {{- if and (hasKey $schema "minLength") (lt (len $value) (int $schema.minLength)) -}}{{- fail (printf "%s is too short" $path) -}}{{- end -}}
  {{- if and (hasKey $schema "maxLength") (gt (len $value) (int $schema.maxLength)) -}}{{- fail (printf "%s is too long" $path) -}}{{- end -}}
  {{- if and $schema.pattern (not (regexMatch $schema.pattern $value)) -}}{{- fail (printf "%s has an unsupported format" $path) -}}{{- end -}}
{{- else if eq $type "integer" -}}
  {{- if and (hasKey $schema "minimum") (lt (float64 $value) (float64 $schema.minimum)) -}}{{- fail (printf "%s is below its minimum" $path) -}}{{- end -}}
  {{- if and (hasKey $schema "maximum") (gt (float64 $value) (float64 $schema.maximum)) -}}{{- fail (printf "%s exceeds its maximum" $path) -}}{{- end -}}
{{- end -}}
{{- end -}}

{{/* Select a deployment without changing the shared installation record. */}}
{{- define "restic.selection" -}}
{{- $instance := .Values.instance | default "restic" -}}
{{- $intent := dict -}}
{{- if .Values.deployment -}}
  {{- $id := .Values.deployment -}}
  {{- $definitions := (mustFromJson (.Files.Get "interface.schema.json")).definitions -}}
  {{- if not (kindIs "map" .Values.deployments) -}}{{- fail "deployments must be an object when deployment is selected" -}}{{- end -}}
  {{- if not (hasKey .Values.deployments $id) -}}{{- fail (printf "deployments.%s is required" $id) -}}{{- end -}}
  {{- $deployment := index .Values.deployments $id -}}
  {{- include "restic.validate" (dict "schema" $definitions.deployment "definitions" $definitions "value" $deployment "path" (printf "deployments.%s" $id)) -}}
  {{- if and (hasKey .Values "instance") (ne .Values.instance $deployment.instance) -}}
    {{- fail (printf "instance %s conflicts with deployments.%s.instance %s" .Values.instance $id $deployment.instance) -}}
  {{- end -}}
  {{- $instance = $deployment.instance -}}
  {{- if ne $deployment.namespace .Release.Namespace -}}{{- fail (printf "deployments.%s.namespace %s does not match Helm namespace %s" $id $deployment.namespace .Release.Namespace) -}}{{- end -}}
  {{- if ne $deployment.release .Release.Name -}}{{- fail (printf "deployments.%s.release %s does not match Helm release %s" $id $deployment.release .Release.Name) -}}{{- end -}}
  {{- if not (hasKey .Values.services $instance) -}}{{- fail (printf "services.%s is required by deployments.%s.instance" $instance $id) -}}{{- end -}}
  {{- if not (kindIs "map" .Values.packages) -}}{{- fail "packages must be an object when deployment is selected" -}}{{- end -}}
  {{- if not (hasKey .Values.packages $deployment.package) -}}{{- fail (printf "packages.%s is required by deployments.%s.package" $deployment.package $id) -}}{{- end -}}
  {{- $package := index .Values.packages $deployment.package -}}
  {{- include "restic.validate" (dict "schema" $definitions.package "definitions" $definitions "value" $package "path" (printf "packages.%s" $deployment.package)) -}}
  {{- if ne $package.version .Chart.Version -}}{{- fail (printf "packages.%s.version selects %s but this chart is %s" $deployment.package $package.version .Chart.Version) -}}{{- end -}}
  {{- if hasKey .Values "operations" -}}
    {{- if not (kindIs "map" .Values.operations) -}}{{- fail "operations must be an object" -}}{{- end -}}
    {{- if hasKey .Values.operations "deployments" -}}
      {{- if not (kindIs "map" .Values.operations.deployments) -}}{{- fail "operations.deployments must be an object" -}}{{- end -}}
      {{- if hasKey .Values.operations.deployments $id -}}
        {{- $intent = index .Values.operations.deployments $id -}}
        {{- include "restic.validate" (dict "schema" $definitions.intent "definitions" $definitions "value" $intent "path" (printf "operations.deployments.%s" $id)) -}}
        {{- if or (hasKey $intent "running") (hasKey $intent "replicas") -}}{{- fail "Restic runtime intent belongs only to the ResticApplication CR" -}}{{- end -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- toYaml (dict "instance" $instance "intent" $intent) -}}
{{- end -}}

{{- define "restic.service" -}}
{{- $selection := include "restic.selection" . | fromYaml -}}
{{- $instance := $selection.instance -}}
{{- $selected := dict -}}
{{- if hasKey .Values.services $instance -}}{{- $selected = index .Values.services $instance -}}{{- end -}}
{{- $definitions := (mustFromJson (.Files.Get "interface.schema.json")).definitions -}}
{{- $path := printf "services.%s" $instance -}}
{{- include "restic.validate" (dict "schema" $definitions.service "definitions" $definitions "value" $selected "path" $path) -}}
{{- if and (hasKey $selected "release") (ne $selected.release .Chart.Version) -}}{{- fail (printf "%s.release selects %s but this chart is %s" $path $selected.release .Chart.Version) -}}{{- end -}}
{{- $service := mergeOverwrite (.Files.Get "defaults.yaml" | fromYaml) (deepCopy $selected) -}}
{{- if hasKey $selection.intent "ingressEnabled" -}}{{- $_ := set $service.ingress "enabled" $selection.intent.ingressEnabled -}}{{- end -}}
{{- if not (hasKey $service "hostname") -}}
  {{- $domain := required "dns.root is required when the selected Restic service has no hostname" (get (get .Values "dns" | default dict) "root") -}}
  {{- $_ := set $service "hostname" (printf "restic.%s" $domain) -}}
{{- end -}}
{{- $repos := dict -}}
{{- range $service.repositories -}}
  {{- if hasKey $repos .name -}}{{- fail "repository names must be unique" -}}{{- end -}}
  {{- $_ := set $repos .name true -}}
  {{- if not (hasKey . "authSecret") -}}{{- $_ := set . "authSecret" (printf "%s-repository-auth" .name) -}}{{- end -}}
  {{- if not (hasKey . "passwordSecret") -}}{{- $_ := set . "passwordSecret" (printf "%s-repository-key" .name) -}}{{- end -}}
{{- end -}}
{{- include "restic.validate" (dict "schema" $definitions.service "definitions" $definitions "value" $service "path" $path) -}}
{{- $copies := dict -}}
{{- $routes := dict -}}
{{- $name := include "bartl-restic.name" . -}}
{{- $localHosts := list (lower $service.hostname) $name (printf "%s.%s" $name .Release.Namespace) (printf "%s.%s.svc" $name .Release.Namespace) (printf "%s.%s.svc.cluster.local" $name .Release.Namespace) -}}
{{- range $service.replication -}}
  {{- if hasKey $copies .name -}}{{- fail "replication names must be unique" -}}{{- end -}}
  {{- $_ := set $copies .name true -}}
  {{- if not (hasKey $repos .repository) -}}{{- fail "replication.repository must name a declared repository" -}}{{- end -}}
  {{- $route := printf "%s|%s|%s" .repository (lower .destination.host) .destination.repository -}}
  {{- if hasKey $routes $route -}}{{- fail "replication source/destination pairs must be unique" -}}{{- end -}}
  {{- $_ := set $routes $route true -}}
  {{- if and (eq .repository .destination.repository) (has (lower .destination.host) $localHosts) -}}{{- fail "replication destination must not be the same local source repository" -}}{{- end -}}
{{- end -}}
{{- $maintenance := $service.maintenance -}}
{{- if eq $maintenance.action "forget-prune" -}}
  {{- if not (regexMatch "^[a-f0-9]{64}$" $maintenance.snapshot) -}}{{- fail "maintenance.snapshot must be a full 64-character snapshot ID for forget-prune" -}}{{- end -}}
{{- end -}}
{{- if $maintenance.enabled -}}
  {{- if not (hasKey $repos $maintenance.repository) -}}{{- fail "maintenance.repository must name a declared repository" -}}{{- end -}}
  {{- $_ := required "maintenance.host is required when enabled" $maintenance.host -}}
  {{- $_ := required "maintenance.credentialsSecret is required when enabled" $maintenance.credentialsSecret -}}
{{- end -}}
{{- toYaml $service -}}
{{- end -}}
