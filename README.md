# Bartlized Restic backend

<a id="service-and-state-boundary"></a>

Authenticated HTTPS repositories with append-only writers, scoped recovery readers, independent replication and automatic endpoint reconstruction. Applications own consistent capture and application recovery; this package owns repository storage access and native repository operations.

New endpoint: follow the recipe below. Existing endpoint: [resume access](#resume-an-existing-deployment), then choose an operation. Run workstation Bash, keep tracing off and stop at a failed command. Creation is not a replay or partial-state repair procedure.

## Prerequisites and release

Use the [operator tools](https://github.com/bartlapp/bartl-app/blob/main/docs/operator-workstation.md#check-the-workstation), plus native Restic 0.19.1 for workstation acceptance. Supply an amd64 Kubernetes cluster, registry egress, enforced NetworkPolicy and ReadWriteOnce storage with POSIX permissions, locking, atomic rename and fsync. Allocate repository, copy and reconstruction headroom. The default route needs Traefik's IngressRouteTCP CRD and websecure entrypoint, cert-manager, public ports 80/443 and authorized DNS. [Base](https://github.com/bartlapp/base-k3s/blob/main/README.md) supplies this single-node profile; an equivalent external cluster is sufficient.

Start with its version-1 installation record, complete resource references and retained cluster access. Base or the cluster administrator supplies these; do not initialize another record or merely add a version field to an old one. No company tooling, password store or other Bartl service is required.

This recipe uses published **0.3.0**, rest-server 0.14.0, nginx 1.28.0 and Restic 0.19.1. [Release evidence](https://github.com/bartlapp/bartl-restic/releases/tag/v0.3.0) identifies its immutable artifacts; this revised recipe has not renewed live qualification. The 0.2.x flat interface needs the explicit migration below. Do not pair this chart with an old controller image.

Choose the existing installation directory and obtain the archive. If independently retained, restore it to this path instead of pulling again:

```bash
set -euo pipefail
umask 077
export WORK_DIR="$HOME/bartl/acme/acme-installation"
export VALUES="$WORK_DIR/installation.yaml"
mkdir -p "$WORK_DIR/packages"
helm pull oci://ghcr.io/bartlapp/bartl-restic --version 0.3.0 --destination "$WORK_DIR/packages"
CHART="$WORK_DIR/packages/bartl-restic-0.3.0.tgz"
CHART_SHA256=57feb5b39b325e3972fe9a9c870cd6c0c5fe54f2f91faba8b4b1652fb4918253
printf '%s  %s\n' "$CHART_SHA256" "$CHART" | shasum -a 256 --check -
```

Retain the exact chart, pinned images, configuration, encrypted history and protected keys independently of the covered failure domain. Before relying on backups, agree data-loss/interruption limits, source retirement, primary/secondary retention, holds, capacity and responsibility for alerts, integrity checks and restore exercises. A schedule is not a recovery objective.

## Configure a new endpoint

Choose unused deployment, instance and package keys and a fresh namespace. These assignments replace only those entries and preserve unrelated installation content. The release name in this recipe is backup. A replacement retains the original instance and uses the recovery procedure instead.

```bash
export DEPLOYMENT=restic
export INSTANCE=restic
export CLUSTER_ID=cluster-1
export NS=backup
export RELEASE=backup
export PACKAGE=restic
export REPOSITORY=records
export CAPACITY=20Gi
export CHART_SHA256
yq -i '
  .deployments[strenv(DEPLOYMENT)] = {
    "instance": strenv(INSTANCE), "cluster": strenv(CLUSTER_ID),
    "namespace": strenv(NS), "release": strenv(RELEASE), "package": strenv(PACKAGE)
  } |
  .services[strenv(INSTANCE)] = {"repositories": [{"name": strenv(REPOSITORY)}]} |
  .packages[strenv(PACKAGE)] = {
    "version": "0.3.0", "chart": "oci://ghcr.io/bartlapp/bartl-restic",
    "chartSha256": strenv(CHART_SHA256)
  }
' "$VALUES"
```

For an idle endpoint, set the selected service's repositories to [] instead; skip repository credentials and file-round-trip acceptance. Idle endpoints serve trusted TLS with HTTP 404. To override hostname, claim, TLS or routing, set the [service inputs](#helm-inputs-and-connections) before rendering. External certificates require tls.managed: false throughout subsequent operations.

Read access and render the package's nonsecret declarations:

```bash
INSTANCE=$(yq -er '.deployments[strenv(DEPLOYMENT)].instance' "$VALUES")
CLUSTER_ID=$(yq -er '.deployments[strenv(DEPLOYMENT)].cluster' "$VALUES")
NS=$(yq -er '.deployments[strenv(DEPLOYMENT)].namespace' "$VALUES")
RELEASE=$(yq -er '.deployments[strenv(DEPLOYMENT)].release' "$VALUES")
PACKAGE=$(yq -er '.deployments[strenv(DEPLOYMENT)].package' "$VALUES")
export INSTANCE CLUSTER_ID PACKAGE
HELM_INSTANCE=${INSTANCE//./\\.}
KUBE_CONTEXT=$(yq -er '.clusters[strenv(CLUSTER_ID)].kubeconfig.context' "$VALUES")
export KUBECONFIG="$WORK_DIR/clusters/$CLUSTER_ID/base/kubeconfig"
# Replace only with an access file supplied for this selected cluster.
VERSION=$(yq -er '.packages[strenv(PACKAGE)].version' "$VALUES")
test "$VERSION" = 0.3.0
CHART="$WORK_DIR/packages/bartl-restic-$VERSION.tgz"
CHART_SHA256=$(yq -er '.packages[strenv(PACKAGE)].chartSha256' "$VALUES")
printf '%s  %s\n' "$CHART_SHA256" "$CHART" | shasum -a 256 --check -
INSTALL_DIR="$WORK_DIR/clusters/$CLUSTER_ID/applications/$INSTANCE"
if [ "$DEPLOYMENT" != "$INSTANCE" ]; then INSTALL_DIR="$INSTALL_DIR/deployments/$DEPLOYMENT"; fi
mkdir -p "$INSTALL_DIR"
REPLICAS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].replicas, .services[strenv(INSTANCE)].replicas, 1] | map(select(. != null)) | .[0]' "$VALUES")
INGRESS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].ingressEnabled, .services[strenv(INSTANCE)].ingress.enabled, true] | map(select(. != null)) | .[0]' "$VALUES")
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --set-string renderMode=connections \
  --show-only templates/connections.yaml > "$INSTALL_DIR/restic-connections.yaml"
RESTIC_HOST=$(yq -er '.services[strenv(INSTANCE)].endpoints.https.hostname' "$INSTALL_DIR/restic-connections.yaml")
TLS_SECRET=$(yq -er '.credentials.bindings[strenv(INSTANCE)].tls.secretName' "$INSTALL_DIR/restic-connections.yaml")
CLAIM=$(yq -er '.storage.claims[strenv(INSTANCE)].repository.claimName' "$INSTALL_DIR/restic-connections.yaml")
kubectl --context "$KUBE_CONTEXT" get nodes,storageclass
kubectl --context "$KUBE_CONTEXT" create namespace "$NS"
```

The selected cluster's access file is explicit, never inherited from another terminal target. Connection declarations are calculations, not proof of issued credentials or existing repositories.

Create the new claim using the selected capacity and default StorageClass:

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NS" create -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $CLAIM
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: $CAPACITY
EOF
kubectl --context "$KUBE_CONTEXT" -n "$NS" get pvc "$CLAIM"
```

WaitForFirstConsumer storage may remain Pending until scheduling. For retained-state reinstall, reuse the intact claim through that separate procedure; never attach another active installation's claim. The PVC and Secrets are operator-owned.

## Prepare DNS, TLS and repository credentials

Inspect the ingress address:

```bash
kubectl --context "$KUBE_CONTEXT" -n kube-system get service traefik -o wide
INGRESS_IPV4=$(kubectl --context "$KUBE_CONTEXT" -n kube-system get service traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
printf '%s -> %s\n' "$RESTIC_HOST" "$INGRESS_IPV4"
dig "$RESTIC_HOST" A +trace
dig @1.1.1.1 +short "$RESTIC_HOST" A
dig @8.8.8.8 +short "$RESTIC_HOST" A
```

Create the authorized A record at your DNS provider; inspect ownership before changing an existing record and correct conflicting AAAA records. Require authoritative and public answers reaching this ingress before certificate issuance. The package creates an ACME Issuer/Certificate by default; cert-manager renews it. Traefik passes TLS through to nginx, which owns repository authentication.

For external TLS only, supply its certificate/key and create the declared Secret. Keep external ownership in the service settings:

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret tls "$TLS_SECRET" \
  --cert="$INSTALL_DIR/tls/fullchain.pem" --key="$INSTALL_DIR/tls/key.pem"
```

For a genuinely new repository, supply a validating public/private CA bundle at INSTALL_DIR/protected/ca.crt, then generate its independent encryption key and three transport passwords once. For supplied or recovered credentials, restore these same files instead; never generate another key for existing history. Run in an empty repository input directory:

```bash
directory="$INSTALL_DIR/protected/repositories/$REPOSITORY"
mkdir -p "$directory"
(
  set -o noclobber
  for key in password writer.restPassword reader.restPassword admin.restPassword; do
    openssl rand -hex 32 | tr -d '\n' > "$directory/$key"
  done
  for role in writer reader admin; do
    printf '%s:%s\n' "$role" "$(openssl passwd -apr1 -stdin < "$directory/$role.restPassword")"
  done > "$directory/htpasswd"
)
```

Independently protect the files before creating runtime copies. Retain htpasswd as well as passwords: regenerating salted hashes or rotating inputs during admitted work triggers re-admission and can interrupt that work. Create the repository's declared Secrets:

```bash
directory="$INSTALL_DIR/protected/repositories/$REPOSITORY"
AUTH=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].authSecret' "$INSTALL_DIR/restic-connections.yaml")
KEY=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].passwordSecret' "$INSTALL_DIR/restic-connections.yaml")
ADMIN=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].adminSecret' "$INSTALL_DIR/restic-connections.yaml")
kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret generic "$AUTH" --from-file=htpasswd="$directory/htpasswd"
kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret generic "$KEY" --from-file=password="$directory/password"
printf admin > "$directory/admin.username"
kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret generic "$ADMIN" \
  --from-file=username="$directory/admin.username" --from-file=restPassword="$directory/admin.restPassword" \
  --from-file=password="$directory/password" --from-file=ca.crt="$INSTALL_DIR/protected/ca.crt"
```

The accounts are exactly writer, reader and admin, with different passwords for each repository and role. Writer may append but not overwrite/delete backup contents. Reader may read contents and create/delete exact native locks, not mutate backup data. Admin permits destructive maintenance and must not reach consumers. Native locks coordinate cooperative clients, not malicious credential holders. Never disable locking or blindly unlock after a failure.

For a **new secondary endpoint only**, give its repository a recovery source before first installation. Use a distinct instance, hostname, namespace and claim; its own key above remains independent. Supply primary reader files (`username`, `restPassword`, `password`, `ca.crt`), not primary admin access:

```bash
export RECOVERY_HOST=primary.example.org
export RECOVERY_REPOSITORY=records
export RECOVERY_INPUTS=/protected/primary/reader
export RECOVERY_SECRET="$REPOSITORY-primary-reader"
yq -i '(.services[strenv(INSTANCE)].repositories[] | select(.name == strenv(REPOSITORY))).recovery = {
  "host": strenv(RECOVERY_HOST), "repository": strenv(RECOVERY_REPOSITORY),
  "credentialsSecret": strenv(RECOVERY_SECRET)
}' "$VALUES"
kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret generic "$RECOVERY_SECRET" \
  --from-file="$RECOVERY_INPUTS/"
```

The native worker initializes with copied chunker parameters, copies history and verifies the destination. A failed lookup refuses startup; only confirmed empty history permits empty initialization. Existing intact local repositories do not consult this recovery source.

## Install and verify

For an idle endpoint, no repository credentials or CA input are needed. For a populated endpoint, the native worker initializes new repositories; do not run restic init yourself.

```bash
REPLICAS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].replicas, .services[strenv(INSTANCE)].replicas, 1] | map(select(. != null)) | .[0]' "$VALUES")
INGRESS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].ingressEnabled, .services[strenv(INSTANCE)].ingress.enabled, true] | map(select(. != null)) | .[0]' "$VALUES")
helm install "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.replicas=$REPLICAS" --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --wait=legacy --timeout=5m
if yq -e '.services[strenv(INSTANCE)].endpoints.https.tlsManaged' "$INSTALL_DIR/restic-connections.yaml" >/dev/null; then
  kubectl --context "$KUBE_CONTEXT" -n "$NS" wait "certificate/$TLS_SECRET" --for=condition=Ready --timeout=10m
fi
GENERATION=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o jsonpath='{.metadata.generation}')
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic \
  --for="jsonpath={.status.conditions[?(@.type==\"Ready\")].observedGeneration}=$GENERATION" --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Ready --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Ready" and .status == "True" and .observedGeneration == $g)'
JOB=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o jsonpath='{.status.operation.jobName}')
kubectl --context "$KUBE_CONTEXT" -n "$NS" logs "job/$JOB"
kubectl --context "$KUBE_CONTEXT" -n "$NS" get pods,service,certificate
```

Helm waits for controller infrastructure, not application acceptance. Require current-generation Ready and trusted HTTPS. For an idle endpoint, check HTTP 404 without disabling certificate verification:

```bash
curl --silent --show-error -o /dev/null -w '%{http_code}\n' "https://$RESTIC_HOST/"
```

For a populated endpoint, execute this native writer/reader round-trip. It checks repository access, not application-consistent capture:

```bash
(
  set -euo pipefail
  directory="$INSTALL_DIR/protected/repositories/$REPOSITORY"
  export RESTIC_REPOSITORY
  RESTIC_REPOSITORY=$(INSTANCE="$INSTANCE" yq -er \
    '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].repository' \
    "$INSTALL_DIR/restic-connections.yaml")
  export RESTIC_PASSWORD_FILE="$directory/password"
  export RESTIC_REST_USERNAME=writer
  export RESTIC_REST_PASSWORD="$(cat "$directory/writer.restPassword")"
  work=$(mktemp -d "$INSTALL_DIR/roundtrip.XXXXXX")
  printf 'Standalone backup acceptance\n' > "$work/input"
  restic --cacert "$INSTALL_DIR/protected/ca.crt" backup "$work/input" --json > "$work/backup.jsonl"
  snapshot=$(jq -ers '[.[] | select(.message_type == "summary")][0].snapshot_id' "$work/backup.jsonl")
  export RESTIC_REST_USERNAME=reader
  export RESTIC_REST_PASSWORD="$(cat "$directory/reader.restPassword")"
  restic --cacert "$INSTALL_DIR/protected/ca.crt" snapshots "$snapshot"
  restic --cacert "$INSTALL_DIR/protected/ca.crt" restore "$snapshot" --target "$work/restored"
  cmp "$work/input" "$work/restored${work}/input"
)
```

Keep the point until retention authorizes deletion. Hand consumers only their repository URL, encryption key, scoped reader/writer credentials and validating CA. Independently retain history and keys; reader transport credentials alone cannot decrypt it.

## Resume an existing deployment

Select the retained record and deployment in fresh Bash. Restore its exact archive first. This refreshes local declarations without changing configuration, credentials or cluster resources; do not run creation blocks.

```bash
set -euo pipefail
umask 077
export WORK_DIR="$HOME/bartl/acme/acme-installation"
export VALUES="$WORK_DIR/installation.yaml"
export DEPLOYMENT=restic
INSTANCE=$(yq -er '.deployments[strenv(DEPLOYMENT)].instance' "$VALUES")
CLUSTER_ID=$(yq -er '.deployments[strenv(DEPLOYMENT)].cluster' "$VALUES")
NS=$(yq -er '.deployments[strenv(DEPLOYMENT)].namespace' "$VALUES")
RELEASE=$(yq -er '.deployments[strenv(DEPLOYMENT)].release' "$VALUES")
PACKAGE=$(yq -er '.deployments[strenv(DEPLOYMENT)].package' "$VALUES")
export INSTANCE CLUSTER_ID PACKAGE
HELM_INSTANCE=${INSTANCE//./\\.}
KUBE_CONTEXT=$(yq -er '.clusters[strenv(CLUSTER_ID)].kubeconfig.context' "$VALUES")
export KUBECONFIG="$WORK_DIR/clusters/$CLUSTER_ID/base/kubeconfig"
# Replace only with an access file supplied for this selected cluster.
VERSION=$(yq -er '.packages[strenv(PACKAGE)].version' "$VALUES")
test "$VERSION" = 0.3.0
CHART="$WORK_DIR/packages/bartl-restic-$VERSION.tgz"
CHART_SHA256=$(yq -er '.packages[strenv(PACKAGE)].chartSha256' "$VALUES")
printf '%s  %s\n' "$CHART_SHA256" "$CHART" | shasum -a 256 --check -
INSTALL_DIR="$WORK_DIR/clusters/$CLUSTER_ID/applications/$INSTANCE"
if [ "$DEPLOYMENT" != "$INSTANCE" ]; then INSTALL_DIR="$INSTALL_DIR/deployments/$DEPLOYMENT"; fi
mkdir -p "$INSTALL_DIR"
REPLICAS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].replicas, .services[strenv(INSTANCE)].replicas, 1] | map(select(. != null)) | .[0]' "$VALUES")
INGRESS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].ingressEnabled, .services[strenv(INSTANCE)].ingress.enabled, true] | map(select(. != null)) | .[0]' "$VALUES")
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --set-string renderMode=connections \
  --show-only templates/connections.yaml > "$INSTALL_DIR/restic-connections.yaml"
RESTIC_HOST=$(yq -er '.services[strenv(INSTANCE)].endpoints.https.hostname' "$INSTALL_DIR/restic-connections.yaml")
TLS_SECRET=$(yq -er '.credentials.bindings[strenv(INSTANCE)].tls.secretName' "$INSTALL_DIR/restic-connections.yaml")
CLAIM=$(yq -er '.storage.claims[strenv(INSTANCE)].repository.claimName' "$INSTALL_DIR/restic-connections.yaml")
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o yaml
```

Version 0.3.0 consumes instance, not a deployment selector. The two retained deployment intents are passed as Helm overrides; explicit false/zero remain effective. Fresh-shell resumption reads them, never resets them.

## Stop and start

After resumption, export needed lifecycle/copy logs before stopping: cancellation deletes Jobs and their Pods. Keep other operators/reconcilers from changing intent during the operation.

```bash
yq -i '.operations.deployments[strenv(DEPLOYMENT)].replicas = 0' "$VALUES"
REPLICAS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].replicas, .services[strenv(INSTANCE)].replicas, 1] | map(select(. != null)) | .[0]' "$VALUES")
INGRESS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].ingressEnabled, .services[strenv(INSTANCE)].ingress.enabled, true] | map(select(. != null)) | .[0]' "$VALUES")
helm upgrade "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" --reset-values -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.replicas=$REPLICAS" --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --wait=legacy --timeout=5m
GENERATION=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o jsonpath='{.metadata.generation}')
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic \
  --for="jsonpath={.status.conditions[?(@.type==\"Stopped\")].observedGeneration}=$GENERATION" --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Stopped --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Stopped" and .status == "True" and .observedGeneration == $g)'
kubectl --context "$KUBE_CONTEXT" -n "$NS" get pods,jobs,cronjobs
```

Require no active endpoint, lifecycle or copy Pods. Stop withdraws serving, suspends copy admission and cancels active native work. Failed work remains failed; a stop request or unreachable API is not confirmed retirement. An already admitted endpoint can continue serving through API observation loss indefinitely; independent retirement is required if confirmed drainage is unavailable.

Start the same deployment again:

```bash
yq -i '.operations.deployments[strenv(DEPLOYMENT)].replicas = 1' "$VALUES"
REPLICAS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].replicas, .services[strenv(INSTANCE)].replicas, 1] | map(select(. != null)) | .[0]' "$VALUES")
INGRESS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].ingressEnabled, .services[strenv(INSTANCE)].ingress.enabled, true] | map(select(. != null)) | .[0]' "$VALUES")
helm upgrade "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" --reset-values -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.replicas=$REPLICAS" --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --wait=legacy --timeout=5m
GENERATION=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o jsonpath='{.metadata.generation}')
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic \
  --for="jsonpath={.status.conditions[?(@.type==\"Ready\")].observedGeneration}=$GENERATION" --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Ready --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Ready" and .status == "True" and .observedGeneration == $g)'
```

The controller observes and checks retained repositories again. Verify old-point restore and new backup. Ordinary process/controller restart while running uses retained state without reinitializing it or consulting recovery sources.

## Add a repository

Starting condition: a healthy resumed endpoint, no admitted work that must finish uninterrupted, and an unused repository name. Do not remove existing declarations: undeclared local history refuses re-admission, even for an otherwise idle endpoint.

```bash
export REPOSITORY=paperless
yq -i '.services[strenv(INSTANCE)].repositories += [{"name": strenv(REPOSITORY)}]' "$VALUES"
REPLICAS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].replicas, .services[strenv(INSTANCE)].replicas, 1] | map(select(. != null)) | .[0]' "$VALUES")
INGRESS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].ingressEnabled, .services[strenv(INSTANCE)].ingress.enabled, true] | map(select(. != null)) | .[0]' "$VALUES")
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --set-string renderMode=connections \
  --show-only templates/connections.yaml > "$INSTALL_DIR/restic-connections.yaml"
RESTIC_HOST=$(yq -er '.services[strenv(INSTANCE)].endpoints.https.hostname' "$INSTALL_DIR/restic-connections.yaml")
TLS_SECRET=$(yq -er '.credentials.bindings[strenv(INSTANCE)].tls.secretName' "$INSTALL_DIR/restic-connections.yaml")
CLAIM=$(yq -er '.storage.claims[strenv(INSTANCE)].repository.claimName' "$INSTALL_DIR/restic-connections.yaml")
directory="$INSTALL_DIR/protected/repositories/$REPOSITORY"
mkdir -p "$directory"
(
  set -o noclobber
  for key in password writer.restPassword reader.restPassword admin.restPassword; do
    openssl rand -hex 32 | tr -d '\n' > "$directory/$key"
  done
  for role in writer reader admin; do
    printf '%s:%s\n' "$role" "$(openssl passwd -apr1 -stdin < "$directory/$role.restPassword")"
  done > "$directory/htpasswd"
)
directory="$INSTALL_DIR/protected/repositories/$REPOSITORY"
AUTH=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].authSecret' "$INSTALL_DIR/restic-connections.yaml")
KEY=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].passwordSecret' "$INSTALL_DIR/restic-connections.yaml")
ADMIN=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].adminSecret' "$INSTALL_DIR/restic-connections.yaml")
kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret generic "$AUTH" --from-file=htpasswd="$directory/htpasswd"
kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret generic "$KEY" --from-file=password="$directory/password"
printf admin > "$directory/admin.username"
kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret generic "$ADMIN" \
  --from-file=username="$directory/admin.username" --from-file=restPassword="$directory/admin.restPassword" \
  --from-file=password="$directory/password" --from-file=ca.crt="$INSTALL_DIR/protected/ca.crt"
helm upgrade "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" --reset-values -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.replicas=$REPLICAS" --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --wait=legacy --timeout=5m
GENERATION=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o jsonpath='{.metadata.generation}')
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic \
  --for="jsonpath={.status.conditions[?(@.type==\"Ready\")].observedGeneration}=$GENERATION" --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Ready --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Ready" and .status == "True" and .observedGeneration == $g)'
```

Supply the validating CA before this operation if the endpoint was idle. Retain new credentials independently before enabling consumers. Native admission initializes the new repository and drains/reopens the endpoint; verify writer/reader access before handing it over. Rotation is a separate coordinated change, not rerunning credential generation.

## Connect an application

Use one declared repository per logical application. The [Keycloak](https://github.com/bartlapp/bartl-keycloak/blob/main/README.md) and [Paperless](https://github.com/bartlapp/bartl-paperless/blob/main/README.md) recipes own their installation, identity setup, capture and reconstruction. Retain each selected release's instructions; the historical composition was Keycloak 0.6.1 with Paperless 0.2.0, not the current Keycloak candidate.

With Restic resumed, choose the already declared repository and the consumer's actual working directory. Export only scoped files in the layout consumed by those recipes; the destination reader/writer directories must be new:

```bash
export REPOSITORY=paperless
export CONSUMER_DIR="$WORK_DIR/clusters/cluster-1/applications/paperless"
REPOSITORY_URL=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].repository' "$INSTALL_DIR/restic-connections.yaml")
printf '%s\n' "$REPOSITORY_URL"
for role in reader writer; do
  mkdir -p "$CONSUMER_DIR/repository/$role"
  printf '%s' "$role" > "$CONSUMER_DIR/repository/$role/username"
  cp "$INSTALL_DIR/protected/repositories/$REPOSITORY/$role.restPassword" "$CONSUMER_DIR/repository/$role/restPassword"
  cp "$INSTALL_DIR/protected/repositories/$REPOSITORY/password" "$CONSUMER_DIR/repository/$role/password"
  cp "$INSTALL_DIR/protected/ca.crt" "$CONSUMER_DIR/repository/$role/ca.crt"
done
```

Supply that declaration's URL as the consumer's direct backup.repository input and follow its runtime-Secret and backup procedure. This avoids duplicating consumer provisioning here. For an existing composed backup.endpoint binding, preserve it and refresh resolved.backup.bindings.<consumer> from the provider URL and consumer-declared readerSecret/writerSecret instead; do not mix contradictory destinations. Connection rendering never creates a repository or establishes protection.

<a id="replication-mechanism"></a>

## Scheduled replication

Starting condition: both endpoints are usable, with independent storage, credentials and TLS. For a new secondary, its repository recovery declaration selects the primary and primary reader credentials; automatic initialization copies chunker parameters and history into its own independent key. Once established, intact secondary startup needs no primary access. Never initialize an existing secondary manually.

On the resumed primary, choose an unused copy name, local repository, secondary host/repository and independently recovered destination input directory. The directory contains username (exactly writer), restPassword, password and ca.crt for the secondary. Keep secondary reader access independently too.

```bash
export COPY=secondary
export REPOSITORY=records
export SECONDARY_HOST=secondary.example.org
export SECONDARY_REPOSITORY=records
export SECONDARY_INPUTS=/protected/secondary/writer
export COPY_SCHEDULE='*/15 * * * *'
export COPY_SECRET="$REPOSITORY-replication-$COPY"
KEY=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].passwordSecret' "$INSTALL_DIR/restic-connections.yaml")
export KEY
yq -i '.services[strenv(INSTANCE)].replication += [{
  "name": strenv(COPY), "repository": strenv(REPOSITORY), "sourceCredentialsSecret": strenv(KEY),
  "destination": {"host": strenv(SECONDARY_HOST), "repository": strenv(SECONDARY_REPOSITORY), "credentialsSecret": strenv(COPY_SECRET)},
  "schedule": strenv(COPY_SCHEDULE), "timeZone": "Etc/UTC", "suspend": false, "activeDeadlineSeconds": 3600
}]' "$VALUES"
kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret generic "$COPY_SECRET" --from-file="$SECONDARY_INPUTS/"
REPLICAS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].replicas, .services[strenv(INSTANCE)].replicas, 1] | map(select(. != null)) | .[0]' "$VALUES")
INGRESS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].ingressEnabled, .services[strenv(INSTANCE)].ingress.enabled, true] | map(select(. != null)) | .[0]' "$VALUES")
helm upgrade "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" --reset-values -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.replicas=$REPLICAS" --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --wait=legacy --timeout=5m
GENERATION=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o jsonpath='{.metadata.generation}')
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic \
  --for="jsonpath={.status.conditions[?(@.type==\"Ready\")].observedGeneration}=$GENERATION" --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Ready --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Ready" and .status == "True" and .observedGeneration == $g)'
JOB="copy-$(date -u +%Y%m%d%H%M%S)"
kubectl --context "$KUBE_CONTEXT" -n "$NS" create job "$JOB" --from="cronjob/backup-restic-copy-$COPY"
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait "job/$JOB" --for=condition=complete --timeout=65m
kubectl --context "$KUBE_CONTEXT" -n "$NS" logs "job/$JOB"
```

Each run copies available history, skips native matching copies and never mirrors source deletions. Do not configure overlapping copies of the same source/destination pair or copy back to the same repository. Jobs use local source access, native source-read/destination-append locks, no retry/unlock and a configurable one-hour deadline. A generation change cancels old work; do not rotate mounted credentials during required work.

Require secondary full-data integrity checking and a restore of the selected point, not just Job success. Monitor the newest usable secondary point's original capture time, failed/overdue copies and capacity through an alert path outside the covered failure. Only complete, verified secondary history protects against primary loss. A successful no-op copy does not prove recent capture. Primary retention must cover the accepted replication outage; independently deleted secondary points may be copied again while still present at primary.

## Recover from the secondary

Consumers can recover directly from the surviving endpoint without rebuilding primary. Supply its reader/key/CA and select its full destination snapshot ID. Copy preserves tree and originating original metadata, not necessarily snapshot IDs; original can refer to an earlier copy source.

```bash
export SECONDARY_URL=rest:https://secondary.example.org/records/
export SECONDARY_INPUTS=/protected/secondary/reader
export RESTORE_DIR=/protected/restored-files
(
  export RESTIC_REPOSITORY="$SECONDARY_URL"
  export RESTIC_PASSWORD_FILE="$SECONDARY_INPUTS/password"
  export RESTIC_REST_USERNAME=$(cat "$SECONDARY_INPUTS/username")
  export RESTIC_REST_PASSWORD=$(cat "$SECONDARY_INPUTS/restPassword")
  restic --cacert "$SECONDARY_INPUTS/ca.crt" list snapshots
)
```

Choose the authorized full ID from that inventory, inspect it and restore:

```bash
export FULL_SNAPSHOT_ID=REPLACE_WITH_SELECTED_64_CHARACTER_ID
(
  export RESTIC_REPOSITORY="$SECONDARY_URL"
  export RESTIC_PASSWORD_FILE="$SECONDARY_INPUTS/password"
  export RESTIC_REST_USERNAME=$(cat "$SECONDARY_INPUTS/username")
  export RESTIC_REST_PASSWORD=$(cat "$SECONDARY_INPUTS/restPassword")
  restic --cacert "$SECONDARY_INPUTS/ca.crt" cat snapshot "$FULL_SNAPSHOT_ID"
  restic --cacert "$SECONDARY_INPUTS/ca.crt" restore "$FULL_SNAPSHOT_ID" --target "$RESTORE_DIR"
)
```

For application recovery, use the consumer's reconstruction procedure and verify its data/identity. A native file restore alone is not application acceptance. The presentation command snapshots --json can omit unreadable objects with a warning; use strict list/cat inventory when diagnosing damaged history.

## Replace an endpoint on fresh storage

Starting condition: independently retained configuration, exact 0.3.0 archive, original primary credentials and a verified usable secondary for every declared repository. Supply a target cluster, fresh namespace/claim and capacity. Authorize interruption, accepted loss, final-write handling and retirement first. A second namespace on the same host is not provider-loss protection.

For a reachable source, resume it, stop consumer publication and finish/verify final secondary copies before the endpoint stop. Preserve logs and confirm current-generation drainage. For a lost source, enforce retirement independently, including a returning predecessor; unreachability and DNS changes do not fence it. If retirement cannot be established, do not activate the target.

### Retire the reachable source

Skip this step only for an already retired/lost source with independently enforced retirement. Final required copies must already be verified; stop cancels active copies:

```bash
export SOURCE_DEPLOYMENT="$DEPLOYMENT"
export SOURCE_DIR="$INSTALL_DIR"
yq -i '.operations.deployments[strenv(DEPLOYMENT)].replicas = 0' "$VALUES"
REPLICAS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].replicas, .services[strenv(INSTANCE)].replicas, 1] | map(select(. != null)) | .[0]' "$VALUES")
INGRESS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].ingressEnabled, .services[strenv(INSTANCE)].ingress.enabled, true] | map(select(. != null)) | .[0]' "$VALUES")
helm upgrade "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" --reset-values -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.replicas=$REPLICAS" --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --wait=legacy --timeout=5m
GENERATION=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o jsonpath='{.metadata.generation}')
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic \
  --for="jsonpath={.status.conditions[?(@.type==\"Stopped\")].observedGeneration}=$GENERATION" --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Stopped --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Stopped" and .status == "True" and .observedGeneration == $g)'
kubectl --context "$KUBE_CONTEXT" -n "$NS" get pods,jobs,cronjobs
kubectl --context "$KUBE_CONTEXT" -n "$NS" get pvc -o json > "$SOURCE_DIR/source-pvc.json"
```

Require all endpoint/lifecycle/copy processes gone and prevent automation from restarting them. Keep the source claim intact. For a lost source, select SOURCE_DEPLOYMENT from the retained record and SOURCE_DIR from independently recovered inputs instead; no source cluster connection is needed.

### Prepare the target

Choose the target and the independently recovered secondary reader directory. Under SECONDARY_INPUTS, each repository has username, restPassword, password and ca.crt; these belong to the secondary, not the original primary. The example uses one surviving endpoint with matching repository names. For differently named destinations, retain each actual recovery.repository instead of assuming correspondence.

```bash
export DEPLOYMENT=restic-replacement
export TARGET_CLUSTER=cluster-2
export TARGET_NAMESPACE=backup-recovery
export CAPACITY=20Gi
export SECONDARY_HOST=secondary.example.org
export SECONDARY_INPUTS=/protected/secondary/readers
export SOURCE_DEPLOYMENT SOURCE_DIR
INSTANCE=$(yq -er '.deployments[strenv(SOURCE_DEPLOYMENT)].instance' "$VALUES")
PACKAGE=$(yq -er '.deployments[strenv(SOURCE_DEPLOYMENT)].package' "$VALUES")
export INSTANCE PACKAGE
yq -i '
  .deployments[strenv(DEPLOYMENT)] = {
    "instance": strenv(INSTANCE), "cluster": strenv(TARGET_CLUSTER),
    "namespace": strenv(TARGET_NAMESPACE), "release": "backup", "package": strenv(PACKAGE)
  } |
  .operations.deployments[strenv(DEPLOYMENT)] = {"replicas": 1, "ingressEnabled": true} |
  (.services[strenv(INSTANCE)].repositories[]) |= (.recovery = {
    "host": strenv(SECONDARY_HOST), "repository": .name, "credentialsSecret": (.name + "-secondary-reader")
  }) |
  (.services[strenv(INSTANCE)].replication[].suspend) = true
' "$VALUES"
INSTANCE=$(yq -er '.deployments[strenv(DEPLOYMENT)].instance' "$VALUES")
CLUSTER_ID=$(yq -er '.deployments[strenv(DEPLOYMENT)].cluster' "$VALUES")
NS=$(yq -er '.deployments[strenv(DEPLOYMENT)].namespace' "$VALUES")
RELEASE=$(yq -er '.deployments[strenv(DEPLOYMENT)].release' "$VALUES")
PACKAGE=$(yq -er '.deployments[strenv(DEPLOYMENT)].package' "$VALUES")
export INSTANCE CLUSTER_ID PACKAGE
HELM_INSTANCE=${INSTANCE//./\\.}
KUBE_CONTEXT=$(yq -er '.clusters[strenv(CLUSTER_ID)].kubeconfig.context' "$VALUES")
export KUBECONFIG="$WORK_DIR/clusters/$CLUSTER_ID/base/kubeconfig"
# Replace only with an access file supplied for this selected cluster.
VERSION=$(yq -er '.packages[strenv(PACKAGE)].version' "$VALUES")
test "$VERSION" = 0.3.0
CHART="$WORK_DIR/packages/bartl-restic-$VERSION.tgz"
CHART_SHA256=$(yq -er '.packages[strenv(PACKAGE)].chartSha256' "$VALUES")
printf '%s  %s\n' "$CHART_SHA256" "$CHART" | shasum -a 256 --check -
INSTALL_DIR="$WORK_DIR/clusters/$CLUSTER_ID/applications/$INSTANCE"
if [ "$DEPLOYMENT" != "$INSTANCE" ]; then INSTALL_DIR="$INSTALL_DIR/deployments/$DEPLOYMENT"; fi
mkdir -p "$INSTALL_DIR"
REPLICAS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].replicas, .services[strenv(INSTANCE)].replicas, 1] | map(select(. != null)) | .[0]' "$VALUES")
INGRESS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].ingressEnabled, .services[strenv(INSTANCE)].ingress.enabled, true] | map(select(. != null)) | .[0]' "$VALUES")
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --set-string renderMode=connections \
  --show-only templates/connections.yaml > "$INSTALL_DIR/restic-connections.yaml"
RESTIC_HOST=$(yq -er '.services[strenv(INSTANCE)].endpoints.https.hostname' "$INSTALL_DIR/restic-connections.yaml")
TLS_SECRET=$(yq -er '.credentials.bindings[strenv(INSTANCE)].tls.secretName' "$INSTALL_DIR/restic-connections.yaml")
CLAIM=$(yq -er '.storage.claims[strenv(INSTANCE)].repository.claimName' "$INSTALL_DIR/restic-connections.yaml")
kubectl --context "$KUBE_CONTEXT" get nodes,storageclass
kubectl --context "$KUBE_CONTEXT" create namespace "$NS"
kubectl --context "$KUBE_CONTEXT" -n "$NS" create -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $CLAIM
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: $CAPACITY
EOF
cp -R "$SOURCE_DIR/protected" "$INSTALL_DIR/protected"
while IFS= read -r REPOSITORY; do
  export REPOSITORY
  directory="$INSTALL_DIR/protected/repositories/$REPOSITORY"
  AUTH=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].authSecret' "$INSTALL_DIR/restic-connections.yaml")
  KEY=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].passwordSecret' "$INSTALL_DIR/restic-connections.yaml")
  ADMIN=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].adminSecret' "$INSTALL_DIR/restic-connections.yaml")
  kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret generic "$AUTH" --from-file=htpasswd="$directory/htpasswd"
  kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret generic "$KEY" --from-file=password="$directory/password"
  printf admin > "$directory/admin.username"
  kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret generic "$ADMIN" \
    --from-file=username="$directory/admin.username" --from-file=restPassword="$directory/admin.restPassword" \
    --from-file=password="$directory/password" --from-file=ca.crt="$INSTALL_DIR/protected/ca.crt"
  RECOVERY_SECRET=$(yq -er '.credentials.bindings[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].recovery.secretName' "$INSTALL_DIR/restic-connections.yaml")
  kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret generic "$RECOVERY_SECRET" \
    --from-file="$SECONDARY_INPUTS/$REPOSITORY/"
done < <(yq -r '.backup.providers[strenv(INSTANCE)].repositories | keys | .[]' "$INSTALL_DIR/restic-connections.yaml")
```

Use original primary encryption/authentication inputs for the reconstructed endpoint; never replace existing-history keys. Each recovery Secret supplies the secondary's separate reader/key/CA. Restore declared replication destination Secrets from their independently retained files before enabling their schedules; do not send admin credentials to copy workers.

Compare target PVC UID/backing PV against retained source identities: storage must be independent. Do not copy ownership annotations or failed-state markers. For external TLS, supply the target certificate/key covering the unchanged hostname:

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret tls "$TLS_SECRET" \
  --cert="$INSTALL_DIR/tls/fullchain.pem" --key="$INSTALL_DIR/tls/key.pem"
```

Skip that command for managed certificates. Source retirement must now be enforced. Point the authorized hostname to the target ingress, inspecting the existing RRset before changing it:

```bash
kubectl --context "$KUBE_CONTEXT" -n kube-system get service traefik -o wide
INGRESS_IPV4=$(kubectl --context "$KUBE_CONTEXT" -n kube-system get service traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
printf '%s -> %s\n' "$RESTIC_HOST" "$INGRESS_IPV4"
dig "$RESTIC_HOST" A +trace
dig @1.1.1.1 +short "$RESTIC_HOST" A
dig @8.8.8.8 +short "$RESTIC_HOST" A
```

Require authoritative/public DNS and no conflicting AAAA before managed issuance. Keep consumer publication stopped until acceptance. The target route is enabled so TLS and repository acceptance can run; the controller withholds repository serving until native reconstruction succeeds.

### Reconstruct and accept

```bash
helm install "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.replicas=$REPLICAS" --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --wait=legacy --timeout=5m
if yq -e '.services[strenv(INSTANCE)].endpoints.https.tlsManaged' "$INSTALL_DIR/restic-connections.yaml" >/dev/null; then
  kubectl --context "$KUBE_CONTEXT" -n "$NS" wait "certificate/$TLS_SECRET" --for=condition=Ready --timeout=10m
fi
GENERATION=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o jsonpath='{.metadata.generation}')
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic \
  --for="jsonpath={.status.conditions[?(@.type==\"Ready\")].observedGeneration}=$GENERATION" --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Ready --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Ready" and .status == "True" and .observedGeneration == $g)'
JOB=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o jsonpath='{.status.operation.jobName}')
kubectl --context "$KUBE_CONTEXT" -n "$NS" logs "job/$JOB" > "$INSTALL_DIR/reconstruction.log"
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json > "$INSTALL_DIR/reconstruction.json"
kubectl --context "$KUBE_CONTEXT" -n "$NS" get pvc -o json > "$INSTALL_DIR/target-pvc.json"
```

The worker copies chunker parameters and history, checks all destination data and verifies snapshot correspondence. Inspect the result against the authorized secondary inventory, restore an older point and compare contents, then perform a new writer/reader round-trip. Confirm reader/writer denial of destructive backup-content requests. A confirmed empty secondary permits initialization: Ready alone therefore does not prove recovery of expected history.

After acceptance, restore approved replication schedules/destination credentials and consumer publication. Record the active deployment, selected points, storage identities, observed recovery time and acceptance in the installation's existing operating record. Source stop intent remains unchanged. If the target may have accepted new writes, do not simply reactivate the predecessor; establish authoritative history and reconcile explicitly.

Failed or interrupted native work leaves the target failed across restart/stop/start. Retain diagnostics, then retry ordinary reconstruction on another independent empty claim. Never clear markers/status, steal a PVC binding, disable locks or blindly unlock. Intact repositories take metadata verification without contacting recovery; absent local state selects recovery, and failed lookup/integrity never means empty history. Native backend retries can run for 15 minutes per operation; client timeout does not cancel them.

## Migrate flat 0.2.1 inputs to 0.3.0

Retain the original flat values, exact chart/image, credentials and repository identities. Preserve release/namespace, PVC, all explicit Secret names and external TLS ownership. This is an explicit configuration migration, not --reuse-values or a compatibility shim.

In the installation record, move application.replicas to services.<instance>.replicas; move existingClaim, tlsSecret, repositories, replication and maintenance under that service. Set release to 0.3.0 if retaining the version assertion. Set tls.managed: false for external certificates and ingress.enabled: false when retaining an external TLS-preserving route. Retire old image overrides. Register the 0.3.0 archive/checksum and select the retained deployment; compare rendered URLs, claims and Secret bindings against the old installation before applying anything.

With the migrated target selected and its archive verified:

```bash
REPLICAS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].replicas, .services[strenv(INSTANCE)].replicas, 1] | map(select(. != null)) | .[0]' "$VALUES")
INGRESS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].ingressEnabled, .services[strenv(INSTANCE)].ingress.enabled, true] | map(select(. != null)) | .[0]' "$VALUES")
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --set-string renderMode=connections \
  --show-only templates/connections.yaml > "$INSTALL_DIR/restic-connections.yaml"
