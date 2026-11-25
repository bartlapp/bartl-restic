# Bartlized Restic backend

<a id="service-and-state-boundary"></a>

Authenticated HTTPS repositories with append-only writers, scoped recovery readers, independent replication and automatic endpoint reconstruction. Applications own consistent capture and application recovery; this package owns repository storage access and native repository operations.

New endpoint: follow the recipe below. Existing endpoint: [resume access](#resume-an-existing-deployment), then choose an operation. Run workstation Bash, keep tracing off and stop at a failed command. Creation is not a replay or partial-state repair procedure.

- [Install a new endpoint](#prerequisites-and-release)
- [Resume an existing deployment](#resume-an-existing-deployment)
- [Stop and start](#stop-and-start)
- [Add a repository](#add-a-repository) and [connect an application](#connect-an-application)
- [Replicate](#scheduled-replication), [recover files](#recover-from-the-secondary) or [replace the endpoint](#replace-an-endpoint-on-fresh-storage)
- [Remove/reinstall](#supported-uninstall) and [maintain repositories](#native-maintenance)

## Prerequisites and release

Use the [operator tools](https://github.com/bartlapp/bartl-app/blob/main/docs/operator-workstation.md#check-the-workstation). Repository acceptance and manual file recovery need native Restic 0.19.1 and jq on an operator-controlled verification/recovery host, not necessarily the workstation. That host needs HTTPS access, scoped repository inputs, a validating CA bundle and writable working/cache directories. Supply an amd64 Kubernetes cluster, registry egress, enforced NetworkPolicy and ReadWriteOnce storage with POSIX permissions, locking, atomic rename and fsync. Allocate repository, copy and reconstruction headroom. The default route needs Traefik's IngressRouteTCP CRD and websecure entrypoint, cert-manager, public ports 80/443 and authorized DNS. [Base](https://github.com/bartlapp/base-k3s/blob/main/README.md) supplies this single-node profile; an equivalent external cluster is sufficient.

Start with its version-1 installation record, complete resource references and retained cluster access. Base or the cluster administrator supplies these; do not initialize another record or merely add a version field to an old one. No company tooling, password store or other Bartl service is required.

Release **[0.3.1](https://github.com/bartlapp/bartl-restic/releases/tag/v0.3.1)** adds deployment selection. The commands below require that interface, absent from [0.3.0](https://github.com/bartlapp/bartl-restic/releases/tag/v0.3.0). The package uses the unchanged rest-server 0.14.0, nginx 1.28.0 and Restic 0.19.1 runtime.

Use direnv-hooked Bash and the prepared cluster directory. For an external cluster, use the shared [supplied cluster access](https://github.com/bartlapp/bartl-app/blob/main/docs/operator-workstation.md#use-supplied-cluster-access) procedure; no Hetzner machine fields are needed.

Select the prepared cluster directory:

```bash
cd "${WORK_DIR_ROOT:-$HOME/bartl}/acme/acme-installation/clusters/cluster-1"
```

Acquire the latest stable chart. Helm excludes prereleases by default:

```bash
set -euo pipefail
umask 077
mkdir -p "$WORK_DIR/packages"
CHART_STAGE=$(mktemp -d "$WORK_DIR/packages/.restic.XXXXXX")
helm pull oci://ghcr.io/bartlapp/bartl-restic --untar --untardir "$CHART_STAGE"
export PACKAGE_VERSION
PACKAGE_VERSION=$(helm show chart "$CHART_STAGE/bartl-restic" | yq -er '.version')
```

The registry supplies immutable charts and pinned images; the local chart cache is disposable. Retain configuration, encrypted history and protected keys independently of the covered failure domain. Before relying on backups, agree data-loss/interruption limits, source retirement, primary/secondary retention, holds, capacity and responsibility for alerts, integrity checks and restore exercises. A schedule is not a recovery objective.

## Configure a new endpoint

Choose unused deployment and instance keys and a fresh namespace. Reuse a package key only when its recorded chart and version match the acquired artifact; otherwise choose an unused package key. These assignments preserve unrelated installation content. The release name in this recipe is backup. A replacement retains the original instance and uses the recovery procedure instead.

```bash
{
export DEPLOYMENT=restic
export INSTANCE=restic
export NS=backup
export RELEASE=backup
export PACKAGE=restic
export REPOSITORY=records
export CAPACITY=20Gi
yq -e '.packages[strenv(PACKAGE)] == null or
  (.packages[strenv(PACKAGE)].version == strenv(PACKAGE_VERSION) and
   .packages[strenv(PACKAGE)].chart == "oci://ghcr.io/bartlapp/bartl-restic")' "$VALUES" >/dev/null
yq -i '
  .deployments[strenv(DEPLOYMENT)] = {
    "instance": strenv(INSTANCE), "cluster": strenv(CLUSTER_ID),
    "namespace": strenv(NS), "release": strenv(RELEASE), "package": strenv(PACKAGE)
  } |
  .services[strenv(INSTANCE)] = {"repositories": [{"name": strenv(REPOSITORY)}]} |
  .packages[strenv(PACKAGE)] = (.packages[strenv(PACKAGE)] // {
    "version": strenv(PACKAGE_VERSION), "chart": "oci://ghcr.io/bartlapp/bartl-restic"
  })
' "$VALUES"
DEPLOYMENT_DIR="$WORK_DIR/clusters/$CLUSTER_ID/applications/$INSTANCE"
CLUSTER_ENV=../../.envrc
if [ "$DEPLOYMENT" != "$INSTANCE" ]; then
  DEPLOYMENT_DIR="$DEPLOYMENT_DIR/deployments/$DEPLOYMENT"
  CLUSTER_ENV=../../../../.envrc
fi
mkdir -p "$DEPLOYMENT_DIR" "$WORK_DIR/packages/$PACKAGE"
(
  set -o noclobber
  printf 'source_env %s\nload_deployment "%s"\n' "$CLUSTER_ENV" "$DEPLOYMENT" > "$DEPLOYMENT_DIR/.envrc"
)
if [ ! -d "$WORK_DIR/packages/$PACKAGE/$PACKAGE_VERSION" ]; then
  mv "$CHART_STAGE/bartl-restic" "$WORK_DIR/packages/$PACKAGE/$PACKAGE_VERSION"
fi
rm -r "$CHART_STAGE"
direnv allow "$DEPLOYMENT_DIR"
cd "$DEPLOYMENT_DIR"
}
```

For an idle endpoint, set the selected service's repositories to [] instead; skip repository credentials and file-round-trip acceptance. Idle endpoints serve trusted TLS with HTTP 404. To override hostname, claim, TLS or routing, set the [service inputs](#helm-inputs-and-connections) before rendering. External certificates require tls.managed: false throughout subsequent operations.

Wait for the next prompt: the selector loads the recorded deployment and normalized `CHART` path. The grouped setup above records choices and enters their directory before direnv reloads. Render the package's nonsecret declarations:

```bash
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" --set-string renderMode=connections \
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
helm install "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" --wait=legacy --timeout=5m
if yq -e '.services[strenv(INSTANCE)].endpoints.https.tlsManaged' "$INSTALL_DIR/restic-connections.yaml" >/dev/null; then
  kubectl --context "$KUBE_CONTEXT" -n "$NS" wait "certificate/$TLS_SECRET" --for=condition=Ready --timeout=10m
fi
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

### Verify repository access from a client

For a populated endpoint, run this round-trip on the selected verification host. It checks the public HTTPS interface, not application-consistent capture. Never substitute direct access to the backend's volume. The [reference walkthrough](https://github.com/bartlapp/bartl-app/blob/main/docs/reference-installation/applications.md#verify-a-repository-from-a) prepares A as this client.

Supply that repository's `password`, `writer.restPassword`, `reader.restPassword` and `ca.crt` in a protected directory on the client. Do not transfer repository-admin credentials. Select its URL from the endpoint's declaration and the absolute client input directory. If the calling procedure already supplies these variables, keep them instead of the examples:

```bash
export REPOSITORY_URL=rest:https://restic.acme.fke.systems/keycloak/
export REPOSITORY_INPUTS="$HOME/bartl-verification/keycloak"
```

On that client, execute:

```bash
(
  set -euo pipefail
  umask 077
  directory="$REPOSITORY_INPUTS"
  export RESTIC_REPOSITORY="$REPOSITORY_URL"
  export RESTIC_PASSWORD_FILE="$directory/password"
  export RESTIC_REST_USERNAME=writer
  export RESTIC_REST_PASSWORD="$(cat "$directory/writer.restPassword")"
  work=$(mktemp -d "$directory/roundtrip.XXXXXX")
  printf 'Standalone backup acceptance\n' > "$work/input"
  restic --cacert "$directory/ca.crt" backup "$work/input" --json > "$work/backup.jsonl"
  snapshot=$(jq -ers '[.[] | select(.message_type == "summary")][0].snapshot_id' "$work/backup.jsonl")
  export RESTIC_REST_USERNAME=reader
  export RESTIC_REST_PASSWORD="$(cat "$directory/reader.restPassword")"
  restic --cacert "$directory/ca.crt" snapshots "$snapshot"
  restic --cacert "$directory/ca.crt" restore "$snapshot" --target "$work/restored"
  cmp "$work/input" "$work/restored${work}/input"
  rm -r "$work"
)
```

Keep the point until retention authorizes deletion. Hand consumers only their repository URL, encryption key, scoped reader/writer credentials and validating CA. Independently retain history and keys; reader transport credentials alone cannot decrypt it.

Return to the workstation's selected deployment for package operations. Application capture/reconstruction and backend maintenance use their packaged native workers; they do not require a workstation Restic installation.

### Retain operating and recovery inputs

Keep `installation.yaml` and the deployment selector. Protect the following files independently of the endpoint; runtime Kubernetes Secrets are copies, not their sole custody:

| Files relative to `INSTALL_DIR` | Scope and consumer |
| --- | --- |
| `protected/repositories/<name>/password` | Instance-wide repository encryption key; native workers and scoped consumers. |
| `protected/repositories/<name>/{htpasswd,writer.restPassword,reader.restPassword,admin.restPassword}` | Instance-wide authentication; retain the existing hashes. Admin authority stays with endpoint maintenance. |
| `protected/ca.crt` | Trust bundle used by native clients and credential Secrets. |
| `tls/{fullchain.pem,key.pem}` | Deployment TLS inputs when external certificates are selected; managed certificates are issued on the target. |

Keep independently supplied recovery-reader and replication-writer input directories with their retained Secret references too. Retrieve the original repository keys/passwords before replacement or reinstall; never regenerate them to make a missing input disappear. Keep chart caches, rendered declarations, logs and plaintext files out of Git. Retain temporary receipts needed by an active operation, not a permanent installation success log.

## Resume an existing deployment

### Load retained context

In direnv-hooked Bash, enter the actual retained deployment directory. A replacement uses its nested `applications/<instance>/deployments/<deployment>` directory.

```bash
cd "${WORK_DIR_ROOT:-$HOME/bartl}/acme/acme-installation/clusters/cluster-1/applications/restic"
```

At the next prompt, the selector has loaded the retained deployment and cluster access. It does not acquire a chart or render package declarations.

```bash
set -euo pipefail
umask 077
```

### Inspect an installed endpoint

After loading context, inspect the live application when it is expected to exist. This needs cluster access, not the package chart:

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o yaml
```

A missing resource during ordinary operation is an error, not permission to initialize or reinstall it. For deliberate retained-state reinstall, continue at [Reinstall retained state](#reinstall-retained-state) without this inspection.

### Prepare chart-backed operations

After [loading retained context](#load-retained-context), reacquire the recorded package only if its cache is absent, then refresh its connection declarations. Run this preparation for the selected deployment before the Helm/declaration operations below; it creates no credentials, claims or cluster resources. Restore protected files from independent custody only for operations that need them.

```bash
if [ ! -d "$CHART" ]; then
  mkdir -p "$WORK_DIR/packages/$PACKAGE"
  CHART_STAGE=$(mktemp -d "$WORK_DIR/packages/.restic.XXXXXX")
  helm pull "$CHART_REF" --version "$PACKAGE_VERSION" --untar --untardir "$CHART_STAGE"
  mv "$CHART_STAGE/bartl-restic" "$CHART"
  rm -r "$CHART_STAGE"
fi
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" --set-string renderMode=connections \
  --show-only templates/connections.yaml > "$INSTALL_DIR/restic-connections.yaml"
RESTIC_HOST=$(yq -er '.services[strenv(INSTANCE)].endpoints.https.hostname' "$INSTALL_DIR/restic-connections.yaml")
TLS_SECRET=$(yq -er '.credentials.bindings[strenv(INSTANCE)].tls.secretName' "$INSTALL_DIR/restic-connections.yaml")
CLAIM=$(yq -er '.storage.claims[strenv(INSTANCE)].repository.claimName' "$INSTALL_DIR/restic-connections.yaml")
```

The selected 0.3.1 chart resolves the retained deployment, checks its namespace, release and package version against Helm, and applies only its recorded operation intent to the selected service. This also keeps connection declarations aligned with runtime, including explicit false/zero. Direct `instance` selection remains available for standalone values without a deployment record. Repeat this preparation after switching deployments; package-local declaration files are refreshed here, not by the context loader.

Continue with the selected operation.

## Stop and start

First [prepare chart-backed operations](#prepare-chart-backed-operations). Export needed lifecycle/copy logs before stopping: cancellation deletes Jobs and their Pods. Keep other operators/reconcilers from changing intent during the operation.

```bash
yq -i '.operations.deployments[strenv(DEPLOYMENT)].replicas = 0' "$VALUES"
helm upgrade "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" --reset-values -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" --wait=legacy --timeout=5m
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
helm upgrade "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" --reset-values -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" --wait=legacy --timeout=5m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Ready --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Ready" and .status == "True" and .observedGeneration == $g)'
```

The controller observes and checks retained repositories again. Ordinary process/controller restart while running uses retained state without reinitializing it or consulting recovery sources.

## Add a repository

Starting condition: a healthy endpoint with [chart-backed operations prepared](#prepare-chart-backed-operations), no admitted work that must finish uninterrupted, and an unused repository name. Do not remove existing declarations: undeclared local history refuses re-admission, even for an otherwise idle endpoint.

If the endpoint was idle, supply the validating CA bundle at `"$INSTALL_DIR/protected/ca.crt"` before running the commands below.

```bash
export REPOSITORY=paperless
yq -i '.services[strenv(INSTANCE)].repositories += [{"name": strenv(REPOSITORY)}]' "$VALUES"
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" --set-string renderMode=connections \
  --show-only templates/connections.yaml > "$INSTALL_DIR/restic-connections.yaml"
RESTIC_HOST=$(yq -er '.services[strenv(INSTANCE)].endpoints.https.hostname' "$INSTALL_DIR/restic-connections.yaml")
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
  --set-string deployment="$DEPLOYMENT" --wait=legacy --timeout=5m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Ready --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Ready" and .status == "True" and .observedGeneration == $g)'
```

Retain new credentials independently before enabling consumers. Native admission initializes the new repository and drains/reopens the endpoint; verify writer/reader access before handing it over. Rotation is a separate coordinated change, not rerunning credential generation.

## Connect an application

Use one declared repository per logical application. The [Keycloak](https://github.com/bartlapp/bartl-keycloak/blob/main/README.md) and [Paperless](https://github.com/bartlapp/bartl-paperless/blob/main/README.md) recipes own their installation, identity setup, capture and reconstruction. Follow the instructions applicable to each selected release.

First [prepare chart-backed operations](#prepare-chart-backed-operations) for Restic, then choose the already declared repository and the consumer's actual working directory. Export only scoped files in the layout consumed by those recipes; the destination reader/writer directories must be new:

```bash
export REPOSITORY=paperless
export CONSUMER_DIR="$WORK_DIR/clusters/cluster-1/applications/paperless"
REPOSITORY_URL=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].repository' "$INSTALL_DIR/restic-connections.yaml")
printf '%s\n' "$REPOSITORY_URL"
mkdir -p "$CONSUMER_DIR/repository"
for role in reader writer; do
  mkdir "$CONSUMER_DIR/repository/$role"
  printf '%s' "$role" > "$CONSUMER_DIR/repository/$role/username"
  cp "$INSTALL_DIR/protected/repositories/$REPOSITORY/$role.restPassword" "$CONSUMER_DIR/repository/$role/restPassword"
  cp "$INSTALL_DIR/protected/repositories/$REPOSITORY/password" "$CONSUMER_DIR/repository/$role/password"
  cp "$INSTALL_DIR/protected/ca.crt" "$CONSUMER_DIR/repository/$role/ca.crt"
done
```

Supply that declaration's URL as the consumer's `backup.repository` input and follow its runtime-Secret and backup procedure. The consumer owns capture and reconstruction; this handoff creates neither an application backup nor a new repository.

<a id="replication-mechanism"></a>

## Scheduled replication

Starting condition: both endpoints are usable, with independent storage, credentials and TLS. For a new secondary, its repository recovery declaration selects the primary and primary reader credentials; automatic initialization copies chunker parameters and history into its own independent key. Once established, intact secondary startup needs no primary access. Never initialize an existing secondary manually.

On the primary, first [prepare chart-backed operations](#prepare-chart-backed-operations), then choose an unused copy name, local repository, secondary host/repository and independently recovered destination input directory. The directory contains username (exactly writer), restPassword, password and ca.crt for the secondary. Keep secondary reader access independently too.

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
helm upgrade "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" --reset-values -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" --wait=legacy --timeout=5m
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

Run the following on the selected recovery host with native Restic 0.19.1 and its independently supplied reader files. The paths are on that host, not implicitly on the operator's laptop. Ordinary application reconstruction remains owned by its package.

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

Starting condition: independently retained configuration, original primary credentials and a verified usable secondary for every declared repository. Supply a target cluster, fresh namespace/claim and capacity. Authorize interruption, accepted loss, final-write handling and retirement first. A second namespace on the same host is not provider-loss protection. Acquire the target package before interrupting the source; use its supported native transition, not an assumed downgrade path.

For a reachable source, [prepare its chart-backed operations](#prepare-chart-backed-operations), stop consumer publication and finish/verify final secondary copies before the endpoint stop. Preserve logs and confirm current-generation drainage. For a lost source, enforce retirement independently, including a returning predecessor; unreachability and DNS changes do not fence it. If retirement cannot be established, do not activate the target.

Acquire the latest stable release while the source remains selected. Reuse a matching package entry; select an unused key only for a different artifact:

```bash
export TARGET_PACKAGE=restic-replacement
mkdir -p "$WORK_DIR/packages"
TARGET_STAGE=$(mktemp -d "$WORK_DIR/packages/.restic.XXXXXX")
helm pull oci://ghcr.io/bartlapp/bartl-restic --untar --untardir "$TARGET_STAGE"
export TARGET_VERSION
TARGET_VERSION=$(helm show chart "$TARGET_STAGE/bartl-restic" | yq -er '.version')
MATCHING_PACKAGE=$(yq -o=json '.packages // {}' "$VALUES" |
  jq -r --arg version "$TARGET_VERSION" '[to_entries[] |
    select(.value.chart == "oci://ghcr.io/bartlapp/bartl-restic" and .value.version == $version) | .key][0] // empty')
if [ -n "$MATCHING_PACKAGE" ]; then TARGET_PACKAGE="$MATCHING_PACKAGE"; fi
```

### Retire the reachable source

Skip this step only for an already retired/lost source with independently enforced retirement. Final required copies must already be verified; stop cancels active copies:

```bash
export SOURCE_DEPLOYMENT="$DEPLOYMENT"
export SOURCE_DIR="$INSTALL_DIR"
yq -i '
  .operations.deployments[strenv(DEPLOYMENT)].replicas = 0 |
  .operations.deployments[strenv(DEPLOYMENT)].ingressEnabled = false
' "$VALUES"
helm upgrade "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" --reset-values -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" --wait=legacy --timeout=5m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait ingressroutetcp/backup-restic \
  --for=delete --timeout=5m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Stopped --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Stopped" and .status == "True" and .observedGeneration == $g)'
kubectl --context "$KUBE_CONTEXT" -n "$NS" get pods,jobs,cronjobs
kubectl --context "$KUBE_CONTEXT" -n "$NS" get pvc -o json > "$SOURCE_DIR/source-pvc.json"
```

Require the source route absent and all endpoint/lifecycle/copy processes gone before target activation; prevent automation from restarting them. Keep the source claim intact. For a lost source, enter the retained installation root and select the source key and independently recovered local input directory explicitly:

```bash
export SOURCE_DEPLOYMENT=restic
export SOURCE_DIR="$WORK_DIR/clusters/cluster-1/applications/restic"
```

Its `protected/` files must already be restored from independent custody. No source API connection is needed. These assignments replace the source-retirement block only when retirement is already independently enforced.

### Prepare the target

Choose the target and independently recovered secondary reader directory. Under `SECONDARY_INPUTS`, each local repository name selects a directory containing the surviving endpoint's `username`, `restPassword`, `password` and `ca.crt`.

Before creating the target, inspect the retained repository and replication destinations:

```bash
INSTANCE=$(yq -er '.deployments[strenv(SOURCE_DEPLOYMENT)].instance' "$VALUES")
export INSTANCE
yq '.services[strenv(INSTANCE)] | {repositories, replication}' "$VALUES"
```

For every repository, keep its existing `recovery` binding if it already identifies the selected surviving history and reader Secret. For a missing binding or an intentionally changed source, select the actual destination below. Read host and repository from the retained replication destination or the surviving endpoint's supplied inventory; do not derive the remote repository name from the local name. Repeat only for repositories whose binding needs selection:

```bash
export REPOSITORY=records
export RECOVERY_HOST=secondary.example.org
export RECOVERY_REPOSITORY=records-secondary
export RECOVERY_SECRET=records-secondary-reader
yq -e '.services[strenv(INSTANCE)].repositories[] | select(.name == strenv(REPOSITORY))' "$VALUES"
yq -i '(.services[strenv(INSTANCE)].repositories[] | select(.name == strenv(REPOSITORY))).recovery = {
  "host": strenv(RECOVERY_HOST), "repository": strenv(RECOVERY_REPOSITORY),
  "credentialsSecret": strenv(RECOVERY_SECRET)
}' "$VALUES"
```

Verify reader access to each selected history through [Recover from the secondary](#recover-from-the-secondary), using that binding and its protected reader files. The target block below consumes these retained choices unchanged. Keep replication configuration unchanged until this replacement finishes.

```bash
{
export DEPLOYMENT=restic-replacement
export TARGET_CLUSTER=cluster-2
export TARGET_NAMESPACE=backup-recovery
export CAPACITY=20Gi
export SECONDARY_INPUTS=/protected/secondary/readers
export SOURCE_DEPLOYMENT SOURCE_DIR
INSTANCE=$(yq -er '.deployments[strenv(SOURCE_DEPLOYMENT)].instance' "$VALUES")
export INSTANCE
TARGET_DIR="$WORK_DIR/clusters/$TARGET_CLUSTER/applications/$INSTANCE/deployments/$DEPLOYMENT"
mkdir -p "$TARGET_DIR" "$WORK_DIR/packages/$TARGET_PACKAGE"
export REPLICATION_BEFORE="$SOURCE_DIR/replication-before-replacement.yaml"
if [ ! -e "$REPLICATION_BEFORE" ]; then
  (
    set -o noclobber
    yq '.services[strenv(INSTANCE)] | pick(["replication"])' "$VALUES" > "$REPLICATION_BEFORE"
  )
fi
yq -e '.packages[strenv(TARGET_PACKAGE)] == null or
  (.packages[strenv(TARGET_PACKAGE)].version == strenv(TARGET_VERSION) and
   .packages[strenv(TARGET_PACKAGE)].chart == "oci://ghcr.io/bartlapp/bartl-restic")' "$VALUES" >/dev/null
yq -i '
  .deployments[strenv(DEPLOYMENT)] = {
    "instance": strenv(INSTANCE), "cluster": strenv(TARGET_CLUSTER),
    "namespace": strenv(TARGET_NAMESPACE), "release": "backup", "package": strenv(TARGET_PACKAGE)
  } |
  .packages[strenv(TARGET_PACKAGE)] = (.packages[strenv(TARGET_PACKAGE)] // {
    "version": strenv(TARGET_VERSION), "chart": "oci://ghcr.io/bartlapp/bartl-restic"
  }) |
  .operations.deployments[strenv(DEPLOYMENT)] = {"replicas": 1, "ingressEnabled": true} |
  (.services[strenv(INSTANCE)].replication[]?.suspend) = true
' "$VALUES"
(
  set -o noclobber
  printf 'source_env ../../../../.envrc\nload_deployment "%s"\n' "$DEPLOYMENT" > "$TARGET_DIR/.envrc"
)
if [ ! -d "$WORK_DIR/packages/$TARGET_PACKAGE/$TARGET_VERSION" ]; then
  mv "$TARGET_STAGE/bartl-restic" "$WORK_DIR/packages/$TARGET_PACKAGE/$TARGET_VERSION"
fi
rm -r "$TARGET_STAGE"
direnv allow "$TARGET_DIR"
cd "$TARGET_DIR"
}
```

At the next prompt, the replacement is selected. Keep `SOURCE_DIR`, `SECONDARY_INPUTS` and `CAPACITY` in this shell; do not rerun creation on a partially prepared target. The temporary replication file belongs to this replacement operation and stays in the independently retained source-input directory. A retry on another empty target reuses it rather than capturing already suspended settings. In a fresh shell, select the same `SOURCE_DIR` before restoring replication.

```bash
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" --set-string renderMode=connections \
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
  --set-string deployment="$DEPLOYMENT" --wait=legacy --timeout=5m
if yq -e '.services[strenv(INSTANCE)].endpoints.https.tlsManaged' "$INSTALL_DIR/restic-connections.yaml" >/dev/null; then
  kubectl --context "$KUBE_CONTEXT" -n "$NS" wait "certificate/$TLS_SECRET" --for=condition=Ready --timeout=10m
fi
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

After acceptance, restore the independently retained destination credential Secrets as described above. Restore the exact previous replication configuration, including intentionally suspended copies and omitted defaults, then apply it to the replacement:

```bash
export REPLICATION_BEFORE="$SOURCE_DIR/replication-before-replacement.yaml"
yq -i 'load(strenv(REPLICATION_BEFORE)) as $before |
  del(.services[strenv(INSTANCE)].replication) |
  .services[strenv(INSTANCE)] = (.services[strenv(INSTANCE)] * $before)' "$VALUES"
helm upgrade "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" --reset-values -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" --wait=legacy --timeout=5m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Ready --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json |
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Ready" and .status == "True" and .observedGeneration == $g)'
kubectl --context "$KUBE_CONTEXT" -n "$NS" get cronjobs
```

Verify the restored schedules and suspension settings, then remove the temporary file with `rm "$REPLICATION_BEFORE"` and resume consumer publication. Keep this file available across shell/workstation changes until restoration succeeds; it is recovery-operation input, not a customer execution diary. Keep active deployment, selected recovery points and storage identities in the installation record. Source stop intent remains unchanged. If the target may have accepted new writes, do not simply reactivate the predecessor; establish authoritative history and reconcile explicitly.

Failed or interrupted native work leaves the target failed across restart/stop/start. Retain diagnostics, then retry ordinary reconstruction on another independent empty claim. Never clear markers/status, steal a PVC binding, disable locks or blindly unlock. Intact repositories take metadata verification without contacting recovery; absent local state selects recovery, and failed lookup/integrity never means empty history. Native backend retries can run for 15 minutes per operation; client timeout does not cancel them.

## Supported uninstall

Starting condition: [chart-backed operations prepared](#prepare-chart-backed-operations), retained configuration/credentials/history, authorized removal and no concurrent intent writer. Stop consumer publication and finish required replication before draining the endpoint. Export required logs first. Delete the application while its controller is alive, then uninstall Helm:

```bash
yq -i '.operations.deployments[strenv(DEPLOYMENT)].replicas = 0' "$VALUES"
helm upgrade "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" --reset-values -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" --wait=legacy --timeout=5m
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

Only after successful finalization/uninstall, with the same intact claim/configuration/Secrets and no failed markers or competing owner. First [prepare chart-backed operations](#prepare-chart-backed-operations) for this deployment; do not run **Inspect an installed endpoint**, since its application resource has deliberately been removed. Then reinstall:

```bash
yq -i '.operations.deployments[strenv(DEPLOYMENT)].replicas = 1' "$VALUES"
helm install "$RELEASE" "$CHART" --kube-context "$KUBE_CONTEXT" -n "$NS" -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" --wait=legacy --timeout=5m
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait resticapplication/backup-restic --for=condition=Ready --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" get resticapplication/backup-restic -o json | \
  jq -e '.metadata.generation as $g | .status.observedGeneration == $g and
    any(.status.conditions[]; .type == "Ready" and .status == "True" and .observedGeneration == $g)'
```

Require unchanged repository identity/history, an old-point restore and a new backup. Do not recreate credentials or storage. Namespace deletion is a separate destructive decision: it deletes retained PVCs/Secrets and may destroy their storage. Never delete the shared CRD as application cleanup. Remove only authorized DNS/infrastructure after data disposition; [Remove the selected cluster](https://github.com/bartlapp/base-k3s/blob/main/README.md#remove-the-selected-cluster) is separate and destroys node-local data.

## Native maintenance

### Check repository integrity

First [prepare chart-backed operations](#prepare-chart-backed-operations) and select one declared repository. Pause conflicting consumer/copy work without stopping the endpoint; maintenance needs its HTTPS service. Choose a unique invocation name. The Job takes native exclusive locks and performs full check --read-data; it never unlocks or initializes implicitly:

```bash
export REPOSITORY=records
MAINTENANCE="check-$(date -u +%Y%m%d%H%M%S)"
HELM_INSTANCE=${INSTANCE//./\\.}
ADMIN=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].adminSecret' "$INSTALL_DIR/restic-connections.yaml")
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" \
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

The hostname must be reachable from the Job and covered by its validating CA. Keep admin credentials separate. Inspect the native result and retain diagnostics while investigating a failed Job; failure is not permission for blind replay or unlock. Resume paused publication/copies after successful maintenance.

### Delete an authorized recovery point

Starting condition: [chart-backed operations prepared](#prepare-chart-backed-operations), a selected full snapshot ID, and deletion authorized against that repository's retention and holds. Pause conflicting consumer/copy work without stopping the endpoint. Primary and secondary retention are independent; this operation does not delete the corresponding secondary point or prevent a later copy from recreating it.

```bash
export REPOSITORY=records
export FULL_SNAPSHOT_ID=REPLACE_WITH_SELECTED_64_CHARACTER_ID
MAINTENANCE="forget-$(date -u +%Y%m%d%H%M%S)"
HELM_INSTANCE=${INSTANCE//./\\.}
ADMIN=$(yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].adminSecret' "$INSTALL_DIR/restic-connections.yaml")
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES" \
  --set-string deployment="$DEPLOYMENT" \
  --set "services.$HELM_INSTANCE.maintenance.enabled=true" \
  --set-string "services.$HELM_INSTANCE.maintenance.name=$MAINTENANCE" \
  --set-string "services.$HELM_INSTANCE.maintenance.repository=$REPOSITORY" \
  --set "services.$HELM_INSTANCE.maintenance.action=forget-prune" \
  --set-string "services.$HELM_INSTANCE.maintenance.snapshot=$FULL_SNAPSHOT_ID" \
  --set-string "services.$HELM_INSTANCE.maintenance.host=$RESTIC_HOST" \
  --set-string "services.$HELM_INSTANCE.maintenance.credentialsSecret=$ADMIN" \
  --show-only templates/maintenance.yaml | kubectl --context "$KUBE_CONTEXT" -n "$NS" create -f -
kubectl --context "$KUBE_CONTEXT" -n "$NS" wait "job/backup-restic-$MAINTENANCE" --for=condition=complete --timeout=30m
kubectl --context "$KUBE_CONTEXT" -n "$NS" logs "job/backup-restic-$MAINTENANCE"
```

Require successful native forget/prune before resuming paused work. The package neither selects retention points nor schedules deletion; a failed Job requires inspection, not blind replay or unlock.

## Helm inputs and connections

[interface.schema.json](chart/interface.schema.json) defines supported fields; [defaults.yaml](chart/defaults.yaml) supplies defaults. Selecting `deployment` reads `deployments.<deployment>` and `packages.<package>`, checks the Helm target and chart version, then applies only `operations.deployments.<deployment>.replicas` and `.ingressEnabled` over the selected service. Omission restores defaults/derivation, maps merge by key, lists replace, and explicit false/zero remain effective. Unknown selected-service fields fail; unrelated services/resources remain untouched. Restic needs no resolved input. Without a deployment record, `instance` selects the service directly and its `release` can assert the chart version.

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
  --set-string deployment="$DEPLOYMENT" --set-string renderMode=connections \
  --show-only templates/connections.yaml > "$INSTALL_DIR/restic-connections.yaml"
RESTIC_HOST=$(yq -er '.services[strenv(INSTANCE)].endpoints.https.hostname' "$INSTALL_DIR/restic-connections.yaml")
TLS_SECRET=$(yq -er '.credentials.bindings[strenv(INSTANCE)].tls.secretName' "$INSTALL_DIR/restic-connections.yaml")
CLAIM=$(yq -er '.storage.claims[strenv(INSTANCE)].repository.claimName' "$INSTALL_DIR/restic-connections.yaml")
```

Declarations expose HTTPS endpoint flags/hostname, repository URLs and auth/key/admin Secret names, credential requirements/bindings and the operator-owned claim. Recovery and replication credentials require username/restPassword/password/ca.crt; authentication uses htpasswd; encryption uses password. No declaration creates credentials, repositories or application captures.

## Qualification and maintenance

Exact artifacts, exercised cases and remaining acceptance limits belong to the [0.3.1 release record](https://github.com/bartlapp/bartl-restic/releases/tag/v0.3.1). Its retained chart passed the lifecycle, Kubernetes endpoint/authorization, replication and observation-failure runners on one disposable Hetzner/K3s host. Those cases do not establish provider-loss recovery or independently qualify the complete current README and four-service walkthrough. Historical [replication](evidence/2026-11-02-replication.json), [Kubernetes](evidence/2026-11-02-kubernetes.json), [endpoint authorization](evidence/2026-11-02-endpoint.json) and [native copy](evidence/2026-11-02-restic-copy.json) evidence remains attached to its original artifacts.

### Qualification and test output

Use `go test ./...`, `node tests/chart.mjs` and `node --test tests/artifacts.test.mjs` for offline checks. Put native Restic 0.19.1 on PATH for `TestIdleLifecycleAddsFirstNativeRepository`; without it that case skips.

For manual qualification of a retained candidate archive before stable publication, supply its absolute path as `BARTL_RESTIC_CHART`. At **Prerequisites and release**, replace only the latest-stable download block with:

```bash
mkdir -p "$WORK_DIR/packages"
CHART_STAGE=$(mktemp -d "$WORK_DIR/packages/.restic.XXXXXX")
tar -xzf "$BARTL_RESTIC_CHART" -C "$CHART_STAGE"
export PACKAGE_VERSION
PACKAGE_VERSION=$(helm show chart "$CHART_STAGE/bartl-restic" | yq -er '.version')
```

Continue at **Configure a new endpoint** with the selected qualification identity and isolated TLS inputs. This exercises the ordinary operator interface with exact candidate bytes, not the public download path. Keep this distinction in the release record; public acquisition and acceptance follow stable publication.

Cluster qualification requires an explicitly authorized disposable Hetzner cluster with a default StorageClass, registry access and enforced NetworkPolicy. Local Docker/Colima requires separate permission. Runners do not provision infrastructure or establish cleanup/cost.

```bash
export BARTL_RESTIC_LAB=hetzner
export KUBECONFIG=/private/lab-kubeconfig
export BARTL_RESTIC_IMAGE=REGISTRY/RETAINED_QUALIFICATION_IMAGE
node tests/lifecycle.mjs
node tests/kubernetes.mjs
node tests/replication.mjs
node tests/observation.mjs
```

Each runner creates a namespace, finalizes stopped applications before uninstall on success, then destroys disposable data separately. Failures retain diagnostics. Keep the controller alive through finalization. The observation runner needs API Service/EndpointSlice and node-address reads and a temporary root probe with NET_ADMIN; it isolates API traffic while authenticated clients remain available. Require observed API failures and the guard's failure log, not merely configured isolation.

Output defaults to an external private temporary directory. `BARTL_RESTIC_EVIDENCE_DIR` selects another external path; checkout paths and symlink aliases are rejected. `raw.json` holds redacted diagnostics; `qualification.json` holds selected results and source provenance. Provenance records run-start HEAD, dirty state and hashes of implementation, build and test files; a dirty run qualifies those bytes, not HEAD alone. Keep raw artifacts outside Git and put exact artifacts, concise results, limits and cleanup/budget outcome in the release/integration record. Do not add session reports.

Historical 0.2.x-to-0.3.0 migration and uninstall qualification belongs to the [0.3.0 operating procedure](https://github.com/bartlapp/bartl-restic/blob/v0.3.0/README.md), not the current installation path. For reproduction, retain the verified 0.3.0 archive and use:

```bash
export CHART=/retained/bartl-restic-0.3.0.tgz
export IMAGE=ghcr.io/bartlapp/bartl-restic-controller@sha256:f174793e5c622d7eb1d4ae384ac358ec804dae735ddafe2243d710c48b7b8fb3
export OLD_CHART=oci://ghcr.io/bartlapp/bartl-restic@sha256:78d118df791192bcc8dc08ce7ce13ded3ac01b51c33cd19090c30cb7c2d8f20a
export OLD_IMAGE=ghcr.io/bartlapp/bartl-restic-controller@sha256:3ee7994268a23b4beff8a10d6ecc77c13471baa7d4f9e073c4a8dad852deb757
BARTL_RESTIC_REUSE=1 BARTL_RESTIC_CHART="$CHART" BARTL_RESTIC_IMAGE="$IMAGE" \
  node tests/uninstall.mjs
BARTL_RESTIC_REUSE=1 BARTL_RESTIC_CHART="$CHART" BARTL_RESTIC_IMAGE="$IMAGE" \
  BARTL_RESTIC_UPGRADE_FROM_CHART="$OLD_CHART" \
  BARTL_RESTIC_UPGRADE_FROM_IMAGE="$OLD_IMAGE" node tests/uninstall.mjs
```

The 0.2.1 archive SHA-256 is `94293548ac5fd0a86976e4af0e678596a53c8d0144dad1983810cea64c9a4dfc`; its flat interface is not accepted by 0.3.0. Qualification must cover preserved repository identity/history, old-point restore, new backups, contender exclusion, stale-worker refusal, finalization, same-PVC reinstall and separate data destruction. Also exercise idle TLS/404, stop/start and first-repository admission against the exact 0.3.0 artifacts; native tests do not replace those cases.

Historical **0.2.0 must upgrade to 0.2.1 before application deletion**, using its [matching release procedure](https://github.com/bartlapp/bartl-restic/blob/v0.2.1/README.md#supported-uninstall) and retained flat file. Its fixed controller must finalize the application while alive; upgrading later cannot repair an already orphaned binding. These historical requirements do not add a migration step to current installations.

## Release maintenance

Publish immutable public OCI packages under `ghcr.io/bartlapp`, independently of private source access. Never overwrite released versions or silently change visibility/team access.

1. Inspect live repository policy/access and package authority before authorized remote writes. Publication needs `write:packages`; new public package visibility requires explicit approval and an administrator.
2. Commit release changes separately. Build on an authorized Hetzner host with `Dockerfile`, `--platform linux/amd64`, `--provenance=false`, `--build-arg VERSION=VERSION` and `--build-arg REVISION=FULL_SOURCE_SHA`. Retain source and OCI archives outside Git.
3. Set chart version and pin the retained image manifest digest. Stage `chart/` with root LICENSE/NOTICE, then package once. Retain the chart archive and checksum.
4. Publish those retained bytes with digest preservation and isolated temporary credentials. Do not rebuild/repackage between qualification and publication.
5. With empty registry credentials, acquire chart/image, verify identities and smoke-install on an authorized disposable Hetzner cluster. Check current-generation admission, authenticated backup/restore, stop/start and actual runtime image IDs.
6. Record artifacts, concise evidence, limits and cleanup/budget outcome in the release/integration record. Use the permitted integration workflow without squashing, retain raw output externally and remove disposable infrastructure.

Original code/configuration use [Apache-2.0](LICENSE); documentation uses CC-BY-4.0 as stated in [NOTICE](NOTICE). Upstream components retain their own terms.

## Sources

- [Restic: copying repositories](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#copying-snapshots-between-repositories).
- [rest-server 0.14.0](https://github.com/restic/rest-server/blob/v0.14.0/README.md).
- [Restic 0.19.1 copy/locks](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/cmd_copy.go), [retry defaults](https://github.com/restic/restic/blob/v0.19.1/internal/global/global.go) and [strict object inventory](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/cmd_list.go).
