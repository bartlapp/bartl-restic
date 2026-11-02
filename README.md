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

For recovery of an individual endpoint, attach an intact repository PVC to a suitable Kubernetes cluster, apply the declared package configuration and protected credentials, verify repository integrity and access protection, then serve. If that volume is lost, reconstruct the endpoint's state separately while the surviving endpoint remains available for application recovery.

## Replication mechanism

`restic copy` is selected as the replication primitive on the basis of the [2 November local proof](evidence/2026-11-02-restic-copy.json) with Restic 0.19.1. It copies snapshots into an independently initialized repository, skips previously copied snapshots and does not mirror source deletions. The worker needs both repositories' encryption keys because copying decrypts and re-encrypts data. Initialize the secondary with `init --from-repo ... --copy-chunker-params` and a separate password.

Recovery selects and binds the destination's full snapshot ID. In the proof, the copied snapshot's `original` field held the source snapshot ID and its `tree` matched the source. Restic preserves an existing `original` value on further copies, so it is an origin identifier, not necessarily the immediately preceding repository's snapshot ID. Use native snapshot metadata to establish correspondence; do not assume identical snapshot IDs or treat producer-supplied metadata as proof of application completeness.

The copy worker uses Restic's source read lock and destination append lock. Keep destructive maintenance excluded from replication and recovery through native Restic locks. Recovery access is read-only for backup contents but permits native lock creation/removal. After a crash, establish that the owning operation has ended before removing a stale lock; never blindly unlock on retry. Independent secondary retention must not translate source absence into deletion.

### Executed proof and remaining integration

Two local filesystem repositories used separate passwords and matching chunker parameters. With the primary repository, its password file and the original capture moved out of reach, a cache-disabled restore from the secondary reproduced the 2 MiB synthetic payload's SHA-256. Deleting and pruning the primary snapshot, then running copy again, left the secondary point selectable and byte-correct.

A subsequent copy of a 256 MiB synthetic payload was killed with `SIGKILL` after the first new destination pack file appeared. Only the previous snapshot remained selectable, and it still restored correctly. Retry published the new point; it restored byte-correctly with the primary unavailable. Repeating copy left the same destination snapshot IDs. This verifies recovery and idempotent retry, not a bound on retransmitted data.

The killed process left stale locks. Copy retry and restore succeeded without manual unlock, but `check --read-data` exited with lock error 11. After confirming the process had exited and its PID no longer existed, removing stale locks allowed the full secondary data check to pass. The source stale lock was also removed.

The proof selects the native replication mechanism, not an automated replication deployment. The endpoint package below adds HTTPS access protection and native-lock-compatible recovery access. Retention policy, replication scheduling and direct application recovery from the secondary with the primary provider unavailable remain integration work, including independent recovery inputs and protection of retained history. These checks do not make the backend application-aware.

## Endpoint package

`chart/` is the first usable endpoint increment: one `Recreate` Deployment, an existing PVC, nginx HTTPS/authentication, an append-only rest-server and a full-access rest-server. Both rest-server processes listen only on Pod loopback. The Service exposes only HTTPS. The chart does not create or delete the PVC, initialize repositories, implement a controller, schedule retention or automate replication. rest-server is pinned to the lab's 0.14.0 image digest, nginx to 1.28.0 and maintenance Restic to 0.19.1.

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

### Startup, authorization and replacement proof

Use a disposable initialized repository for destructive probes. Run clients with Restic 0.19.1, trusted CA, `RESTIC_PASSWORD_FILE`, `RESTIC_REST_USERNAME` and `RESTIC_REST_PASSWORD`; `RESTIC_REPOSITORY` is the same credential-free URL for all three roles. Use the selected endpoint's exact rendered ConfigMap and Deployment, not a different test proxy.

```sh
helm template backup ./chart -n backup -f endpoint-values.yaml > endpoint-rendered.yaml
helm lint ./chart -f endpoint-values.yaml
# List existing locks and select a full snapshot ID:
RESTIC_REST_USERNAME=reader restic --cacert "$CA_FILE" list locks
RESTIC_REST_USERNAME=reader restic --cacert "$CA_FILE" snapshots --json
# Restore creates/removes its native lock; use the selected full ID, not "latest".
RESTIC_REST_USERNAME=reader restic --cacert "$CA_FILE" restore "$FULL_SNAPSHOT_ID" --target "$RESTORE_DIR"
```

Set the matching transport password whenever switching username. For explicit HTTP permission probes, use `curl --cacert "$CA_FILE" --netrc-file "$ROLE_NETRC"` so passwords stay out of command lines and URLs. A reader POST/DELETE to `data/<64hex>`, `snapshots/<64hex>`, `config`, repository root, or a malformed lock name must return 403. A reader POST then DELETE to `locks/<64hex>` must succeed; use the SHA-256 of the synthetic POST body as its name, because rest-server verifies uploaded object hashes. GET/HEAD config must succeed. Writer DELETE config/data/snapshots must return 403, while normal backup and native lock removal succeed. The same credentials against a second repository with independent passwords must return 401. Undeclared repositories return 404; an extra authenticated username returns 403.

While a real long-running reader restore or writer backup holds its native lock, run the maintenance Job and require a visible lock conflict. Conversely, while a long-running admin `check --read-data` holds its exclusive lock, reader restore and writer backup must fail on the conflicting lock. No participant may use `--no-lock`. Use enough disposable data to observe the actual lock interval rather than assuming a small command is still running.

Record repository identity and full snapshot IDs with `restic cat config` and `restic snapshots --json`; restart the Deployment, wait for rollout, then compare identity/history and restore the same full snapshot. Confirm the PVC was not replaced. For a missing-state test, declare a second uninitialized repository and require startup to fail in `require-initialized-repositories`, with the existing repository untouched. Restore the original values to resume service.

### Verification status

The [2 November endpoint evidence](evidence/2026-11-02-endpoint.json) records Helm lint/rendering and live native nginx 1.28.0, rest-server 0.14.0 and Restic 0.19.1 on Darwin. The rendered authorization policy passed content-write denial, lock creation/removal, cross-repository credential isolation, native lock conflicts in both directions, byte-verified restore and process replacement over unchanged repository directories. The rendered startup check refused missing state without initialization; the rendered maintenance commands checked and deleted an explicitly selected disposable snapshot.

Kubernetes deployment, PVC attachment and Deployment replacement remain unverified. Both Colima and direct Lima startup were blocked by a denied user-network socket bind; the native proof substituted only local paths, ports and certificate inputs, not the authorization policy. Complete the Kubernetes procedure above on an available disposable cluster before relying on this package there.

The existing Keycloak consumer source now uses native locks, but its manifest still binds the original repository ID. It therefore rejects recovery from `restic copy` into an independently initialized repository. That compatibility constraint is recorded in the [Keycloak design](../bartl-keycloak/DESIGN.md#recovery-and-exclusion); it must be resolved before claiming direct secondary-provider recovery for that consumer.

## Sources

- [Restic: copying snapshots between repositories](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#copying-snapshots-between-repositories).
- [rest-server 0.14.0](https://github.com/restic/rest-server/blob/v0.14.0/README.md).
- [Restic 0.19.1 copy implementation: locks, origin identity and publication](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/cmd_copy.go).
