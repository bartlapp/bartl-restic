# Bartlized Restic backend

This package exposes authenticated Restic HTTPS endpoints on existing Kubernetes storage under the [Bartl application contract](https://github.com/bartlapp/bartl-app/blob/main/docs/application-contract.md#portable-recovery-artifact-and-storage-boundary). [Kubernetes operating packages](https://github.com/bartlapp/bartl-app/blob/main/docs/how-to-bartlize.md#kubernetes-operating-packages) explains the controller model; [operating and handing over an installation](https://github.com/bartlapp/bartl-app/blob/main/docs/how-to-bartlize.md#operate-and-hand-over-an-installation) covers the human-executed cross-application sequence. This README defines the Restic-specific storage, replication, recovery and maintenance procedures.

## Service and state boundary

The service owns repository storage, access protection, replication and its own recovery; retention is administered through native maintenance. Each application writes to one endpoint with separate repository, encryption key and credentials. The service does not capture or reconstruct consumers. Repository-operation exclusion belongs at the repository-access boundary, not in application-specific integrations.

Mutable state consists of the encrypted Restic repository directories, including their identities and retained snapshot history. Independently retained [installation inputs](https://github.com/bartlapp/bartl-app/blob/9ec639b7dce27cafeb077f93087e11ec7f7fb3eb/docs/how-to-bartlize.md#installation-inputs) hold effective configuration, pinned software references, repository declarations, access and retention policies, and references to protected credentials. A working directory suffices; no installation repository or company tooling is required. Configuration does not replace repository data. Keys, credentials and configuration must remain available independently of the provider whose loss they cover.

### Required installation decisions

Before relying on the service, record the covered failures and independently usable primary/secondary endpoints, exact artifacts and effective Helm values, storage/TLS/network prerequisites and protected recovery-input locations in the installation inputs. Assign operating responsibility for publication/replication monitoring, native integrity checks, restore qualification, retention maintenance and replacement authorization.

Specify accepted data loss and interruption, replication-outage allowance, recovery-point selection and source-retirement/activation controls. Select replication schedules, deadlines and capacity for that installation; the examples below do not establish a recovery objective. Preserve operation results and the latest verified usable points so that another operator can distinguish application publication from secondary protection.

Define primary and independent secondary retention, required holds, deletion approval and capacity monitoring. Retention must preserve the consumers' required complete recovery points and enough primary history to cover the accepted replication outage. The package neither selects points for deletion nor schedules retention; an operator executes the native maintenance procedure under those recorded rules. Keep destructive admin credentials separate from consumer and replication credentials.

## Disaster recovery

Loss of one provider must not require rebuilding the backup endpoint before consumers can recover. Maintain an independently usable repository at another provider, exposed through its own endpoint. A replacement application reads its selected point there with independently retained credentials and keys. An archive that must first be fully restored into a repository is insufficient. Provider names, URLs and recovery inputs belong in customer configuration.

Replication is asynchronous. A recovery point is protected against primary-provider loss only after its secondary copy is complete and verified. The age of the newest usable secondary recovery point determines the recovery-point window; nominal replication frequency alone is not evidence of protection. Primary publication and secondary replication outcomes must remain distinguishable.

The secondary retains history independently; deletion or compromise at the primary must not erase it. Repository and snapshot IDs may differ across providers. Recovery binds a complete, valid, compatible point in the chosen repository, not an assumed primary ID.

Inspect secondary points or recover repository files with its reader credentials and full snapshot ID. Application reconstruction follows the consumer's recovery procedure.

```sh
export RESTIC_REPOSITORY="rest:https://$SECONDARY_HOST/$REPOSITORY/"
export RESTIC_PASSWORD_FILE=/protected/secondary/password
export RESTIC_REST_USERNAME=reader
export RESTIC_REST_PASSWORD="$(cat /protected/secondary/reader.restPassword)"
restic --cacert /protected/secondary/ca.crt snapshots --json
restic --cacert /protected/secondary/ca.crt restore "$FULL_SNAPSHOT_ID" --target "$RESTORE_DIR"
```

For recovery of an individual endpoint, supply the declared package configuration, protected credentials and an existing PVC. The package observes local state. Intact repositories take native verification without consulting secondary recovery. Empty repositories are reconstructed from the configured secondary's retained history, or initialized if no recovery is configured or a successful native lookup confirms an empty secondary. Unreachable inputs, partial repository directories and failed native operations refuse startup. The surviving endpoint remains independently available to consumers throughout reconstruction.

## Replication mechanism

`restic copy` copies snapshots into an independently initialized repository, skips previously copied snapshots and does not mirror source deletions. The worker needs both repositories' encryption keys because copying decrypts and re-encrypts data. For a new secondary, declare the primary as its recovery source; the native lifecycle initializes it with copied chunker parameters and its own separate password. No manual `restic init` is required.

Recovery selects and binds the destination's full snapshot ID. A copied snapshot preserves the source's `tree`; its `original` field identifies the originating snapshot. Restic preserves an existing `original` value on further copies, so it is not necessarily the immediately preceding repository's snapshot ID. Use native snapshot metadata to establish correspondence; do not assume identical snapshot IDs or treat producer-supplied metadata as proof of application completeness.

The copy worker uses Restic's source read lock and destination append lock. Keep destructive maintenance excluded from replication and recovery through native Restic locks. Recovery access is read-only for backup contents but permits native lock creation/removal. After a crash, establish that the owning operation has ended before removing a stale lock; never blindly unlock on retry. Independent secondary retention must not translate source absence into deletion.

## Endpoint package

`chart/` renders a namespaced `ResticApplication`, its Go/controller-runtime controller and scoped RBAC. The controller owns the endpoint Deployment, HTTPS Service, nginx configuration, NetworkPolicy, finite lifecycle Job and replication CronJobs. Helm owns intent, not the workloads' replica counts or serving gate. The existing PVC and Secrets remain operator-owned. The package never creates or deletes repository storage and does not schedule retention. rest-server is pinned to a 0.14.0 image digest, nginx to 1.28.0 and native Restic to 0.19.1.

Each declared repository has one URL, `rest:https://HOST/REPOSITORY/`, and its own authentication Secret. That Secret's `htpasswd` contains accounts named exactly `writer`, `reader` and `admin`, with different passwords for each account and repository. An authenticated unknown username receives HTTP 403. Do not duplicate account passwords across repositories: the per-repository files are the credential boundary.

- `writer` reaches append-only rest-server: it may add backup objects and manage native locks, but may not overwrite or delete backup contents.
- `reader` may GET/HEAD repository contents and POST/DELETE only `/REPOSITORY/locks/<64 lowercase hex characters>`. It cannot write/delete data, snapshots, indexes, keys or config. Recovery therefore participates in native Restic locks rather than bypassing them.
- `admin` reaches the full backend. Keep it out of application writer/recovery Secrets. It is the separate authority for destructive maintenance.

Native locks coordinate cooperative Restic clients. A holder of reader or writer credentials can delete lock objects; locks are not protection against a malicious credential holder. Neither the chart nor maintenance disables consumers or automatically unlocks a repository.

### Idle endpoints and repository admission

Release 0.3.0 accepts `services.restic.repositories: []` (the default). This starts an idle HTTPS endpoint on the existing PVC with the configured TLS Secret, without repository authentication Secrets, encryption keys or replication work. Requests have no declared repository route and receive HTTP 404. The endpoint still passes the normal finite lifecycle Job, current-intent admission checks, exclusive storage lock, PVC ownership fence and HTTPS serving guard.

To add a repository, retain its independent key and transport credentials, create its declared Secrets using the preparation below, then upgrade the same release with the extended repository list. The native worker initializes a genuinely new repository automatically; never run `restic init` manually. The controller drains the endpoint and admits a new native lifecycle before exposing the new route. Stop/resume uses `services.restic.replicas`; resume performs fresh native observation even when idle.

Removing a declaration never authorizes data deletion. Undeclared local data remains on the claim and causes native re-admission to fail closed, even with an empty declaration list. Restoring the declaration does not clear a failed admission: use the documented failed-target handling. Do not erase retained history to make an idle endpoint start. Published 0.2.1 rejects an empty repository list; the new chart and combined controller/worker image are both required.

### Obtain release 0.3.0

Use the [operator workstation](https://github.com/bartlapp/bartl-app/blob/main/docs/operator-workstation.md) with Bash, Helm 4.x (minimum supported recipe version 4.3.0), compatible kubectl, Mike Farah yq v4, jq, OpenSSL 3, curl, dig and shasum. The workstation guide selects the current installation version; historical qualification retains the version actually exercised. Keep shell tracing off. Start in a new working directory; the public chart and digest-pinned amd64 image require no source checkout, registry login or company tooling:

```bash
set -euo pipefail
umask 077
mkdir bartl-restic
cd bartl-restic
helm pull oci://ghcr.io/bartlapp/bartl-restic --version 0.3.0
printf '%s  bartl-restic-0.3.0.tgz\n' \
  57feb5b39b325e3972fe9a9c870cd6c0c5fe54f2f91faba8b4b1652fb4918253 > SHA256SUMS
shasum -a 256 --check SHA256SUMS
CHART="$PWD/bartl-restic-0.3.0.tgz"
IMAGE=ghcr.io/bartlapp/bartl-restic-controller@sha256:f174793e5c622d7eb1d4ae384ac358ec804dae735ddafe2243d710c48b7b8fb3
```

Retain the verified archive, checksum and pinned image reference independently of the target. The chart pins the combined controller/worker image; do not override it with the 0.2.1 image. Release artifact identities and exact-artifact qualification belong in the [0.3.0 release record](https://github.com/bartlapp/bartl-restic/releases/tag/v0.3.0).

For the historical upgrade baseline only, retain 0.2.1 separately:

```bash
OLD_CHART=oci://ghcr.io/bartlapp/bartl-restic@sha256:78d118df791192bcc8dc08ce7ce13ded3ac01b51c33cd19090c30cb7c2d8f20a
OLD_IMAGE=ghcr.io/bartlapp/bartl-restic-controller@sha256:3ee7994268a23b4beff8a10d6ecc77c13471baa7d4f9e073c4a8dad852deb757
```

Its archive SHA-256 is `94293548ac5fd0a86976e4af0e678596a53c8d0144dad1983810cea64c9a4dfc`. Its flat values interface is historical, not accepted by 0.3.0.

### Select the target and shared file

The cluster needs amd64 nodes, registry egress, enforced NetworkPolicy, a writable ReadWriteOnce PVC with POSIX permissions, locking, atomic rename and fsync, and permission to install the shared `ResticApplication` CRD and namespace-scoped resources. Supply enough repository, copy and reconstruction capacity before starting. The default access path needs Traefik with its `IngressRouteTCP` CRD and `websecure` entrypoint, cert-manager, public ports 80/443 and working public DNS for ACME. The [base-k3s recipe](https://github.com/bartlapp/base-k3s/blob/main/README.md#what-this-recipe-delivers), completed through its handover checks, provides the single-node base; any equivalent cluster suffices. Retain absolute kubeconfig paths in every terminal. This package provisions neither infrastructure nor DNS.

```bash
CTX=$(kubectl config current-context)
NS=backup
INSTANCE=restic
INSTALL_DIR="$PWD/installation"
mkdir -p "$INSTALL_DIR/protected/repositories"
VALUES="$INSTALL_DIR/installation.yaml"
kubectl --context "$CTX" get nodes,storageclass
kubectl --context "$CTX" create namespace "$NS" --dry-run=client -o yaml |
  kubectl --context "$CTX" apply -f -
```

Create `"$VALUES"` with your stable installation identity and real DNS root:

```yaml
installation: learning-lab
dns:
  root: your-domain.example
services:
  restic:
    release: "0.3.0"
    repositories:
      - name: records
```

For an idle endpoint, use `repositories: []` instead. This derives hostname `restic.your-domain.example`, one replica, claim `repository`, TLS Secret `repository-tls` and `records-repository-auth`/`records-repository-key` credential names. `release` is an optional exact-version guard. An explicit `hostname` overrides derivation; removing it restores the DNS-root rule. Another instance uses its own service key and `--set-string instance=...`. Selected service fields are strict; unrelated services and infrastructure are ignored. `resolved` is not required for operating Restic itself. The native CR/controller API remains unchanged.

Render the public nonsecret declarations before deployment and rerender whenever choices change:

```bash
helm template backup "$CHART" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string renderMode=connections \
  --show-only templates/connections.yaml > "$INSTALL_DIR/restic-connections.yaml"
RESTIC_HOST=$(INSTANCE="$INSTANCE" yq -er '.services[strenv(INSTANCE)].endpoints.https.hostname' "$INSTALL_DIR/restic-connections.yaml")
TLS_SECRET=$(INSTANCE="$INSTANCE" yq -er '.credentials.bindings[strenv(INSTANCE)].tls.secretName' "$INSTALL_DIR/restic-connections.yaml")
CLAIM=$(INSTANCE="$INSTANCE" yq -er '.storage.claims[strenv(INSTANCE)].repository.claimName' "$INSTALL_DIR/restic-connections.yaml")
```

Declarations work offline without infrastructure or credentials. Public fields are `services.<instance>.endpoints.https.{url,hostname,tlsManaged,ingressEnabled}`, `backup.providers.<instance>.repositories.<name>.{repository,authSecret,passwordSecret,adminSecret}`, `credentials.{requirements,bindings}.<instance>` and `storage.claims.<instance>.repository`. Bindings expose `tls.secretName` and `repositories.<name>.{authentication,encryption,maintenance}.secretName`; requirements distinguish credential sources and required keys. Rendering declares requirements, not existing repositories or issued credentials.

Create the declared claim using your StorageClass and capacity. This disposable example requests 20Gi; size production storage and headroom explicitly:

```bash
kubectl --context "$CTX" -n "$NS" apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $CLAIM
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 20Gi
EOF
kubectl --context "$CTX" -n "$NS" get pvc "$CLAIM"
```

For retained-state restart, reuse the intact claim instead; never attach another active installation's claim. A WaitForFirstConsumer claim can remain Pending until scheduling. Claim and Secrets are operator-owned and survive supported uninstall.

### HTTPS and protected inputs

Point `"$RESTIC_HOST"` to the selected cluster's Traefik address (`kubectl --context "$CTX" -n kube-system get service traefik -o wide`). Confirm authoritative and public `dig` answers before expecting issuance. Default `tls.managed: true` creates a namespace-local ACME Issuer and Certificate; `tls.acmeServer` can select staging, which is not publicly trusted. cert-manager owns renewal. Default ingress is an `IngressRouteTCP` with `HostSNI` and TLS passthrough to Service port 443: nginx retains native TLS and per-repository authorization; Traefik does not terminate repository TLS.

For independently provided TLS, set `services.restic.tls.managed: false` and create the declared Secret:

```bash
kubectl --context "$CTX" -n "$NS" create secret tls "$TLS_SECRET" \
  --cert=/protected/tls/fullchain.pem --key=/protected/tls/key.pem \
  --dry-run=client -o yaml | kubectl --context "$CTX" apply -f -
```

Keep external mode for existing manually managed certificates rather than silently adopting them. `ingress.enabled: false` omits routing, not native TLS/authentication; supply another TLS-preserving route to the Service. `ingress.entryPoint` defaults to `websecure`. The hostname must be reachable from consumers and native maintenance Jobs. The policy permits only TLS ingress on port 8443; rest-server listeners remain loopback-only.

Before relying on recovery, independently retain each repository encryption password and all transport credentials outside the cluster and covered failure domain. For recovery or adding an existing repository, restore those files first and **do not generate missing replacement keys**. For genuinely new repositories only, the following generates missing independent values once and preserves retained files. Rotation is a separate operation. The CA file is mandatory for native maintenance/recovery: place a trusted public CA bundle or the validating private CA at `"$INSTALL_DIR/protected/ca.crt"` first (for example, a verified workstation public trust bundle at `/etc/ssl/cert.pem` for public ACME).

```bash
test -s "$INSTALL_DIR/protected/ca.crt"
while IFS= read -r repository; do
  directory="$INSTALL_DIR/protected/repositories/$repository"
  mkdir -p "$directory"
  for key in password writer.restPassword reader.restPassword admin.restPassword; do
    if [ -e "$directory/$key" ]; then
      test -s "$directory/$key" || { printf 'Empty retained input: %s\n' "$directory/$key" >&2; exit 1; }
    else
      (set -o noclobber; openssl rand -hex 32 | tr -d '\n' > "$directory/$key")
    fi
  done
  if [ -e "$directory/htpasswd" ]; then
    for role in writer reader admin; do
      hash=$(while IFS=: read -r account encoded; do
        [ "$account" != "$role" ] || printf '%s\n' "$encoded"
      done < "$directory/htpasswd")
      case "$hash" in
        '$apr1$'*) salt=${hash#\$apr1\$}; salt=${salt%%\$*} ;;
        *) printf 'Missing or unsupported retained account: %s/%s\n' "$repository" "$role" >&2; exit 1 ;;
      esac
      test "$(openssl passwd -apr1 -salt "$salt" -stdin < "$directory/$role.restPassword")" = "$hash" || {
        printf 'Retained authentication conflicts with password: %s/%s\n' "$repository" "$role" >&2
        exit 1
      }
    done
  else
    (set -o noclobber
      for role in writer reader admin; do
        printf '%s:%s\n' "$role" "$(openssl passwd -apr1 -stdin < "$directory/$role.restPassword")"
      done > "$directory/htpasswd")
  fi
  AUTH=$(INSTANCE="$INSTANCE" REPOSITORY="$repository" yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].authSecret' "$INSTALL_DIR/restic-connections.yaml")
  KEY=$(INSTANCE="$INSTANCE" REPOSITORY="$repository" yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].passwordSecret' "$INSTALL_DIR/restic-connections.yaml")
  ADMIN=$(INSTANCE="$INSTANCE" REPOSITORY="$repository" yq -er '.backup.providers[strenv(INSTANCE)].repositories[strenv(REPOSITORY)].adminSecret' "$INSTALL_DIR/restic-connections.yaml")
  kubectl --context "$CTX" -n "$NS" create secret generic "$AUTH" \
    --from-file=htpasswd="$directory/htpasswd" --dry-run=client -o yaml |
    kubectl --context "$CTX" apply -f -
  kubectl --context "$CTX" -n "$NS" create secret generic "$KEY" \
    --from-file=password="$directory/password" --dry-run=client -o yaml |
    kubectl --context "$CTX" apply -f -
  printf '%s' admin > "$directory/admin.username"
  kubectl --context "$CTX" -n "$NS" create secret generic "$ADMIN" \
    --from-file=username="$directory/admin.username" \
    --from-file=restPassword="$directory/admin.restPassword" \
    --from-file=password="$directory/password" \
    --from-file=ca.crt="$INSTALL_DIR/protected/ca.crt" --dry-run=client -o yaml |
    kubectl --context "$CTX" apply --server-side --field-manager=restic-preparation -f -
done < <(INSTANCE="$INSTANCE" yq -r '(.backup.providers[strenv(INSTANCE)].repositories // {}) | keys | .[]' "$INSTALL_DIR/restic-connections.yaml")
```

Retain `htpasswd` with the passwords: its salted hashes are generated only once, and replay verifies them without changing the live authentication Secret. Regenerating hashes while running would trigger needless re-admission; sequential changes during admitted work can correctly fail the endpoint closed. Secrets containing CA bundles use server-side apply so a full public trust bundle is not duplicated into Kubernetes' size-limited last-applied annotation.

An idle endpoint needs only storage and TLS; skip repository/CA preparation until adding a repository. Consumers receive only their own repository key and reader/writer transport credentials, never endpoint admin credentials. No password belongs in values, a repository URL, Git or diagnostic output.

A repository entry may additionally declare `recovery: {host: secondary.example.org, repository: records, credentialsSecret: secondary-reader}`. Create that Secret from independently retained `username=reader`, `restPassword`, `password` and `ca.crt` files in the backup namespace. Missing/unreachable recovery is an error, not empty history. Intact local state needs neither recovery credentials nor that endpoint. Reconstruction automatically uses native chunker-parameter copying, copy, full destination `check --read-data` and snapshot correspondence. Ordinary existing-state admission checks metadata integrity, not a full data scrub.

For the example recovery declaration, create the reader Secret before deployment:

```bash
kubectl --context "$CTX" -n "$NS" create secret generic secondary-reader \
  --from-file=username=/protected/secondary/reader.username \
  --from-file=restPassword=/protected/secondary/reader.restPassword \
  --from-file=password=/protected/secondary/password \
  --from-file=ca.crt=/protected/secondary/ca.crt --dry-run=client -o yaml |
  kubectl --context "$CTX" apply --server-side --field-manager=restic-preparation -f -
```

`reader.username` must contain exactly `reader`. The key and transport password belong to the selected secondary repository, not the lost primary.

### Deploy and inspect native admission

```bash
helm upgrade --install backup "$CHART" --kube-context "$CTX" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --wait=legacy --timeout=5m
GENERATION=$(kubectl --context "$CTX" -n "$NS" get resticapplication backup-restic -o jsonpath='{.metadata.generation}')
kubectl --context "$CTX" -n "$NS" wait resticapplication/backup-restic \
  --for="jsonpath={.status.conditions[?(@.type==\"Ready\")].observedGeneration}=$GENERATION" --timeout=30m
kubectl --context "$CTX" -n "$NS" wait --for=condition=Ready resticapplication/backup-restic --timeout=30m
kubectl --context "$CTX" -n "$NS" get resticapplication backup-restic -o json
JOB=$(kubectl --context "$CTX" -n "$NS" get resticapplication backup-restic -o jsonpath='{.status.operation.jobName}')
kubectl --context "$CTX" -n "$NS" logs "job/$JOB"
kubectl --context "$CTX" -n "$NS" get certificate,service
```

The native worker owns initialization; do not run manual `restic init`. Wait for the declared certificate to be Ready and check real HTTPS before enabling consumers. An idle endpoint returns HTTP 404 over trusted TLS. For a populated standalone endpoint, read `backup.providers.<instance>.repositories.<name>.repository`, use the retained writer credentials/key with native `restic backup`, then list/restore with reader credentials and verify contents. Applications own consistent capture; a successful arbitrary file backup does not qualify an application's recovery point. Changes to local password, authentication or TLS Secrets trigger controlled re-admission and restart.

For a native standalone file round-trip, install Restic 0.19.1 on the workstation and use the populated example's `records` repository:

```bash
(
  set -euo pipefail
  directory="$INSTALL_DIR/protected/repositories/records"
  export RESTIC_REPOSITORY
  RESTIC_REPOSITORY=$(INSTANCE="$INSTANCE" yq -er \
    '.backup.providers[strenv(INSTANCE)].repositories.records.repository' \
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

Keep the snapshot until retention authorizes deletion. Retain the encrypted history **and** its independent key; reader credentials alone cannot decrypt it.

Require `status.observedGeneration` and the selected condition's `observedGeneration` to equal live `metadata.generation`. `Ready=True` reports the current running endpoint, `Stopped=True` reports drained application work, and `Failed=True` retains a refused or interrupted lifecycle. A successful Helm invocation is not lifecycle completion; with Helm 4 use `--wait=legacy` for controller infrastructure and inspect application status separately. `status.operation` binds the admitted Job, application/PVC ownership, initiating generation and input hash; stale or missing execution results cannot open access.

The CRD is included in the published chart. Helm installs a missing CRD but does not upgrade an existing definition. Before a package upgrade, extract the selected published chart and explicitly apply its CRD:

```bash
kubectl --context "$CTX" apply -f <(helm show crds "$CHART")
```

Upgrading the former endpoint-only chart is an ownership cutover with interruption: retain the PVC/Secrets, add each repository's `passwordSecret`, apply the selected CRD, then upgrade. Helm removes the old directly rendered endpoint resources; the controller recreates them only after native admission. Do not run the old release or another controller against the same claim.

### Compose explicit Keycloak 0.6.1 and Paperless 0.2.0 backups

This connects two independent consumer releases to separate repositories; it is not a generic resolver or an umbrella chart. The same absolute `"$VALUES"` travels to all three releases, even when the backup endpoint and applications run on independent clusters. Keep `CTX`/`NS` for the backup cluster and select the two consumer contexts/namespaces explicitly below. Both consumer clusters must reach the declared public HTTPS endpoint and trust its certificate.

The exact-version [Keycloak 0.6.1 procedure](https://github.com/bartlapp/bartl-keycloak/blob/v0.6.1/README.md) and [Paperless 0.2.0 procedure](https://github.com/bartlapp/bartl-paperless/blob/v0.2.0/README.md) own application storage, retained native credentials, configuration, deployment, capture and recovery. Use those instructions with this existing `VALUES`, not replacement example files. For Paperless OIDC, follow its **Optional: compose with independently released Keycloak** section through native client registration and retained client-secret retrieval, then configuration rendering. Keycloak administration credentials are preparation-only, never Paperless runtime or backup credentials. Do not replace restored Paperless secret keys, OIDC client secrets or repository encryption keys.

Acquire the independently released consumer charts:

```bash
helm pull oci://ghcr.io/bartlapp/bartl-keycloak --version 0.6.1
printf '%s  bartl-keycloak-0.6.1.tgz\n' \
  7abb55bcefbcde70dc8f29309d508d314a48783547067b529d48617d23c9225a |
  shasum -a 256 --check -
KC_CHART="$PWD/bartl-keycloak-0.6.1.tgz"
helm pull oci://ghcr.io/bartlapp/bartl-paperless --version 0.2.0
printf '%s  bartl-paperless-0.2.0.tgz\n' \
  4c6df6106efb35b2c4a25e4bb77d7ad98765572154dbcd380a9742f20bfac5c9 |
  shasum -a 256 --check -
PL_CHART="$PWD/bartl-paperless-0.2.0.tgz"
KC_CTX="$CTX" # Select the actual application-cluster context, if different.
PL_CTX="$KC_CTX"
KC_NS=keycloak-blue
PL_NS=paperless-blue
```

For this fresh example, use the following service choices in the same file, preserving `installation`, `dns` and any other existing inputs. An already-populated endpoint keeps **all** its declarations: append these repositories instead of replacing its list. Lists replace as a whole.

```yaml
services:
  restic:
    release: "0.3.0"
    repositories:
      - name: keycloak
      - name: paperless
  keycloak:
    release: "0.6.1"
    backup:
      endpoint: restic
  paperless:
    release: "0.2.0"
    backup:
      endpoint: restic
    # Optional; complete Paperless's native OIDC preparation if selected:
    # identityProvider: keycloak
```

Render all three public declarations before installing the applications:

```bash
helm template backup "$CHART" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set-string renderMode=connections \
  --show-only templates/connections.yaml > "$INSTALL_DIR/restic-connections.yaml"
helm template keycloak "$KC_CHART" -n "$KC_NS" -f "$VALUES" \
  --set-string instance=keycloak --set-string renderMode=connections \
  --show-only templates/connections.yaml > "$INSTALL_DIR/keycloak-connections.yaml"
helm template paperless "$PL_CHART" -n "$PL_NS" -f "$VALUES" \
  --set-string instance=paperless --set-string renderMode=connections \
  --show-only templates/connections.yaml > "$INSTALL_DIR/paperless-connections.yaml"
for consumer in keycloak paperless; do
  declaration="$INSTALL_DIR/$consumer-connections.yaml"
  CONSUMER="$consumer" INSTANCE="$INSTANCE" yq -e '
    .backup.requests[strenv(CONSUMER)].enabled == true and
    .backup.requests[strenv(CONSUMER)].endpoint == strenv(INSTANCE)
  ' "$declaration" >/dev/null
  repository=$(INSTANCE="$INSTANCE" CONSUMER="$consumer" yq -er \
    '.backup.providers[strenv(INSTANCE)].repositories[strenv(CONSUMER)].repository' \
    "$INSTALL_DIR/restic-connections.yaml")
  reader=$(CONSUMER="$consumer" yq -er '.backup.requests[strenv(CONSUMER)].readerSecret' "$declaration")
  writer=$(CONSUMER="$consumer" yq -er '.backup.requests[strenv(CONSUMER)].writerSecret' "$declaration")
  CONSUMER="$consumer" INSTANCE="$INSTANCE" REPOSITORY="$repository" READER="$reader" WRITER="$writer" yq -i '
    .resolved.backup.bindings[strenv(CONSUMER)] = {
      "endpoint": strenv(INSTANCE), "repository": strenv(REPOSITORY),
      "readerSecret": strenv(READER), "writerSecret": strenv(WRITER)
    }
  ' "$VALUES"
done
```

These `resolved.backup.bindings.<consumer>` entries are nonsecret preparation results; refresh them when provider or consumer choices change. Neither chart silently adds repositories for consumers. The two explicit repository names above select the provider declarations; preparation copies the declared URLs rather than reconstructing hostname/path rules or scraping internal CRs.

Run the fresh-only protected-input preparation above for the new repositories (or supply their independently retained files for recovery), then deploy/upgrade Restic and require current-generation Ready and usable trusted HTTPS. Native admission initializes the new repositories. Only then create scoped consumer Secrets in their own contexts/namespaces:

```bash
for consumer in keycloak paperless; do
  case "$consumer" in
    keycloak) consumer_ctx="$KC_CTX"; consumer_ns="$KC_NS" ;;
    paperless) consumer_ctx="$PL_CTX"; consumer_ns="$PL_NS" ;;
  esac
  kubectl --context "$consumer_ctx" create namespace "$consumer_ns" --dry-run=client -o yaml |
    kubectl --context "$consumer_ctx" apply -f -
  directory="$INSTALL_DIR/protected/repositories/$consumer"
  for role in reader writer; do
    binding=backupReader
    [ "$role" != writer ] || binding=backupWriter
    secret=$(CONSUMER="$consumer" BINDING="$binding" yq -er \
      '.credentials.bindings[strenv(CONSUMER)][strenv(BINDING)].secretName' \
      "$INSTALL_DIR/$consumer-connections.yaml")
    printf '%s' "$role" > "$directory/$role.username"
    kubectl --context "$consumer_ctx" -n "$consumer_ns" create secret generic "$secret" \
      --from-file=username="$directory/$role.username" \
      --from-file=restPassword="$directory/$role.restPassword" \
      --from-file=password="$directory/password" \
      --from-file=ca.crt="$INSTALL_DIR/protected/ca.crt" --dry-run=client -o yaml |
      kubectl --context "$consumer_ctx" apply --server-side --field-manager=restic-preparation -f -
  done
done
```

The two roles share only their own repository encryption key; every repository and transport role has its own password. No consumer receives `htpasswd`, another repository's key, endpoint-admin credentials or a replication destination credential. Retain the protected directories independently before relying on captures.

Finish the exact-version application procedures with `CHART="$KC_CHART"`, `CTX="$KC_CTX"`, `NS="$KC_NS"`, `INSTANCE=keycloak` for Keycloak, and correspondingly `PL_CHART`/`PL_CTX`/`PL_NS`/`paperless` for Paperless, always using this same `VALUES`. Those assignments are for the application terminals; retain this terminal's Restic variables for endpoint operations. They are independent `helm upgrade --install keycloak ...` and `helm upgrade --install paperless ...` releases, not dependencies deployed by Restic. Trigger each package's native backup, inspect its own publication result, and verify recovery through that package's independent-target procedure. Configure schedules, secondary replication and retention separately against the accepted failure boundary; installing three charts alone is not evidence of provider-loss recovery.

### Migrate flat 0.2.1 inputs to 0.3.0

Retain the old chart, flat values, repository identities and credential files before upgrading. Use the same Helm release, namespace, PVC and Secret names; the new chart must not accidentally select a new key or a managed certificate for an externally managed TLS endpoint. There is no flat compatibility shim or `--reuse-values` path.

Create the shared file with `installation`, `dns.root` (or explicit hostname), and `services.restic`. Move old `application.replicas` to `services.restic.replicas`; move `existingClaim`, `tlsSecret`, `repositories`, `replication` and `maintenance` unchanged under that service. Preserve every explicit repository `authSecret` and `passwordSecret`, including the old example's `repository-key`. Set `release: "0.3.0"`. Set `tls.managed: false` for existing external TLS; set `ingress.enabled: false` while retaining an existing external route, or deliberately configure the new passthrough route. Retire old image overrides and use the new chart's pinned image.

Render public declarations, compare repository URLs and Secret/claim bindings with the retained installation inputs, and apply the selected CRD as above. Upgrade with `helm upgrade backup "$CHART" --kube-context "$CTX" -n "$NS" --reset-values -f "$VALUES" --set-string instance="$INSTANCE" --wait=legacy --timeout=5m`. Require current-generation Ready, unchanged repository identity/history, an older-point restore and a new backup before declaring the transition usable. Do not run another controller against the claim or treat failed native admission as permission to initialize it.

### Durable stop and replacement

Set run/stop intent through Helm, not by scaling generated Deployments:

```sh
helm upgrade backup "$CHART" --kube-context "$CTX" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set "services.$INSTANCE.replicas=0"
kubectl --context "$CTX" -n "$NS" wait --for=condition=Stopped resticapplication/backup-restic --timeout=5m
kubectl --context "$CTX" -n "$NS" get resticapplication backup-restic -o json
kubectl --context "$CTX" -n "$NS" get pods,jobs,cronjobs
```

To resume this installation, retain `services.restic.replicas: 1` in its shared values and use the same package:

```sh
helm upgrade backup "$CHART" --kube-context "$CTX" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set "services.$INSTANCE.replicas=1"
kubectl --context "$CTX" -n "$NS" wait --for=condition=Ready resticapplication/backup-restic --timeout=30m
kubectl --context "$CTX" -n "$NS" get resticapplication backup-restic -o json
```

Retain `services.restic.replicas: 0` in the old installation's retained values. The controller withdraws serving, suspends new copy admission, scales the endpoint down and gracefully terminates running lifecycle/copy work. Every endpoint process requires fresh successful application and live-PVC admission before nginx starts. An observed stop, revoked ownership, changed identity, deletion or withdrawn successful admission terminates serving through SIGQUIT. Lifecycle and replication workers retain their fail-closed observation policy and receive SIGINT on cancellation. A bounded kill is a last resort after cancellation, not an expiry of serving permission.

An already-admitted endpoint continues backups and restores when API observation is unavailable. It reports the failure and keeps checking without changing readiness solely for that failure. A confirmed negative from either the application or bound PVC wins over an unavailable check of the other. The controller leaves the established endpoint and configuration unchanged without claiming fresh verification. A replacement process needs fresh admission; it cannot inherit permission during an outage.

An API partition can therefore leave the endpoint serving indefinitely unless another control path terminates it. Request timeouts bound observations, not permission validity. Before replacement, require confirmed drainage or retirement, not merely stop intent or an unreachable primary. Stop completes only after acknowledged Deployment/ReplicaSet scale-down and disappearance of required active Pods. Cancellation deletes Jobs and their Pods; export needed logs first.

A completed stop invalidates successful native admission. The next start observes and checks the retained repositories again; ordinary controller or process restarts while running do not reinitialize them. Failed operations remain failed across stop/start. A rejected installation that never acquired the claim can stop or be deleted without stopping its rightful owner.

For a planned replacement, first obtain current-generation `Stopped=True`, confirm there are no active endpoint/lifecycle/copy Pods and preserve that stop intent. If final primary-only history must be preserved, let replication finish and verify the secondary before stopping. Install the replacement with a fresh claim, the retained configuration/credentials and the surviving secondary as recovery source. After automatic reconstruction and `Ready=True`, verify an older recovery point, a new backup and access protection, then switch the service route. Keep the old installation stopped or retire it; do not reapply its old running values.

For destroyed infrastructure, establish that the old primary can no longer serve or replicate before activating its replacement. An unreachable primary is not proof of retirement. This package does not invent cross-cluster fencing: if the old primary might still be active and its authority cannot independently be withdrawn, do not activate a replacement. Changing DNS alone is insufficient. Claim ownership prevents competing controllers from adopting the same PVC inside the supported cluster; it does not fence another provider.

An interrupted state-changing worker leaves a durable marker on the PVC. A failed or missing admitted Job is also retained as failure in application status. A later restart or run intent does not clear either failure. Inspect the Job, worker logs and native locks; retain evidence, discard the failed target and repeat ordinary installation on fresh storage. Do not remove the marker or blindly unlock to make startup succeed. The secondary stays usable with its separate reader credentials; reconstruction never runs exclusive maintenance or deletion there.

For damaged-history diagnosis, enumerate native IDs with `restic list snapshots` and inspect each with `restic cat snapshot FULL_ID`. Restic's presentation command `snapshots --json` may warn and omit unreadable objects while returning success. Lifecycle observation therefore uses the strict object inventory, not an apparently empty presentation listing.

Transient backend errors follow Restic 0.19.1's native 15-minute retry window per operation. During retries the lifecycle remains unserved and logs the underlying errors; exhausted retries produce `Failed`, never initialization. Stop intent cancels those native waits too.

### Upgrade 0.2.0 before removal

For a historical 0.2.0 installation, upgrade to 0.2.1 before deleting its application. The fixed controller must perform finalization; installing it after uninstall cannot retroactively release an orphaned binding. Keep the same PVC and independently retained configuration/Secrets. The following is the **historical flat-interface exception**: `endpoint-values.yaml` is that installation's retained 0.2.x file, not the shared 0.3.0 file. Use the `OLD_CHART`/`OLD_IMAGE` references above:

```sh
(
  set -eu
  helm upgrade backup "$OLD_CHART" -n backup -f endpoint-values.yaml \
    --set application.replicas=1 --wait=legacy --timeout=5m
  kubectl -n backup rollout status deployment/backup-restic-controller --timeout=3m
  GENERATION=$(kubectl -n backup get resticapplication backup-restic \
    -o jsonpath='{.metadata.generation}')
  kubectl -n backup wait resticapplication/backup-restic \
    --for=jsonpath='{.status.observedGeneration}'="$GENERATION" --timeout=30m
  kubectl -n backup wait resticapplication/backup-restic \
    --for=condition=Ready --timeout=30m
  APPLICATION=$(kubectl -n backup get resticapplication backup-restic -o json)
  printf '%s\n' "$APPLICATION" | jq -e --arg image "$OLD_IMAGE" '
    .metadata.generation as $generation |
    .spec.image == $image and .spec.replicas == 1 and
    .status.state == "Ready" and .status.observedGeneration == $generation and
    any(.status.conditions[]?;
      .type == "Ready" and .status == "True" and
      .observedGeneration == $generation) and
    (.metadata.finalizers | index("restic.bartl.sh/drain") != null)
  ' >/dev/null
)
```

Confirm repository identity and retained history and restore an old point. For continued operation, migrate the retained 0.2.1 inputs to 0.3.0 as above before using the current shared-file lifecycle commands. For removal while staying on historical 0.2.1, use that version's [supported uninstall procedure](https://github.com/bartlapp/bartl-restic/blob/v0.2.1/README.md#supported-uninstall) with its flat file. Keep the controller running through application deletion. There is no annotation-clearing or finalizer-bypass step for already-orphaned bindings.

### Supported uninstall

Stop and confirm current-generation drainage, delete the `ResticApplication` while its controller is running, then uninstall Helm. Keep `services.restic.replicas: 0` in `"$VALUES"` and prevent other operators or reconcilers from restoring running intent. Do not delete the namespace/controller first or bypass finalizers. Export needed logs before stopping:

```sh
(
  set -eu
  helm upgrade backup "$CHART" --kube-context "$CTX" -n "$NS" -f "$VALUES" \
    --set-string instance="$INSTANCE" --set "services.$INSTANCE.replicas=0"
  GENERATION=$(kubectl --context "$CTX" -n "$NS" get resticapplication backup-restic \
    -o jsonpath='{.metadata.generation}')
  kubectl --context "$CTX" -n "$NS" wait resticapplication/backup-restic \
    --for=jsonpath='{.status.observedGeneration}'="$GENERATION" --timeout=5m
  kubectl --context "$CTX" -n "$NS" wait resticapplication/backup-restic \
    --for=condition=Stopped --timeout=5m
  APPLICATION=$(kubectl --context "$CTX" -n "$NS" get resticapplication backup-restic -o json)
  printf '%s\n' "$APPLICATION" | jq -e '
      .metadata.generation as $generation |
      .spec.replicas == 0 and
      .status.state == "Stopped" and
      .status.observedGeneration == $generation and
      any(.status.conditions[]?;
        .type == "Stopped" and .status == "True" and
        .observedGeneration == $generation)
    ' >/dev/null

  kubectl --context "$CTX" -n "$NS" delete resticapplication backup-restic \
    --wait=true --timeout=3m
  helm uninstall backup --kube-context "$CTX" -n "$NS" --wait --timeout=3m

  kubectl --context "$CTX" -n "$NS" get pvc "$CLAIM"
  kubectl --context "$CTX" -n "$NS" get secrets
)
```

The subshell stops on any failed check or timeout. Keep the controller running and inspect application status, Pods and controller logs before continuing; never remove finalizers to force completion. An unavailable API or incomplete drainage is not permission to uninstall.

The operator-owned PVC, repository data, Secrets and shared CRD survive uninstall. From 0.2.1 onward, deletion confirms drainage again and conditionally releases only this application's claim binding; ordinary stop retains ownership and the finalizer. Unavailable observations or conflicting writes leave removal incomplete. Failed/interrupted work keeps the claim fenced; uninstall clears neither failure markers nor native locks.

After successful finalization and Helm uninstall, retain `services.restic.replicas: 1` in the values and reinstall 0.3.0 with the same PVC, configuration and Secrets:

```sh
helm upgrade --install backup "$CHART" --kube-context "$CTX" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" --set "services.$INSTANCE.replicas=1" --wait=legacy --timeout=5m
kubectl --context "$CTX" -n "$NS" wait --for=condition=Ready resticapplication/backup-restic --timeout=30m
kubectl --context "$CTX" -n "$NS" get resticapplication backup-restic -o json
```

The new application acquires ownership and performs fresh native admission of the existing repositories. Require current-generation Ready, verify repository identity and retained history, restore an old point and verify a new backup.

Namespace deletion is separate and destructive: it deletes retained PVCs and Secrets and may destroy storage contents according to the StorageClass reclaim policy.

### Scheduled replication

Configure each destination under `services.restic.replication` in the same shared file. Each entry creates an independent CronJob; consuming applications continue publishing only to the primary endpoint.

```yaml
services:
  restic:
    replication:
      - name: secondary
        repository: records
        sourceCredentialsSecret: records-repository-key
        destination:
          host: secondary.example.org
          repository: records
          credentialsSecret: records-replication-destination
        schedule: "*/15 * * * *"
        timeZone: Etc/UTC
        suspend: false
        activeDeadlineSeconds: 3600
```

The source must name a declared local repository. Destination hosts are credential-free HTTPS DNS names, with port 443 and a declared repository path. Entry names must be unique and at most 20 characters. Deploy the secondary separately with its own PVC, encryption password, authentication credentials and TLS certificate. For a new secondary, configure primary reader access as its recovery source: the same lifecycle copies native chunker parameters and retained history. Once established, its startup does not depend on the primary. Never reinitialize an existing secondary.

The source `records-repository-key` already supplies the local password. Create the destination Secret in the primary endpoint's namespace from independently protected files, not plaintext Helm values:

```sh
kubectl --context "$CTX" -n "$NS" create secret generic records-replication-destination \
  --from-file=username=/protected/secondary/username \
  --from-file=restPassword=/protected/secondary/writer.restPassword \
  --from-file=password=/protected/secondary/password \
  --from-file=ca.crt=/protected/secondary/ca.crt
```

The destination `username` file must contain `writer`, not `admin`. Its transport password is specific to that secondary repository. Retain the secondary reader credentials, encryption password and CA independently of the primary provider; restore does not require the primary password or replication Secrets. Source and destination encryption passwords may differ.

The worker mounts only the selected primary repository subdirectory at `/data/REPOSITORY` and uses `restic copy` against the authenticated secondary HTTPS endpoint. The source mount is writable for native lock creation/removal; the worker is a trusted backend component, not a read-only credential boundary. Required Pod affinity places it on the endpoint's node to share an existing ReadWriteOnce claim. Restic 0.19.1 shares one REST transport credential pair across repositories, so local source access avoids embedding either credential in a URL. The worker ServiceAccount can only read its named application intent and configured PVC; it cannot change workloads or Secrets.

Each run copies all snapshots currently available at the source. Native Restic origin/metadata matching skips existing copies; the next scheduled run catches up after an outage. Copies retain their original capture times, not the time replication ran. `concurrencyPolicy: Forbid` prevents overlap within one CronJob, while native source read and destination append locks exclude destructive maintenance across clients. Do not configure multiple jobs to copy the same source into the same destination: nonexclusive copy locks are not cross-job deduplication serialization. Use distinct destination repositories; never point replication back at the source.

Schedules default to UTC. A missed start is eligible for 60 seconds; later missed ticks need not be replayed because the next run scans available history. The default one-hour active deadline bounds a stuck run and is configurable for repository size and bandwidth. Each Job has no Kubernetes retry and never unlocks or initializes repositories. The wrapper preserves native error exit codes and reports cancellation as failed work. Inspect a failure before intervention; after a killed process, prove that its owner has ended before removing stale locks. The controller admits schedules only while the current application is Ready; stop suspends schedules and cancels already running copies.

Each copy Job retains immutable configuration for its initiating application generation and is bound to the verified PVC UID. Replacing a claim under the same name does not authorize an older queued copy to use the replacement volume. Changing application spec cancels work from the older generation, including queued copies; the next permitted schedule uses the new configuration. Secret files remain mounted Kubernetes Secrets, so rotation affects active mounts as well as future Pods. Do not rotate credentials midway through an operation that must finish uninterrupted.

Replication has its own Job status and logs, separate from application backup results:

```sh
kubectl -n backup get cronjobs,jobs -l bartl-restic/replication=secondary
kubectl -n backup describe cronjob backup-restic-copy-secondary
kubectl -n backup logs job/SELECTED_REPLICATION_JOB
```

Three successful and three failed Jobs are retained per destination. Export Job results and logs if longer history or alerting is required. Monitor failed or overdue Jobs and the newest usable secondary snapshot's capture time, not just `lastSuccessfulTime`: a successful no-op copy does not prove a recent application backup. A copy Job completing means native copying succeeded; it does not substitute for a secondary `check --read-data` and a restore qualification. Missing Secrets, unavailable endpoints, wrong credentials and conflicting maintenance locks remain visible as failed or blocked work rather than changing primary backup success.

Secondary retention is administered separately with its own admin credentials and the maintenance Job below. Copy never invokes `forget`, `prune` or deletion, and source absence never deletes secondary history. A point deliberately removed at the secondary will be copied again while it remains at the primary; coordinate the two retention policies accordingly. Primary retention must leave enough history for the agreed replication-outage window, because a snapshot deleted before copying cannot be recovered by catch-up.

### Native maintenance

The optional Job accepts only `check` (full `check --read-data`) or `forget-prune` for one operator-selected full snapshot ID. Native Restic acquires its exclusive maintenance lock and fails on conflicting active locks; no lock bypass, automatic unlock, raw command or implicit initialization is exposed. Choose a unique Job name for each invocation. There is no automatic retention selection.

```sh
# Generate only the Job from the same endpoint values.
helm template backup "$CHART" -n "$NS" -f "$VALUES" \
  --set-string instance="$INSTANCE" \
  --set "services.$INSTANCE.maintenance.enabled=true" \
  --set "services.$INSTANCE.maintenance.name=check-20261117" \
  --set "services.$INSTANCE.maintenance.repository=records" \
  --set "services.$INSTANCE.maintenance.action=check" \
  --set-string "services.$INSTANCE.maintenance.host=$RESTIC_HOST" \
  --set "services.$INSTANCE.maintenance.credentialsSecret=records-repository-admin" \
  --show-only templates/maintenance.yaml |
  kubectl --context "$CTX" -n "$NS" apply -f -
kubectl --context "$CTX" -n "$NS" wait --for=condition=complete job/backup-restic-check-20261117 --timeout=30m
kubectl --context "$CTX" -n "$NS" logs job/backup-restic-check-20261117
```

The host must be covered by the certificate and reachable from the Job; admin credentials must include its validating `ca.crt`. For deletion, replace `services.$INSTANCE.maintenance.action=check` with `services.$INSTANCE.maintenance.action=forget-prune`, add `--set-string "services.$INSTANCE.maintenance.snapshot=$FULL_SNAPSHOT_ID"` and choose a fresh name. Retain the Job/logs as the operation result; inspect failed Jobs rather than retrying blindly. Stale locks require an operator to establish that the owning operation has ended before using native Restic unlock separately.

## Qualification and test output

Exact historical evidence remains in:

- [Scheduled replication and direct secondary restore](evidence/2026-11-02-replication.json).
- [Kubernetes endpoint authorization, maintenance and replacement](evidence/2026-11-02-kubernetes.json).
- [Native-process endpoint authorization](evidence/2026-11-02-endpoint.json).
- [Native copy, interruption and independent retention](evidence/2026-11-02-restic-copy.json).

These scenarios used separate PVCs in one cluster, not a cross-provider outage. Native copy retry preserves selectable points without duplicate snapshots; retransmitted data is not bounded. Consumers own application compatibility. The [Keycloak recovery qualification](https://github.com/bartlapp/bartl-keycloak/blob/main/evidence/2026-11-02-secondary-recovery.json) covers the compatible native worker, not a published image or complete controller lifecycle.

Run the executable scenarios only against an explicitly authorized disposable Hetzner cluster with a default StorageClass and registry access:

```sh
export BARTL_RESTIC_LAB=hetzner KUBECONFIG=/private/lab-kubeconfig
export BARTL_RESTIC_IMAGE=REGISTRY/RETAINED_QUALIFICATION_IMAGE
node tests/lifecycle.mjs
node tests/kubernetes.mjs
node tests/replication.mjs
node tests/observation.mjs
```

Each runner creates a namespace and, on success, finalizes stopped applications before Helm uninstall and separate destruction of the disposable namespace/data. Failures retain diagnostics and refer to supported uninstall. Runners do not provision infrastructure or establish provider cleanup/cost; the operator deletes the lab, verifies removal and records the budget outcome. Use Hetzner; Colima/local Docker needs explicit permission. The image must be cluster-accessible; a lab may build on its Hetzner host and import into containerd instead of publishing.

The observation runner isolates the endpoint's API traffic while authenticated clients remain available. Its IPv4 fixture needs enforced egress NetworkPolicy, API Service/EndpointSlice and node-address reads, and a temporary root probe with `NET_ADMIN`. Namespace-local rejection rules also cover replacement Pods and defeat CNI-preserved connections. Acceptance requires failed API requests and the guard's observation-failure log. It also checks ServiceAccount permissions, fresh-process admission and direct-to-Pod nginx drainage with a native Restic pack.

Output defaults to a private external temporary directory. `BARTL_RESTIC_EVIDENCE_DIR` selects another external path; checkout paths and symlink aliases are rejected. `raw.json` holds redacted diagnostics; `qualification.json` holds the selected summary and source provenance. Values and manifests are run artifacts. Provenance records run-start HEAD, dirty state and SHA-256 of chart, controller/worker, dependencies, image-build and test files; dirty runs qualify those bytes, not HEAD alone.

Use `go test ./...` for native boundary regressions and `node --test tests/artifacts.test.mjs` for output isolation, compact-record selection and provenance. Cluster scenarios establish service behavior. Keep artifacts outside Git; put tested versions, concise results, material limits and cleanup/budget outcome in the integration description. Do not add session reports, transcripts, object dumps or nested regression records. Existing historical evidence stays available.

For idle behavior, run `go test ./internal/native ./internal/controller`. Put native Restic 0.19.1 on `PATH` to exercise `TestIdleLifecycleAddsFirstNativeRepository`; without it that test explicitly skips. Other idle regressions exercise storage exclusion, interrupted-transition refusal, undeclared-data preservation, idle credential mounts, stop/resume admission and invalidation of idle success when adding the first repository. These tests do not replace exact-release cluster qualification: install `services.restic.repositories: []`, verify current-generation Ready and TLS HTTP 404, stop/resume, then add a repository and qualify authenticated backup/restore with the 0.3.0 chart and its pinned image.

To exercise supported uninstall against the published artifacts, use the verified `CHART` and set `IMAGE` to the combined controller/worker digest recorded for that exact release on an authorized disposable Hetzner cluster:

```sh
BARTL_RESTIC_LAB=hetzner KUBECONFIG=/private/lab-kubeconfig BARTL_RESTIC_REUSE=1 \
  BARTL_RESTIC_CHART="$CHART" BARTL_RESTIC_IMAGE="$IMAGE" \
  node tests/uninstall.mjs
```

This regression verifies finalization with the controller alive, PVC/Secret preservation, same-PVC reinstall with unchanged repository identity/history, old/new backups and restores, contender exclusion and stale-worker refusal, then separate namespace destruction. It emits assertions and external redacted raw logs only, not a qualification report.

To qualify migration from published 0.2.1 into the shared-file release, add the retained source references:

```sh
BARTL_RESTIC_LAB=hetzner KUBECONFIG=/private/lab-kubeconfig BARTL_RESTIC_REUSE=1 \
  BARTL_RESTIC_CHART="$CHART" BARTL_RESTIC_IMAGE="$IMAGE" \
  BARTL_RESTIC_UPGRADE_FROM_CHART="$OLD_CHART" \
  BARTL_RESTIC_UPGRADE_FROM_IMAGE="$OLD_IMAGE" \
  node tests/uninstall.mjs
```

This scenario first installs and backs up through 0.2.1, migrates the same installation into the 0.3.0 shared-file interface, verifies preserved identity/history and an old-point restore, then performs supported uninstall and same-PVC reinstallation of 0.3.0. Historical 0.2.x results do not qualify the new artifacts or procedure.

## Release maintenance and licensing

Follow the Bartl publication convention: public OCI packages under `ghcr.io/bartlapp`, independent of private source-repository access. Never overwrite a released image or chart version, change existing visibility or alter team access as part of a release.

1. Inspect live GitHub repository policy/access and organization/package authority before remote writes. Registry publication requires `write:packages`; new GHCR packages need explicit public-visibility approval and an administrator to complete that setting.
2. Commit release changes separately. Build the combined image from the committed source on an authorized Hetzner host using `Dockerfile`, `--platform linux/amd64`, `--provenance=false`, `--build-arg VERSION=VERSION` and `--build-arg REVISION=FULL_SOURCE_SHA`. Retain the source archive and OCI image archive outside Git.
3. Set the chart version and pin its default image to the retained manifest digest. Stage a copy of `chart/` with root `LICENSE` and `NOTICE` included, then `helm package` that directory. Retain the chart archive and SHA-256. The published 0.2.1 archive includes those notices and `crds/resticapplications.yaml`.
4. Publish the retained image with digest preservation and the retained chart to `oci://ghcr.io/bartlapp`. Use isolated temporary registry credentials and remove them afterward. Do not rebuild or repackage between verification and publication.
5. With empty registry credentials, acquire the complete chart and image, verify archive/manifest identities, then smoke-install the published chart on a disposable Hetzner cluster. Verify current-generation startup, authenticated backup/restore, stop/start and actual runtime image IDs against the published digest.
6. Put artifact identities, concise verification, material limits and provider cleanup/budget outcome in the release/integration description. Integrate through the permitted GitHub workflow without squashing; keep raw logs outside Git and delete disposable infrastructure.

Original code and configuration use [Apache-2.0](LICENSE); documentation and methodology use CC-BY-4.0 as stated in [NOTICE](NOTICE). The image contains project and linked dependency notices under `/usr/share/licenses/bartl-restic/`; upstream components retain their own terms.

## Sources

- [Restic: copying snapshots between repositories](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#copying-snapshots-between-repositories).
- [rest-server 0.14.0](https://github.com/restic/rest-server/blob/v0.14.0/README.md).
- [Restic 0.19.1 copy implementation: locks, origin identity and publication](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/cmd_copy.go).
- [Restic 0.19.1 backend retry defaults](https://github.com/restic/restic/blob/v0.19.1/internal/global/global.go).
- [Restic 0.19.1 native object listing](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/cmd_list.go).
