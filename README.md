# Bartlized Restic backend

This repository records the design of a Restic backup service under the [Bartl application contract](../bartl-app/README.md#portable-recovery-artifact-and-storage-boundary). Implementation has not started. [ADR-11](../../floriankesslergmbh/floriankesslergmbh/adr/ADR-11-Uebergebbare-Backup-Architektur/README.md) selects Restic and defines the backup and handover requirements for the reference installation.

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

The copy worker uses Restic's source read lock and destination append lock. Keep destructive maintenance excluded from replication and recovery. Strictly read-only recovery cannot write these locks and still requires enforced exclusion at the service boundary. After a crash, establish that the owning operation has ended before removing a stale lock; never blindly unlock on retry. Independent secondary retention must not translate source absence into deletion.

### Executed proof and remaining integration

Two local filesystem repositories used separate passwords and matching chunker parameters. With the primary repository, its password file and the original capture moved out of reach, a cache-disabled restore from the secondary reproduced the 2 MiB synthetic payload's SHA-256. Deleting and pruning the primary snapshot, then running copy again, left the secondary point selectable and byte-correct.

A subsequent copy of a 256 MiB synthetic payload was killed with `SIGKILL` after the first new destination pack file appeared. Only the previous snapshot remained selectable, and it still restored correctly. Retry published the new point; it restored byte-correctly with the primary unavailable. Repeating copy left the same destination snapshot IDs. This verifies recovery and idempotent retry, not a bound on retransmitted data.

The killed process left stale locks. Copy retry and restore succeeded without manual unlock, but `check --read-data` exited with lock error 11. After confirming the process had exited and its PID no longer existed, removing stale locks allowed the full secondary data check to pass. The source stale lock was also removed.

The proof selects the native replication mechanism, not a production deployment. HTTPS access protection, enforced exclusion for read-only clients, safe retention policy and replication scheduling remain package integration work. Qualification must demonstrate direct application recovery from the secondary with the primary provider unavailable, including independent recovery inputs and protection of retained history. These checks do not make the backend application-aware.

## Sources

- [Restic: copying snapshots between repositories](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#copying-snapshots-between-repositories).
- [rest-server 0.14.0](https://github.com/restic/rest-server/blob/v0.14.0/README.md).
- [Restic 0.19.1 copy implementation: locks, origin identity and publication](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/cmd_copy.go).
