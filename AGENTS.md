# Repository instructions

Before changing package configuration, lifecycle behavior, installation procedures or qualification, read this repository's README and both governing documents:

- [Bartl application contract](https://github.com/bartlapp/bartl-app/blob/main/docs/application-contract.md), including Standalone operation and Supported configuration and catalogue evidence.
- [How to bartlize](https://github.com/bartlapp/bartl-app/blob/main/docs/how-to-bartlize.md), including the applicable package interface and qualification procedure.

Read the documents before implementation; listing them as future reading is insufficient. They govern implementation and acceptance. For coordinated local work, use the bartl-app checkout carrying the approved contract changes; in bartl-app itself, read docs/application-contract.md and docs/how-to-bartlize.md. Otherwise use the canonical public documents linked above. Identify the source revision used. Resolve conflicting governing versions before implementation rather than silently choosing one.

Preserve the contract's standalone operating path. Company-specific installation tooling may compose packages but must not become necessary to operate them. The contract, not this instruction file, owns the detailed requirements.

Before declaring affected package behavior or operating procedures complete, provide the standalone qualification evidence required by the contract, tied to the exact delivered artifacts, in the existing package qualification or release record. Existing evidence may be reused only where it still covers the behavior and applicable artifacts. Passing installation-generator tests is not a substitute. If required verification cannot be performed, report implementation progress and the outstanding acceptance requirement; do not declare the behavior complete. Documentation-only changes require document verification, not an unrelated deployment exercise.

## Qualification and test output

The README owns operator procedures. Maintainers use `go test ./...`, `node tests/chart.mjs` and `node --test tests/artifacts.test.mjs` for offline checks. Put native Restic 0.19.1 on PATH for `TestIdleLifecycleAddsFirstNativeRepository`; without it that case skips.

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

For exact 0.3.0 uninstall/reinstall and 0.2.1 migration qualification, retain the verified 0.3.0 archive and use:

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

## Release maintenance

Publish immutable public OCI packages under `ghcr.io/bartlapp`, independently of private source access. Never overwrite released versions or silently change visibility/team access.

1. Inspect live repository policy/access and package authority before authorized remote writes. Publication needs `write:packages`; new public package visibility requires explicit approval and an administrator.
2. Commit release changes separately. Build on an authorized Hetzner host with `Dockerfile`, `--platform linux/amd64`, `--provenance=false`, `--build-arg VERSION=VERSION` and `--build-arg REVISION=FULL_SOURCE_SHA`. Retain source and OCI archives outside Git.
3. Set chart version and pin the retained image manifest digest. Stage `chart/` with root LICENSE/NOTICE, then package once. Retain the chart archive and checksum.
4. Publish those retained bytes with digest preservation and isolated temporary credentials. Do not rebuild/repackage between qualification and publication.
5. With empty registry credentials, acquire chart/image, verify identities and smoke-install on an authorized disposable Hetzner cluster. Check current-generation admission, authenticated backup/restore, stop/start and actual runtime image IDs.
6. Record artifacts, concise evidence, limits and cleanup/budget outcome in the release/integration record. Use the permitted integration workflow without squashing, retain raw output externally and remove disposable infrastructure.