RESTIC_HOST=$(yq -er '.services[strenv(INSTANCE)].endpoints.https.hostname' "$INSTALL_DIR/restic-connections.yaml")
TLS_SECRET=$(yq -er '.credentials.bindings[strenv(INSTANCE)].tls.secretName' "$INSTALL_DIR/restic-connections.yaml")
CLAIM=$(yq -er '.storage.claims[strenv(INSTANCE)].repository.claimName' "$INSTALL_DIR/restic-connections.yaml")
kubectl --context "$KUBE_CONTEXT" apply -f <(helm show crds "$CHART")
helm upgrade "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" --reset-values -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.replicas=$REPLICAS" --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --wait=legacy --timeout=5m
GENERATION=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o jsonpath='{.metadata.generation}')
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic \
  --for="jsonpath={.status.conditions[?(@.type==\"Ready\")].observedGeneration}=$GENERATION" --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Ready --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Ready" and .status == "True" and .observedGeneration == $g)'
```

Helm installs a missing CRD but does not upgrade an existing one; review compatibility with other installations before applying it. Require unchanged repository identity/history, an older-point restore and a new backup. Never run another controller against the same claim. For the former endpoint-only chart, add each repository's passwordSecret first; Helm removes old endpoint resources and the controller recreates them after admission, with interruption.

Historical **0.2.0 must upgrade to 0.2.1 before application deletion**, using its [matching release procedure](https://github.com/bartlapp/bartl-restic/blob/v0.2.1/README.md#supported-uninstall) and retained flat file. The fixed controller must finalize the application while alive; a later upgrade cannot repair an already orphaned binding. Do not bypass finalizers or clear ownership annotations.

## Supported uninstall

Starting condition: resumed deployment, retained configuration/credentials/history, authorized removal and no concurrent intent writer. Export required logs first. Stop, verify drainage, delete the application while its controller is alive, then uninstall Helm:

```bash
yq -i '.operations.deployments[strenv(DEPLOYMENT)].replicas = 0' "$VALUES"
REPLICAS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].replicas, .services[strenv(INSTANCE)].replicas, 1] | map(select(. != null)) | .[0]' "$VALUES")
INGRESS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].ingressEnabled, .services[strenv(INSTANCE)].ingress.enabled, true] | map(select(. != null)) | .[0]' "$VALUES")
helm upgrade "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" --reset-values -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.replicas=$REPLICAS" --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --wait=legacy --timeout=5m
GENERATION=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o jsonpath='{.metadata.generation}')
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic \
  --for="jsonpath={.status.conditions[?(@.type==\"Stopped\")].observedGeneration}=$GENERATION" --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Stopped --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Stopped" and .status == "True" and .observedGeneration == $g)'
