# Bartlized Restic backend

This repository packages an authenticated Restic HTTPS endpoint on existing Kubernetes storage under the [Bartl application contract](../bartl-app/README.md#portable-recovery-artifact-and-storage-boundary). [ADR-11](../../floriankesslergmbh/floriankesslergmbh/adr/ADR-11-Uebergebbare-Backup-Architektur/README.md) selects Restic and defines the backup and handover requirements for the reference installation.

## Service and state boundary

The service exposes authenticated Restic REST endpoints using `rest-server`. It owns repository storage, access protection, retention, replication and its own recovery. It does not know which applications consume its endpoints and does not capture, stop or reconstruct those applications. Any required exclusion between repository operations belongs at the repository-access boundary, not in application-specific integrations.

Each consuming application writes to one endpoint. Replication is the backup service's responsibility, not a multi-destination workflow implemented by each consumer. Repositories, encryption keys and access are separated per application.

Mutable state consists of the encrypted Restic repository directories, including their identities and retained snapshot history. The per-customer Git repository holds deployment configuration, pinned software references, repository declarations, access and retention policies, and references to protected credentials. Configuration in Git does not replace repository data. Keys, credentials and configuration must remain available independently of the provider whose loss they cover.

## Disaster recovery

Loss of one provider must not require reconstruction of the backup service before application recovery can begin. The service maintains an independently usable repository at another provider, exposed through its own endpoint. A retained archive that must first be fully restored into a repository does not meet this objective.

After loss of the primary provider, a replacement application reads its selected recovery point directly from the secondary endpoint using independently available credentials and keys. Rebuilding the lost backup endpoint is a separate operation, not a prerequisite for restoring consumers. Provider names, endpoint URLs and recovery inputs belong in the per-customer configuration.

Replication is asynchronous. A recovery point is protected against primary-provider loss only after its secondary copy is complete and verified. The age of the newest usable secondary recovery point determines the recovery-point window; nominal replication frequency alone is not evidence of protection. Primary publication and secondary replication outcomes must remain distinguishable.

The secondary retains history independently. Deletion or compromise at the primary must not automatically erase the secondary's retained history. Repository maintenance and replication must preserve usable recovery points without relying on application-specific coordination.

Repository and snapshot identities need not be equal across providers. Recovery must select and bind a complete, valid, compatible point in the chosen repository; a primary snapshot ID must not be assumed to identify its secondary copy. Preserving access to the agreed history matters, not byte-identical reconstruction of the lost backend before consumers can recover.

To inspect secondary recovery points or recover repository files, use the secondary reader credentials and full snapshot ID. Application reconstruction follows the consuming application's recovery procedure.

```sh
export RESTIC_REPOSITORY="rest:https://$SECONDARY_HOST/$REPOSITORY/"
export RESTIC_PASSWORD_FILE=/protected/secondary/password
export RESTIC_REST_USERNAME=reader
export RESTIC_REST_PASSWORD="$(cat /protected/secondary/reader.restPassword)"
restic --cacert /protected/secondary/ca.crt snapshots --json
restic --cacert /protected/secondary/ca.crt restore "$FULL_SNAPSHOT_ID" --target "$RESTORE_DIR"
```

For recovery of an individual endpoint, attach an intact repository PVC to a suitable Kubernetes cluster, apply the declared package configuration and protected credentials, verify repository integrity and access protection, then serve. If that volume is lost, reconstruct the endpoint's state separately while the surviving endpoint remains available for application recovery.

## Replication mechanism

`restic copy` copies snapshots into an independently initialized repository, skips previously copied snapshots and does not mirror source deletions. The worker needs both repositories' encryption keys because copying decrypts and re-encrypts data. Initialize the secondary with `init --from-repo ... --copy-chunker-params` and a separate password.

Recovery selects and binds the destination's full snapshot ID. A copied snapshot preserves the source's `tree`; its `original` field identifies the originating snapshot. Restic preserves an existing `original` value on further copies, so it is not necessarily the immediately preceding repository's snapshot ID. Use native snapshot metadata to establish correspondence; do not assume identical snapshot IDs or treat producer-supplied metadata as proof of application completeness.

The copy worker uses Restic's source read lock and destination append lock. Keep destructive maintenance excluded from replication and recovery through native Restic locks. Recovery access is read-only for backup contents but permits native lock creation/removal. After a crash, establish that the owning operation has ended before removing a stale lock; never blindly unlock on retry. Independent secondary retention must not translate source absence into deletion.

## Endpoint package

`chart/` deploys one `Recreate` Deployment, an existing PVC, nginx HTTPS/authentication, an append-only rest-server and a full-access rest-server, plus optional replication CronJobs. Both rest-server processes listen only on Pod loopback. The Service exposes only HTTPS. The chart does not create or delete the PVC, initialize repositories, implement a controller or schedule retention. rest-server is pinned to a 0.14.0 image digest, nginx to 1.28.0 and maintenance/replication Restic to 0.19.1.

Each declared repository has one URL, `rest:https://HOST/REPOSITORY/`, and its own authentication Secret. That Secret's `htpasswd` contains accounts named exactly `writer`, `reader` and `admin`, with different passwords for each account and repository. An authenticated unknown username receives HTTP 403. Do not duplicate account passwords across repositories: the per-repository files are the credential boundary.

- `writer` reaches append-only rest-server: it may add backup objects and manage native locks, but may not overwrite or delete backup contents.
- `reader` may GET/HEAD repository contents and POST/DELETE only `/REPOSITORY/locks/<64 lowercase hex characters>`. It cannot write/delete data, snapshots, indexes, keys or config. Recovery therefore participates in native Restic locks rather than bypassing them.
- `admin` reaches the full backend. Keep it out of application writer/recovery Secrets. It is the separate authority for destructive maintenance.

Native locks coordinate cooperative Restic clients. A holder of reader or writer credentials can delete lock objects; locks are not protection against a malicious credential holder. Neither the chart nor maintenance disables consumers or automatically unlocks a repository.

### Install inputs

Prepare an existing PVC with `/REPOSITORY/config` and native `data`, `index`, `keys`, `locks`, `snapshots` directories. The startup init container mounts the claim read-only and fails visibly if any declared repository is missing. It never runs `restic init`. For a new repository, explicitly mount the claim in a temporary Restic 0.19.1 Pod and run `RESTIC_PASSWORD_FILE=/credentials/password restic -r /data/REPOSITORY init` before deploying the endpoint. Mount the independently retained encryption-password Secret at `/credentials`; delete that temporary Pod before attaching the claim to the endpoint. For replacement, attach the intact claim; do not initialize it again.

Create the TLS Secret from an operator-provided certificate/key whose SAN covers the chosen endpoint DNS name. Create one htpasswd Secret per repository. For example, from a protected local directory containing the three transport password files and independently retained Restic `password` and CA `ca.crt`:

```sh
umask 077
for role in writer reader admin; do
  printf '%s:%s\n' "$role" "$(openssl passwd -apr1 -stdin < "$role.restPassword")"
done > htpasswd
kubectl -n backup create secret generic keycloak-repository-auth --from-file=htpasswd
kubectl -n backup create secret tls repository-tls --cert=tls.crt --key=tls.key
# The admin transport credential and encryption key are separate protected inputs.
printf '%s' admin > username
kubectl -n backup create secret generic keycloak-repository-admin \
  --from-file=username --from-file=restPassword=admin.restPassword \
  --from-file=password --from-file=ca.crt
```

Keep these files outside Git. Consumer writer/reader Secrets need their matching `username`, `restPassword`, `password`, and `ca.crt`; no credential belongs in a URL or chart value. The CA must validate the endpoint certificate, not an unrelated provider certificate.

Example customer values (`endpoint-values.yaml`, no passwords):

```yaml
existingClaim: repository
tlsSecret: repository-tls
repositories:
  - name: keycloak
    authSecret: keycloak-repository-auth
```

```sh
helm upgrade --install backup ./chart -n backup -f endpoint-values.yaml
kubectl -n backup rollout status deployment/backup-restic --timeout=5m
kubectl -n backup logs deployment/backup-restic -c require-initialized-repositories
kubectl -n backup get service backup-restic
```

Provide DNS/routing for the TLS hostname to this Service; the chart does not provision DNS, ingress, load balancers or certificates. Its NetworkPolicy permits ingress only to TLS port 8443 when enforced by the cluster CNI. The rest-server listeners remain loopback-only even without policy enforcement. Secret rotation requires a Deployment restart so nginx reloads authentication/TLS files.

### Scheduled replication

Configure each destination in the primary endpoint's customer Helm values. Each entry creates an independent CronJob; consuming applications continue publishing only to the primary endpoint.

```yaml
replication:
  - name: secondary
    repository: keycloak
    sourceCredentialsSecret: keycloak-replication-source
    destination:
      host: secondary.example.org
      repository: keycloak
      credentialsSecret: keycloak-replication-destination
    schedule: "*/15 * * * *"
    timeZone: Etc/UTC
    suspend: false
    activeDeadlineSeconds: 3600
```

The source must name a declared local repository. Destination hosts are credential-free HTTPS DNS names, with port 443 and a declared repository path. Entry names must be unique and at most 20 characters. Deploy and initialize the secondary separately, with its own PVC, encryption password, authentication credentials and TLS certificate. For a new secondary use `restic init --from-repo ... --from-password-file ... --copy-chunker-params` while the primary is accessible; never reinitialize an existing secondary.

Create these Secrets in the primary endpoint's namespace from independently protected files, not plaintext Helm values:

```sh
kubectl -n backup create secret generic keycloak-replication-source \
  --from-file=password=/protected/primary/password
kubectl -n backup create secret generic keycloak-replication-destination \
  --from-file=username=/protected/secondary/username \
  --from-file=restPassword=/protected/secondary/writer.restPassword \
  --from-file=password=/protected/secondary/password \
  --from-file=ca.crt=/protected/secondary/ca.crt
```

The destination `username` file must contain `writer`, not `admin`. Its transport password is specific to that secondary repository. Retain the secondary reader credentials, encryption password and CA independently of the primary provider; restore does not require the primary password or replication Secrets. Source and destination encryption passwords may differ.

The worker mounts only the selected primary repository subdirectory at `/source` and uses `restic copy` against the authenticated secondary HTTPS endpoint. The source mount is writable for native lock creation/removal; the worker is a trusted backend component, not a read-only credential boundary. Required Pod affinity places it on the endpoint's node to share an existing ReadWriteOnce claim. Restic 0.19.1 shares one REST transport credential pair across repositories, so local source access avoids embedding either credential in a URL.

Each run copies all snapshots currently available at the source. Native Restic origin/metadata matching skips existing copies; the next scheduled run catches up after an outage. Copies retain their original capture times, not the time replication ran. `concurrencyPolicy: Forbid` prevents overlap within one CronJob, while native source read and destination append locks exclude destructive maintenance across clients. Do not configure multiple jobs to copy the same source into the same destination: nonexclusive copy locks are not cross-job deduplication serialization. Use distinct destination repositories; never point replication back at the source.

Schedules default to UTC. A missed start is eligible for 60 seconds; later missed ticks need not be replayed because the next run scans available history. The default one-hour active deadline bounds a stuck run and is configurable for repository size and bandwidth. Each Job has no Kubernetes retry, never unlocks or initializes repositories, and retains its native exit status. Inspect a failure before intervention; after a killed process, prove that its owner has ended before removing stale locks. Changing Secrets affects newly created Pods.

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
helm template backup ./chart -n backup -f endpoint-values.yaml \
  --set maintenance.enabled=true --set maintenance.name=check-20261102 \
  --set maintenance.repository=keycloak --set maintenance.action=check \
  --set maintenance.host=backup-restic.backup.svc \
  --set maintenance.credentialsSecret=keycloak-repository-admin \
  --show-only templates/maintenance.yaml | kubectl -n backup apply -f -
kubectl -n backup wait --for=condition=complete job/backup-restic-check-20261102 --timeout=30m
kubectl -n backup logs job/backup-restic-check-20261102
```

The example host must be covered by the certificate and reachable from the Job. For deletion, replace `action=check` with `action=forget-prune`, add `--set-string maintenance.snapshot="$FULL_SNAPSHOT_ID"` and choose a fresh name. Retain the Job/logs as the operation result; inspect failed Jobs rather than retrying blindly. Stale locks require an operator to establish that the owning operation has ended before using native Restic unlock separately.

## Qualification and test output

Compact qualification records identify the tested source, environment, scenarios, results and material limits:

- [Scheduled replication and direct secondary restore](evidence/2026-11-02-replication.json).
- [Kubernetes endpoint authorization, maintenance and replacement](evidence/2026-11-02-kubernetes.json).
- [Native-process endpoint authorization](evidence/2026-11-02-endpoint.json).
- [Native copy, interruption and independent retention](evidence/2026-11-02-restic-copy.json).

The scheduled qualification uses separate repository PVCs in one cluster, not an actual cross-provider outage. Native copy retry preserves selectable recovery points and avoids duplicate snapshots; it does not bound retransmitted data. Application compatibility remains the consumer's responsibility. The [Keycloak recovery qualification](../bartl-keycloak/evidence/2026-11-02-secondary-recovery.json) covers the compatible native worker, not a published image or its complete controller lifecycle.

Run the executable scenarios only against an explicitly authorized disposable Hetzner cluster with a default StorageClass and registry access:

```sh
BARTL_RESTIC_LAB=hetzner KUBECONFIG=/private/lab-kubeconfig node tests/kubernetes.mjs
BARTL_RESTIC_LAB=hetzner KUBECONFIG=/private/lab-kubeconfig node tests/replication.mjs
```

Each runner creates its own namespace and deletes it on success. Failures retain diagnostics and print the namespace cleanup command. Neither runner provisions infrastructure or establishes provider cleanup or cost; the operator must delete the lab, verify removal and record the budget outcome. Use Hetzner for these tests; Colima or local Docker requires explicit permission.

Run output stays outside the checkout in a private temporary directory by default. Set `BARTL_RESTIC_EVIDENCE_DIR` to an external artifact directory to select another location; paths inside the checkout, including symlink aliases, are rejected. `raw.json` holds redacted command output and diagnostic details; `qualification.json` contains the selected run summary and source provenance. Values and rendered manifests are also run artifacts, not product documentation.

Source provenance captures run-start Git HEAD, dirty state and SHA-256 of the chart and test files. A run with uncommitted changes qualifies those recorded bytes, not HEAD alone. Check output isolation, compact-record selection and provenance locally without a cluster using `node --test tests/artifacts.test.mjs`.

Review the compact qualification, complete its provider cleanup/budget outcome and copy only that record into `evidence/` when updating qualification. Do not commit raw transcripts, Kubernetes object dumps or nested regression records. Retain raw output durably only when it supports a specific unresolved issue or an independently referenced approval; record that reference and retain the exact supporting version. Existing qualification provenance identifies original Git versions without rewriting history.

## Sources

- [Restic: copying snapshots between repositories](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#copying-snapshots-between-repositories).
- [rest-server 0.14.0](https://github.com/restic/rest-server/blob/v0.14.0/README.md).
- [Restic 0.19.1 copy implementation: locks, origin identity and publication](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/cmd_copy.go).
