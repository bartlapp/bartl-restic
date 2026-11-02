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

`restic copy` is the leading candidate, not a selected or qualified implementation. It copies snapshots into an independently initialized repository, skips previously copied snapshots and does not mirror source deletions. The worker needs both repositories' encryption keys because copying decrypts and re-encrypts data. Matching chunker parameters at initialization support deduplication. Repository and snapshot IDs can differ between source and destination.

Storage-level replication remains an alternative only if it exposes a coherent, directly usable secondary repository with independently retained history. A cold copy alone does not satisfy the disaster-recovery objective. `rest-server` itself does not implement replication.

Before selecting the mechanism, resolve recovery-point identification across repositories and safe retention and maintenance with replication and read-only recovery. Qualification must demonstrate direct application recovery from the secondary with the primary provider unavailable, including independent recovery inputs and protection of retained history. These checks do not make the backend application-aware.

## Sources

- [Restic: copying snapshots between repositories](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#copying-snapshots-between-repositories).
- [rest-server 0.14.0](https://github.com/restic/rest-server/blob/v0.14.0/README.md).