kubectl --context "$KUBE_CONTEXT" -n "$NS" get pods,jobs,cronjobs
```

Require no executing endpoint/lifecycle/copy Pods. An unavailable API or incomplete drain is not permission to remove the controller. Once confirmed:

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NS" delete resticapplication/backup-restic --wait=true --timeout=3m
helm uninstall "$RELEASE" --kube-context "$KUBE_CONTEXT" -n "$NS" --wait --timeout=3m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get pvc "$CLAIM"
kubectl --context "$KUBE_CONTEXT" -n "$NS" get secrets
```

Finalization releases only this application's claim binding after confirmed drainage. Ordinary stop retains ownership. PVC, data, Secrets and shared CRD survive supported uninstall; failed work keeps the claim fenced. A timeout requires inspection, not finalizer removal.

### Reinstall retained state

Only after successful finalization/uninstall, with the same intact claim/configuration/Secrets and no failed markers or competing owner:

```bash
yq -i '.operations.deployments[strenv(DEPLOYMENT)].replicas = 1' "$VALUES"
REPLICAS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].replicas, .services[strenv(INSTANCE)].replicas, 1] | map(select(. != null)) | .[0]' "$VALUES")
INGRESS=$(yq -r '[.operations.deployments[strenv(DEPLOYMENT)].ingressEnabled, .services[strenv(INSTANCE)].ingress.enabled, true] | map(select(. != null)) | .[0]' "$VALUES")
helm install "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.replicas=$REPLICAS" --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --wait=legacy --timeout=5m
GENERATION=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o jsonpath='{.metadata.generation}')
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic \
  --for="jsonpath={.status.conditions[?(@.type==\"Ready\")].observedGeneration}=$GENERATION" --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Ready --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Ready" and .status == "True" and .observedGeneration == $g)'
```

