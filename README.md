# Bartlized Restic backend

This package exposes authenticated Restic HTTPS endpoints on existing Kubernetes storage under the [Bartl application contract](https://github.com/bartlapp/bartl-app/blob/main/docs/application-contract.md#portable-recovery-artifact-and-storage-boundary). [Kubernetes operating packages](https://github.com/bartlapp/bartl-app/blob/main/docs/how-to-bartlize.md#kubernetes-operating-packages) explains the controller model; [operating and handing over an installation](https://github.com/bartlapp/bartl-app/blob/main/docs/how-to-bartlize.md#operate-and-hand-over-an-installation) covers the human-executed cross-application sequence. This README defines the Restic-specific storage, replication, recovery and maintenance procedures.

## Service and state boundary

The service owns repository storage, access protection, replication and its own recovery; retention is administered through native maintenance. Each application writes to one endpoint with separate repository, encryption key and credentials. The service does not capture or reconstruct consumers. Repository-operation exclusion belongs at the repository-access boundary, not in application-specific integrations.

Mutable state consists of the encrypted Restic repository directories, including their identities and retained snapshot history. The [customer installation repository](https://github.com/bartlapp/bartl-app/blob/main/docs/how-to-bartlize.md#customer-installation-repository) holds deployment configuration, pinned software references, repository declarations, access and retention policies, and references to protected credentials. Configuration in Git does not replace repository data. Keys, credentials and configuration must remain available independently of the provider whose loss they cover.

### Required installation decisions

Before relying on the service, record the covered failures and independently usable primary/secondary endpoints, exact artifacts and effective Helm values, storage/TLS/network prerequisites and protected recovery-input locations in the customer installation repository. Assign operating responsibility for publication/replication monitoring, native integrity checks, restore qualification, retention maintenance and replacement authorization.

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

`restic copy` copies snapshots into an independently initialized repository, skips previously copied snapshots and does not mirror source deletions. The worker needs both repositories' encryption keys because copying decrypts and re-encrypts data. Initialize the secondary with `init --from-repo ... --copy-chunker-params` and a separate password.

Recovery selects and binds the destination's full snapshot ID. A copied snapshot preserves the source's `tree`; its `original` field identifies the originating snapshot. Restic preserves an existing `original` value on further copies, so it is not necessarily the immediately preceding repository's snapshot ID. Use native snapshot metadata to establish correspondence; do not assume identical snapshot IDs or treat producer-supplied metadata as proof of application completeness.

The copy worker uses Restic's source read lock and destination append lock. Keep destructive maintenance excluded from replication and recovery through native Restic locks. Recovery access is read-only for backup contents but permits native lock creation/removal. After a crash, establish that the owning operation has ended before removing a stale lock; never blindly unlock on retry. Independent secondary retention must not translate source absence into deletion.

## Endpoint package

`chart/` renders a namespaced `ResticApplication`, its Go/controller-runtime controller and scoped RBAC. The controller owns the endpoint Deployment, HTTPS Service, nginx configuration, NetworkPolicy, finite lifecycle Job and replication CronJobs. Helm owns intent, not the workloads' replica counts or serving gate. The existing PVC and Secrets remain operator-owned. The package never creates or deletes repository storage and does not schedule retention. rest-server is pinned to a 0.14.0 image digest, nginx to 1.28.0 and native Restic to 0.19.1.

Each declared repository has one URL, `rest:https://HOST/REPOSITORY/`, and its own authentication Secret. That Secret's `htpasswd` contains accounts named exactly `writer`, `reader` and `admin`, with different passwords for each account and repository. An authenticated unknown username receives HTTP 403. Do not duplicate account passwords across repositories: the per-repository files are the credential boundary.

- `writer` reaches append-only rest-server: it may add backup objects and manage native locks, but may not overwrite or delete backup contents.
- `reader` may GET/HEAD repository contents and POST/DELETE only `/REPOSITORY/locks/<64 lowercase hex characters>`. It cannot write/delete data, snapshots, indexes, keys or config. Recovery therefore participates in native Restic locks rather than bypassing them.
- `admin` reaches the full backend. Keep it out of application writer/recovery Secrets. It is the separate authority for destructive maintenance.

Native locks coordinate cooperative Restic clients. A holder of reader or writer credentials can delete lock objects; locks are not protection against a malicious credential holder. Neither the chart nor maintenance disables consumers or automatically unlocks a repository.

### Published release 0.2.1

Install the published Helm chart and combined controller/worker image; no source checkout or build is required. The image supports `linux/amd64`. Retain these immutable references with the installation configuration:

```sh
CHART=oci://ghcr.io/bartlapp/bartl-restic@sha256:78d118df791192bcc8dc08ce7ce13ded3ac01b51c33cd19090c30cb7c2d8f20a
IMAGE=ghcr.io/bartlapp/bartl-restic-controller@sha256:3ee7994268a23b4beff8a10d6ecc77c13471baa7d4f9e073c4a8dad852deb757
```

The chart pins this image; no override is needed. Version tags are `0.2.1`, but the commands use the chart digest. The archive SHA-256 is `94293548ac5fd0a86976e4af0e678596a53c8d0144dad1983810cea64c9a4dfc`. Release 0.2.1 adds retained-PVC reuse after supported uninstall; 0.2.0 artifacts remain unchanged.

Use Helm 4.3.0, a cluster-compatible kubectl, OpenSSL and jq. The cluster needs amd64 nodes, registry egress, an existing writable ReadWriteOnce PVC, and permissions to install the cluster-scoped `ResticApplication` CRD and namespaced resources. Enforce NetworkPolicy through the cluster CNI. Supply TLS and DNS/routing for the endpoint as described below.

Select the intended kubeconfig/context before running these commands. Prepare namespace `backup` and check the operator-owned claim named `repository`:

```sh
kubectl config current-context
kubectl create namespace backup --dry-run=client -o yaml | kubectl apply -f -
kubectl -n backup get pvc repository
```

For a new installation, create that claim using the installation's StorageClass and capacity before continuing. Do not reuse a claim owned by another active installation. Preserve the claim and all protected inputs when uninstalling the chart.

### Install inputs

Supply an empty PVC for a new installation or replacement, or the intact claim for restart. Every repository needs its own authentication Secret and a `passwordSecret` containing its independently retained encryption `password`. The controller withholds access while the native worker observes, initializes or reconstructs and verifies repositories. No manual initialization, recovery flag or second release command is required.

A recovery declaration names an independent HTTPS repository and reader Secret (`username=reader`, `restPassword`, `password`, `ca.crt`). Missing or unreachable recovery is an error, not empty history; intact local state needs neither recovery credentials nor that endpoint. Reconstruction uses native `init --copy-chunker-params` and `copy`, full destination `check --read-data` and snapshot `original`/`tree`/capture-time correspondence for every selected point. Ordinary existing-state admission checks metadata integrity, not a full data scrub.

Create the TLS Secret from an operator-provided certificate/key whose SAN covers the chosen endpoint DNS name. Create one htpasswd Secret per repository. For example, from a protected local directory containing the three transport password files and independently retained Restic `password` and CA `ca.crt`:

```sh
umask 077
for role in writer reader admin; do
  printf '%s:%s\n' "$role" "$(openssl passwd -apr1 -stdin < "$role.restPassword")"
done > htpasswd
kubectl -n backup create secret generic records-repository-auth --from-file=htpasswd
kubectl -n backup create secret generic repository-key --from-file=password
kubectl -n backup create secret tls repository-tls --cert=tls.crt --key=tls.key
# The admin transport credential and encryption key are separate protected inputs.
printf '%s' admin > username
kubectl -n backup create secret generic records-repository-admin \
  --from-file=username --from-file=restPassword=admin.restPassword \
  --from-file=password --from-file=ca.crt
```

If recovery is configured, create its reader Secret from the independently retained secondary files:

```sh
kubectl -n backup create secret generic secondary-reader \
  --from-file=username=/protected/secondary/reader.username \
  --from-file=restPassword=/protected/secondary/reader.restPassword \
  --from-file=password=/protected/secondary/password \
  --from-file=ca.crt=/protected/secondary/ca.crt
```

The `reader.username` file must contain `reader`. Secondary credentials are only needed for absent local state.

Keep these files outside Git. Consumer writer/reader Secrets need their matching `username`, `restPassword`, `password`, and `ca.crt`; no credential belongs in a URL or chart value. The CA must validate the endpoint certificate, not an unrelated provider certificate.

Example customer values (`endpoint-values.yaml`, no passwords):

```yaml
# The published chart supplies its digest-pinned controller/worker image.
application:
  replicas: 1
existingClaim: repository
tlsSecret: repository-tls
repositories:
  - name: records
    authSecret: records-repository-auth
    passwordSecret: repository-key
    # Add only when an independently retained secondary is configured:
    # recovery:
    #   host: secondary.example.org
    #   repository: records
    #   credentialsSecret: secondary-reader
```

```sh
helm upgrade --install backup "$CHART" -n backup -f endpoint-values.yaml \
  --wait=legacy --timeout=5m
kubectl -n backup wait --for=condition=Ready resticapplication/backup-restic --timeout=30m
kubectl -n backup get resticapplication backup-restic -o json
JOB=$(kubectl -n backup get resticapplication backup-restic -o jsonpath='{.status.operation.jobName}')
kubectl -n backup logs "job/$JOB"
kubectl -n backup get service backup-restic
```

Provide DNS/routing for the TLS hostname to this Service; the chart does not provision DNS, ingress, load balancers or certificates. Its NetworkPolicy permits ingress only to TLS port 8443 when enforced by the cluster CNI. The rest-server listeners remain loopback-only even without policy enforcement. Changes to local password, authentication or TLS Secrets trigger controlled re-admission and endpoint restart.

Require `status.observedGeneration` and the selected condition's `observedGeneration` to equal live `metadata.generation`. `Ready=True` reports the current running endpoint, `Stopped=True` reports drained application work, and `Failed=True` retains a refused or interrupted lifecycle. A successful Helm invocation is not lifecycle completion; with Helm 4 use `--wait=legacy` for controller infrastructure and inspect application status separately. `status.operation` binds the admitted Job, application/PVC ownership, initiating generation and input hash; stale or missing execution results cannot open access.

The CRD is included in the published chart. Helm installs a missing CRD but does not upgrade an existing definition. Before a package upgrade, extract the selected published chart and explicitly apply its CRD:

```sh
PACKAGE_DIR=$(mktemp -d)
helm pull "$CHART" --untar --untardir "$PACKAGE_DIR"
kubectl apply -f "$PACKAGE_DIR/bartl-restic/crds/"
```

Upgrading the former endpoint-only chart is an ownership cutover with interruption: retain the PVC/Secrets, add each repository's `passwordSecret`, apply the selected CRD, then upgrade. Helm removes the old directly rendered endpoint resources; the controller recreates them only after native admission. Do not run the old release or another controller against the same claim.

### Durable stop and replacement

Set run/stop intent through Helm, not by scaling generated Deployments:

```sh
helm upgrade backup "$CHART" -n backup -f endpoint-values.yaml \
  --set application.replicas=0
kubectl -n backup wait --for=condition=Stopped resticapplication/backup-restic --timeout=5m
kubectl -n backup get resticapplication backup-restic -o json
kubectl -n backup get pods,jobs,cronjobs
```

To resume this installation, retain `application.replicas: 1` in its values and use the same package:

```sh
helm upgrade backup "$CHART" -n backup -f endpoint-values.yaml \
  --set application.replicas=1
kubectl -n backup wait --for=condition=Ready resticapplication/backup-restic --timeout=30m
kubectl -n backup get resticapplication backup-restic -o json
```

Retain `application.replicas: 0` in the old installation's versioned values. The controller withdraws serving, suspends new copy admission, scales the endpoint down and gracefully terminates running lifecycle/copy work. Every endpoint process requires fresh successful application and live-PVC admission before nginx starts. An observed stop, revoked ownership, changed identity, deletion or withdrawn successful admission terminates serving through SIGQUIT. Lifecycle and replication workers retain their fail-closed observation policy and receive SIGINT on cancellation. A bounded kill is a last resort after cancellation, not an expiry of serving permission.

An already-admitted endpoint continues backups and restores when API observation is unavailable. It reports the failure and keeps checking without changing readiness solely for that failure. A confirmed negative from either the application or bound PVC wins over an unavailable check of the other. The controller leaves the established endpoint and configuration unchanged without claiming fresh verification. A replacement process needs fresh admission; it cannot inherit permission during an outage.

An API partition can therefore leave the endpoint serving indefinitely unless another control path terminates it. Request timeouts bound observations, not permission validity. Before replacement, require confirmed drainage or retirement, not merely stop intent or an unreachable primary. Stop completes only after acknowledged Deployment/ReplicaSet scale-down and disappearance of required active Pods. Cancellation deletes Jobs and their Pods; export needed logs first.

A completed stop invalidates successful native admission. The next start observes and checks the retained repositories again; ordinary controller or process restarts while running do not reinitialize them. Failed operations remain failed across stop/start. A rejected installation that never acquired the claim can stop or be deleted without stopping its rightful owner.

For a planned replacement, first obtain current-generation `Stopped=True`, confirm there are no active endpoint/lifecycle/copy Pods and preserve that stop intent. If final primary-only history must be preserved, let replication finish and verify the secondary before stopping. Install the replacement with a fresh claim, the retained configuration/credentials and the surviving secondary as recovery source. After automatic reconstruction and `Ready=True`, verify an older recovery point, a new backup and access protection, then switch the service route. Keep the old installation stopped or retire it; do not reapply its old running values.

For destroyed infrastructure, establish that the old primary can no longer serve or replicate before activating its replacement. An unreachable primary is not proof of retirement. This package does not invent cross-cluster fencing: if the old primary might still be active and its authority cannot independently be withdrawn, do not activate a replacement. Changing DNS alone is insufficient. Claim ownership prevents competing controllers from adopting the same PVC inside the supported cluster; it does not fence another provider.

An interrupted state-changing worker leaves a durable marker on the PVC. A failed or missing admitted Job is also retained as failure in application status. A later restart or run intent does not clear either failure. Inspect the Job, worker logs and native locks; retain evidence, discard the failed target and repeat ordinary installation on fresh storage. Do not remove the marker or blindly unlock to make startup succeed. The secondary stays usable with its separate reader credentials; reconstruction never runs exclusive maintenance or deletion there.

For damaged-history diagnosis, enumerate native IDs with `restic list snapshots` and inspect each with `restic cat snapshot FULL_ID`. Restic's presentation command `snapshots --json` may warn and omit unreadable objects while returning success. Lifecycle observation therefore uses the strict object inventory, not an apparently empty presentation listing.

Transient backend errors follow Restic 0.19.1's native 15-minute retry window per operation. During retries the lifecycle remains unserved and logs the underlying errors; exhausted retries produce `Failed`, never initialization. Stop intent cancels those native waits too.

### Upgrade 0.2.0 before removal

Upgrade the existing installation to 0.2.1 before deleting its application. The fixed controller must perform finalization; installing 0.2.1 after a 0.2.0 uninstall cannot retroactively release an orphaned binding. Keep the same PVC and independently retained configuration/Secrets. With `CHART` and `IMAGE` set to the 0.2.1 references above, upgrade a running installation:

```sh
(
  set -eu
  helm upgrade backup "$CHART" -n backup -f endpoint-values.yaml \
    --set application.replicas=1 --wait=legacy --timeout=5m
  kubectl -n backup rollout status deployment/backup-restic-controller --timeout=3m
  GENERATION=$(kubectl -n backup get resticapplication backup-restic \
    -o jsonpath='{.metadata.generation}')
  kubectl -n backup wait resticapplication/backup-restic \
    --for=jsonpath='{.status.observedGeneration}'="$GENERATION" --timeout=30m
  kubectl -n backup wait resticapplication/backup-restic \
    --for=condition=Ready --timeout=30m
  APPLICATION=$(kubectl -n backup get resticapplication backup-restic -o json)
  printf '%s\n' "$APPLICATION" | jq -e --arg image "$IMAGE" '
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

Confirm repository identity and retained history and restore an old point before continuing with supported uninstall. Keep the upgraded controller running through application deletion. There is no annotation-clearing or finalizer-bypass step for already-orphaned bindings.

### Supported uninstall

Stop and confirm current-generation drainage, delete the `ResticApplication` while its controller is running, then uninstall Helm. Keep `application.replicas: 0` in `endpoint-values.yaml` and prevent other operators or reconcilers from restoring running intent. Do not delete the namespace/controller first or bypass finalizers. Export needed logs before stopping. With the same `CHART` and values:

```sh
(
  set -eu
  helm upgrade backup "$CHART" -n backup -f endpoint-values.yaml \
    --set application.replicas=0
  GENERATION=$(kubectl -n backup get resticapplication backup-restic \
    -o jsonpath='{.metadata.generation}')
  kubectl -n backup wait resticapplication/backup-restic \
    --for=jsonpath='{.status.observedGeneration}'="$GENERATION" --timeout=5m
  kubectl -n backup wait resticapplication/backup-restic \
    --for=condition=Stopped --timeout=5m
  APPLICATION=$(kubectl -n backup get resticapplication backup-restic -o json)
  printf '%s\n' "$APPLICATION" | jq -e '
      .metadata.generation as $generation |
      .spec.replicas == 0 and
      .status.state == "Stopped" and
      .status.observedGeneration == $generation and
      any(.status.conditions[]?;
        .type == "Stopped" and .status == "True" and
        .observedGeneration == $generation)
    ' >/dev/null

  kubectl -n backup delete resticapplication backup-restic \
    --wait=true --timeout=3m
  helm uninstall backup -n backup --wait --timeout=3m

  kubectl -n backup get pvc repository
  kubectl -n backup get secret repository-tls repository-key \
    records-repository-auth records-repository-admin
)
```

The subshell stops on any failed check or timeout. Keep the controller running and inspect application status, Pods and controller logs before continuing; never remove finalizers to force completion. An unavailable API or incomplete drainage is not permission to uninstall.

The operator-owned PVC, repository data, Secrets and shared CRD survive uninstall. In 0.2.1, deletion confirms drainage again and conditionally releases only this application's claim binding; ordinary stop retains ownership and the finalizer. Unavailable observations or conflicting writes leave removal incomplete. Failed/interrupted work keeps the claim fenced; uninstall clears neither failure markers nor native locks.

After successful finalization and Helm uninstall, retain `application.replicas: 1` in the values and reinstall 0.2.1 with the same PVC, configuration and Secrets:

```sh
helm upgrade --install backup "$CHART" -n backup -f endpoint-values.yaml \
  --set application.replicas=1 --wait=legacy --timeout=5m
kubectl -n backup wait --for=condition=Ready resticapplication/backup-restic --timeout=30m
kubectl -n backup get resticapplication backup-restic -o json
```

The new application acquires ownership and performs fresh native admission of the existing repositories. Require current-generation Ready, verify repository identity and retained history, restore an old point and verify a new backup.

Namespace deletion is separate and destructive: it deletes retained PVCs and Secrets and may destroy storage contents according to the StorageClass reclaim policy.

### Scheduled replication

Configure each destination in the primary endpoint's customer Helm values. Each entry creates an independent CronJob; consuming applications continue publishing only to the primary endpoint.

```yaml
replication:
  - name: secondary
    repository: records
    sourceCredentialsSecret: repository-key
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

The source `repository-key` already supplies the local password. Create the destination Secret in the primary endpoint's namespace from independently protected files, not plaintext Helm values:

```sh
kubectl -n backup create secret generic records-replication-destination \
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
helm template backup "$CHART" -n backup -f endpoint-values.yaml \
  --set maintenance.enabled=true --set maintenance.name=check-20261102 \
  --set maintenance.repository=records --set maintenance.action=check \
  --set maintenance.host=backup-restic.backup.svc \
  --set maintenance.credentialsSecret=records-repository-admin \
  --show-only templates/maintenance.yaml | kubectl -n backup apply -f -
kubectl -n backup wait --for=condition=complete job/backup-restic-check-20261102 --timeout=30m
kubectl -n backup logs job/backup-restic-check-20261102
```

The example host must be covered by the certificate and reachable from the Job. For deletion, replace `action=check` with `action=forget-prune`, add `--set-string maintenance.snapshot="$FULL_SNAPSHOT_ID"` and choose a fresh name. Retain the Job/logs as the operation result; inspect failed Jobs rather than retrying blindly. Stale locks require an operator to establish that the owning operation has ended before using native Restic unlock separately.

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

To exercise supported uninstall against the published artifacts, use the `CHART` and `IMAGE` references from the installation section on an authorized disposable Hetzner cluster:

```sh
BARTL_RESTIC_LAB=hetzner KUBECONFIG=/private/lab-kubeconfig BARTL_RESTIC_REUSE=1 \
  BARTL_RESTIC_CHART="$CHART" BARTL_RESTIC_IMAGE="$IMAGE" \
  node tests/uninstall.mjs
```

This regression verifies finalization with the controller alive, PVC/Secret preservation, same-PVC reinstall with unchanged repository identity/history, old/new backups and restores, contender exclusion and stale-worker refusal, then separate namespace destruction. It emits assertions and external redacted raw logs only, not a qualification report.

For the published 0.2.0-to-0.2.1 upgrade scenario, add the source references to the same invocation:

```sh
BARTL_RESTIC_LAB=hetzner KUBECONFIG=/private/lab-kubeconfig BARTL_RESTIC_REUSE=1 \
  BARTL_RESTIC_CHART="$CHART" BARTL_RESTIC_IMAGE="$IMAGE" \
  BARTL_RESTIC_UPGRADE_FROM_CHART=oci://ghcr.io/bartlapp/bartl-restic@sha256:aeaa22dd009fd505c86049de285c81e0a44ab68640f528dc297d6d67efd306de \
  BARTL_RESTIC_UPGRADE_FROM_IMAGE=ghcr.io/bartlapp/bartl-restic-controller@sha256:3bbc370143d7d6363522643bb9c1f71b634176512696040669b5a3168a086446 \
  node tests/uninstall.mjs
```

It first installs and backs up through 0.2.0, upgrades the existing application to 0.2.1, verifies preserved identity/history and an old-point restore, then performs supported uninstall and same-PVC reinstallation of 0.2.1. For an unpublished candidate, the target `BARTL_RESTIC_CHART` may instead name a packaged `.tgz` pinned to an immutable image already available in the authorized Hetzner cluster; the source chart must remain a digest-pinned published reference.

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
