{{- define "bartl-restic.name" -}}
{{- printf "%s-restic" .Release.Name | trunc 20 | trimSuffix "-" -}}
{{- end -}}