Require unchanged repository identity/history, an old-point restore and a new backup. Do not recreate credentials or storage. Namespace deletion is a separate destructive decision: it deletes retained PVCs/Secrets and may destroy their storage. Never delete the shared CRD as application cleanup. Remove only authorized DNS/infrastructure after data disposition; [Base teardown](https://github.com/bartlapp/base-k3s/blob/main/README.md#delete-the-entire-lab) is separate and destroys node-local data.

## Native maintenance

Resume the endpoint and select one declared repository. Pause conflicting consumer/copy work without stopping the endpoint; maintenance needs its HTTPS service. Choose a unique invocation name. The Job takes native exclusive locks and performs full check --read-data; it never unlocks or initializes implicitly:

```bash
export REPOSITORY=records
MAINTENANCE="check-$(date -u +%Y%m%d%H%M%S)"
ADMIN=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].adminSecret' "$INSTALL_DIR/restic-connections.yaml")
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.maintenance.enabled=true" \
  --set-string "services.$HELM_INSTANCE.maintenance.name=$MAINTENANCE" \
  --set-string "services.$HELM_INSTANCE.maintenance.repository=$REPOSITORY" \
  --set "services.$HELM_INSTANCE.maintenance.action=check" \
  --set-string "services.$HELM_INSTANCE.maintenance.host=$RESTIC_HOST" \
  --set-string "services.$HELM_INSTANCE.maintenance.credentialsSecret=$ADMIN" \
  --show-only templates/maintenance.yaml | kubectl --context "$KUBE_CONTEXT" -n "$NS" create -f -
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait "job/backup-restic-$MAINTENANCE" --for=condition=complete --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" logs "job/backup-restic-$MAINTENANCE"
```

The hostname must be reachable from the Job and covered by its validating CA. Keep admin credentials separate. For authorized deletion, inspect the complete selected point and applicable holds/retention first. Set FULL_SNAPSHOT_ID to its full 64-character ID, use a fresh name, action forget-prune and add --set-string "services.$HELM_INSTANCE.maintenance.snapshot=$FULL_SNAPSHOT_ID" to the same Job command. Retain Job/logs; a failed Job is not permission for blind replay or unlock. The package neither chooses retention points nor schedules deletion; primary and secondary policies remain independent.

## Helm inputs and connections

[interface.schema.json](chart/interface.schema.json) defines supported fields; [defaults.yaml](chart/defaults.yaml) supplies defaults. Omission restores defaults/derivation, maps merge by key, lists replace, and explicit false/zero remain effective. Unknown selected-service fields fail; unrelated services/resources remain untouched. Restic needs no resolved input.

| Input under services.<instance> | Default or purpose |
| --- | --- |
| hostname | restic.<dns.root>; explicit override wins |
| release | Optional assertion matching the selected chart version |
| replicas | 1; 0 stops endpoint and native work |
| existingClaim, tlsSecret | repository, repository-tls; operator-owned |
| tls.managed, tls.acmeServer | true, Let's Encrypt production; staging is not publicly trusted |
| ingress.enabled, ingress.entryPoint | true, websecure; disabling routing does not disable native TLS/authentication |
| repositories | []; each name derives <name>-repository-auth/key/admin bindings |
| repositories[].recovery | Surviving host, repository and reader credentialsSecret |
| replication | Independent destinations, schedules, suspension and deadlines |
| maintenance | Selected repository, admin credentials, check or one-point forget-prune |

Render declarations offline with the verified chart:

```bash
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string "services.$HELM_INSTANCE.release=$VERSION" \
  --set "services.$HELM_INSTANCE.ingress.enabled=$INGRESS" --set-string renderMode=connections \
  --show-only templates/connections.yaml > "$INSTALL_DIR/restic-connections.yaml"
RESTIC_HOST=$(yq -er '.services[strenv(INSTANCE)].endpoints.https.hostname' "$INSTALL_DIR/restic-connections.yaml")
TLS_SECRET=$(yq -er '.credentials.bindings[strenv(INSTANCE)].tls.secretName' "$INSTALL_DIR/restic-connections.yaml")
CLAIM=$(yq -er '.storage.claims[strenv(INSTANCE)].repository.claimName' "$INSTALL_DIR/restic-connections.yaml")
```

Declarations expose HTTPS endpoint flags/hostname, repository URLs and auth/key/admin Secret names, credential requirements/bindings and the operator-owned claim. Recovery and replication credentials require username/restPassword/password/ca.crt; authentication uses htpasswd; encryption uses password. No declaration creates credentials, repositories or application captures.

## Qualification and maintenance

Exact-artifact evidence remains with the [0.3.0 release](https://github.com/bartlapp/bartl-restic/releases/tag/v0.3.0). Historical [replication](evidence/2026-11-02-replication.json), [Kubernetes](evidence/2026-11-02-kubernetes.json), [endpoint authorization](evidence/2026-11-02-endpoint.json) and [native copy](evidence/2026-11-02-restic-copy.json) scenarios used independent PVCs in one cluster, not a cross-provider outage. They do not qualify this rewritten operating sequence. Maintainer test/publication procedures are in [AGENTS.md](AGENTS.md#qualification-and-test-output).

Original code/configuration use [Apache-2.0](LICENSE); documentation uses CC-BY-4.0 as stated in [NOTICE](NOTICE). Upstream components retain their own terms.

## Sources

- [Restic: copying repositories](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#copying-snapshots-between-repositories).
- [rest-server 0.14.0](https://github.com/restic/rest-server/blob/v0.14.0/README.md).
- [Restic 0.19.1 copy/locks](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/cmd_copy.go), [retry defaults](https://github.com/restic/restic/blob/v0.19.1/internal/global/global.go) and [strict object inventory](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/cmd_list.go).
