#!/usr/bin/env node
// Offline package behavior; no infrastructure, registry or credentials required.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const chart = process.env.RESTIC_CHART || fileURLToPath(new URL('../chart', import.meta.url));
const helm = process.env.HELM || 'helm';
const yq = process.env.YQ || 'yq';
function render(values, {mode = 'deployment', release = 'backup', namespace = 'backup'} = {}) {
  return spawnSync(helm, ['template', release, chart, '-n', namespace, '-f', '-', '--set-string', `renderMode=${mode}`], {
    input: JSON.stringify(values), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
}
function documents(result) {
  assert.equal(result.status, 0, result.stderr);
  const parsed = spawnSync(yq, ['-o=json', '-I=0', '.'], {input: result.stdout, encoding: 'utf8'});
  assert.equal(parsed.status, 0, parsed.stderr);
  return parsed.stdout.trim().split('\n').filter(Boolean).map(JSON.parse).filter(Boolean);
}
const base = () => ({installation: 'acme', dns: {root: 'acme.example'}, services: {restic: {}}});
const selected = v => v.services[v.instance || v.deployments?.[v.deployment]?.instance || 'restic'];
function deployment(v) {
  const docs = documents(render(v));
  const app = docs.find(d => d.kind === 'ResticApplication');
  assert.ok(app);
  return {spec: app.spec, docs};
}
function declaration(v) {
  const docs = documents(render(v, {mode: 'connections', release: v.deployment ? v.deployments[v.deployment].release : 'offline'}));
  assert.equal(docs.length, 1);
  assert.equal(docs[0].kind, undefined);
  return docs[0];
}
function rejects(v, options) { assert.notEqual(render(v, options).status, 0, 'invalid inputs rendered successfully'); }
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }
const copy = (overrides = {}) => ({name: 'secondary', repository: 'records', sourceCredentialsSecret: 'records-repository-key', destination: {host: 'secondary.example', repository: 'records', credentialsSecret: 'secondary-writer'}, schedule: '*/15 * * * *', ...overrides});

check('sparse shared configuration runs idle without repository credential dependencies', () => {
  const v = base(); v.services.paperless = {unrelated: true}; v.services.keycloak = 'ignored';
  v.infrastructure = {unrelated: ['ignored']}; v.resolved = {backup: {bindings: {paperless: 'ignored'}}};
  const {spec, docs} = deployment(v);
  assert.deepEqual(spec.repositories, []); assert.deepEqual(spec.replication, []);
  assert.equal(docs.some(d => ['Secret', 'PersistentVolumeClaim'].includes(d.kind)), false);
  const role = docs.find(d => d.kind === 'Role' && d.metadata.name.endsWith('-controller'));
  assert.deepEqual(role.rules.find(r => r.resources.includes('secrets')).resourceNames, ['repository-tls']);
  const d = declaration(v);
  assert.deepEqual(d.backup.providers.restic.repositories, {});
  assert.deepEqual(d.credentials.bindings.restic.repositories, {});
  assert.deepEqual(d.services.restic.endpoints.https, {url: 'https://restic.acme.example', hostname: 'restic.acme.example', tlsManaged: true, ingressEnabled: true});
});
check('custom selected instance preserves zero, false and inherited map siblings', () => {
  const v = base(); v.instance = 'archive'; v.services = {restic: {bad: true}, archive: {replicas: 0, existingClaim: 'archive-data', tlsSecret: 'archive-tls', ingress: {enabled: false}, tls: {managed: false}}};
  const {spec, docs} = deployment(v);
  assert.equal(spec.replicas, 0); assert.equal(spec.existingClaim, 'archive-data'); assert.equal(spec.tlsSecret, 'archive-tls');
  assert.equal(docs.some(d => ['Certificate', 'Issuer', 'IngressRouteTCP'].includes(d.kind)), false);
  const d = declaration(v);
  assert.equal(d.services.archive.endpoints.https.hostname, 'restic.acme.example');
  assert.equal(d.services.archive.endpoints.https.ingressEnabled, false);
  assert.deepEqual(d.credentials.requirements.archive.tls.sources, ['external', 'recovered']);
  assert.deepEqual(d.storage.claims.archive.repository, {claimName: 'archive-data', accessModes: ['ReadWriteOnce'], provisionedBy: 'operator'});
});
check('hostname override and removal share one derivation across declarations and deployment', () => {
  const v = base(); selected(v).hostname = 'archive.example'; v.dns.root = 'changed.example';
  for (const host of ['archive.example', 'restic.changed.example']) {
    const {docs} = deployment(v);
    assert.deepEqual(docs.find(d => d.kind === 'Certificate').spec.dnsNames, [host]);
    assert.equal(docs.find(d => d.kind === 'IngressRouteTCP').spec.routes[0].match, `HostSNI(\`${host}\`)`);
    assert.equal(declaration(v).services.restic.endpoints.https.hostname, host);
    delete selected(v).hostname;
  }
  delete v.dns; rejects(v); rejects(v, {mode: 'connections'});
  selected(v).hostname = 'explicit.example'; deployment(v); declaration(v);
});
check('managed certificates and TLS passthrough preserve native endpoint TLS', () => {
  const v = base(); selected(v).tls = {acmeServer: 'https://acme-staging-v02.api.letsencrypt.org/directory'};
  selected(v).ingress = {entryPoint: 'backupsecure'};
  let {docs} = deployment(v);
  const route = docs.find(d => d.kind === 'IngressRouteTCP');
  assert.deepEqual(route.spec.entryPoints, ['backupsecure']); assert.deepEqual(route.spec.tls, {passthrough: true});
  assert.equal(route.spec.routes[0].services[0].port, 443);
  const issuer = docs.find(d => d.kind === 'Issuer');
  assert.equal(issuer.spec.acme.server, selected(v).tls.acmeServer);
  assert.deepEqual(declaration(v).credentials.requirements.restic.tls.sources, ['cert-manager']);
  selected(v).ingress.enabled = false;
  docs = deployment(v).docs;
  assert.equal(docs.some(d => d.kind === 'IngressRouteTCP'), false); assert.ok(docs.find(d => d.kind === 'Certificate'));
  selected(v).tls.managed = false; selected(v).ingress.enabled = true;
  docs = deployment(v).docs;
  assert.equal(docs.some(d => ['Certificate', 'Issuer'].includes(d.kind)), false); assert.ok(docs.find(d => d.kind === 'IngressRouteTCP'));
});
check('two explicit repositories derive independent runtime bindings and public URLs', () => {
  const v = base(); selected(v).repositories = [{name: 'keycloak'}, {name: 'paperless', authSecret: 'records-auth', passwordSecret: 'records-key'}];
  const {spec} = deployment(v); const d = declaration(v);
  assert.deepEqual(spec.repositories, [{name: 'keycloak', authSecret: 'keycloak-repository-auth', passwordSecret: 'keycloak-repository-key'}, {name: 'paperless', authSecret: 'records-auth', passwordSecret: 'records-key'}]);
  assert.deepEqual(d.backup.providers.restic.repositories.keycloak, {repository: 'rest:https://restic.acme.example/keycloak/', authSecret: 'keycloak-repository-auth', passwordSecret: 'keycloak-repository-key', adminSecret: 'keycloak-repository-admin'});
  for (const repo of spec.repositories) {
    const bindings = d.credentials.bindings.restic.repositories[repo.name];
    assert.equal(bindings.authentication.secretName, repo.authSecret); assert.equal(bindings.encryption.secretName, repo.passwordSecret);
    assert.equal(bindings.maintenance.secretName, `${repo.name}-repository-admin`);
    const requirements = d.credentials.requirements.restic.repositories[repo.name];
    assert.deepEqual(requirements.authentication.keys, ['htpasswd']); assert.deepEqual(requirements.encryption.keys, ['password']);
    assert.deepEqual(requirements.encryption.sources, ['generated', 'external', 'recovered']);
    assert.deepEqual(requirements.maintenance.keys, ['username', 'restPassword', 'password', 'ca.crt']);
  }
  assert.equal(d.backup.providers.restic.repositories.paperless.passwordSecret, 'records-key');
  selected(v).repositories = [{name: 'records'}];
  assert.deepEqual(Object.keys(declaration(v).backup.providers.restic.repositories), ['records']);
  assert.equal(deployment(v).spec.repositories.length, 1);
});
check('declarations ignore runtime resolved data and contain only nonsecret references', () => {
  const v = base(); selected(v).repositories = [{name: 'records'}];
  const before = declaration(v);
  v.resolved = {backup: {bindings: {restic: {repository: 'not consumed', password: 'DO_NOT_EXPOSE'}}}};
  v.infrastructure = {password: 'DO_NOT_EXPOSE'};
  assert.deepEqual(declaration(v), before);
  assert.equal(JSON.stringify(before).includes('DO_NOT_EXPOSE'), false);
});
check('selected interface rejects unknown nested fields, invalid types and plaintext', () => {
  for (const field of [ {unknown: true}, {application: {replicas: 1}}, {replicas: 2}, {replicas: false}, {hostname: ''}, {existingClaim: ''}, {tlsSecret: ''}, {image: 'mutable:latest'}, {tls: {unknown: true}}, {ingress: {unknown: true}}, {repositories: [{name: 'records', password: 'plaintext'}]}, {repositories: [{name: 'records', authSecret: ''}]}, {repositories: [{name: 'records', recovery: {host: 'secondary.example', repository: 'records', credentialsSecret: 'reader', password: 'plaintext'}}]}, {maintenance: {unknown: true}} ]) {
    const v = base(); Object.assign(selected(v), field); rejects(v); rejects(v, {mode: 'connections'});
  }
  const v = base(); v.services.restic = 'invalid'; rejects(v);
});
check('legacy flat inputs fail instead of silently changing package intent', () => {
  for (const field of ['image', 'application', 'existingClaim', 'tlsSecret', 'repositories', 'replication', 'maintenance']) {
    const v = base(); v[field] = field === 'repositories' || field === 'replication' ? [] : 'legacy'; rejects(v);
  }
});
check('release guard accepts the selected chart and rejects incompatible releases in both modes', () => {
  const v = base(); selected(v).release = '0.3.1'; deployment(v); declaration(v);
  selected(v).release = '0.2.1'; rejects(v); rejects(v, {mode: 'connections'});
});
check('deployment selection applies only its operation intent across runtime and declarations', () => {
  const v = base();
  v.services = {
    restic: {bad: 'not selected'},
    archive: {replicas: 1, ingress: {enabled: true, entryPoint: 'private'}, tls: {managed: false}, repositories: [{name: 'records'}]},
  };
  v.deployment = 'archive-replacement';
  v.deployments = {
    'archive-source': {instance: 'archive', namespace: 'source', release: 'original', package: 'old'},
    'archive-replacement': {instance: 'archive', namespace: 'backup', release: 'backup', package: 'restic'},
  };
  v.packages = {old: {version: '0.3.0'}, restic: {version: '0.3.1', chart: 'oci://ghcr.io/bartlapp/bartl-restic'}};
  v.operations = {deployments: {
    'archive-source': {replicas: 1, ingressEnabled: true},
    'archive-replacement': {replicas: 0, ingressEnabled: false},
  }};
  const {spec, docs} = deployment(v);
  assert.equal(spec.replicas, 0);
  assert.equal(docs.some(d => d.kind === 'IngressRouteTCP'), false);
  assert.equal(docs.some(d => d.kind === 'Certificate'), false);
  const d = declaration(v);
  assert.equal(d.services.archive.endpoints.https.ingressEnabled, false);
  assert.equal(d.services.restic, undefined);
  assert.ok(d.backup.providers.archive.repositories.records);
  assert.equal(d.storage.claims.archive.repository.claimName, 'repository');
  delete v.operations.deployments['archive-replacement'];
  assert.equal(deployment(v).spec.replicas, 1);
  assert.equal(declaration(v).services.archive.endpoints.https.ingressEnabled, true);
  v.operations.deployments['archive-replacement'] = {replicas: 0, ingressEnabled: false};
  v.services.archive.replicas = 0;
  v.operations.deployments['archive-replacement'].replicas = 1;
  assert.equal(deployment(v).spec.replicas, 1);
});
check('deployment selection rejects wrong targets, package versions and conflicting instances in both render modes', () => {
  const v = base();
  v.deployment = 'target';
  v.deployments = {target: {instance: 'archive', namespace: 'backup', release: 'backup', package: 'restic'}};
  v.services.archive = {};
  v.packages = {restic: {version: '0.3.1'}};
  for (const options of [{}, {mode: 'connections'}]) {
    assert.equal(render(v, options).status, 0);
    rejects(v, {...options, namespace: 'other'});
    rejects(v, {...options, release: 'other'});
    v.packages.restic.version = '0.3.0'; rejects(v, options); v.packages.restic.version = '0.3.1';
    v.instance = 'restic'; rejects(v, options); delete v.instance;
    v.deployments.target.package = 'missing'; rejects(v, options); v.deployments.target.package = 'restic';
    delete v.services.archive; rejects(v, options); v.services.archive = {};
    v.operations = {deployments: {target: {replicas: 2}}}; rejects(v, options);
    v.operations = {deployments: {target: {ingressEnabled: 'false'}}}; rejects(v, options);
    v.operations = {deployments: {other: {replicas: 0}}}; assert.equal(render(v, options).status, 0);
    delete v.operations;
  }
});
check('replication preserves optional false and validates source, duplicate and self-copy boundaries', () => {
  const v = base(); selected(v).repositories = [{name: 'records'}]; selected(v).replication = [copy({suspend: false, activeDeadlineSeconds: 1, timeZone: 'Etc/UTC'})];
  assert.equal(deployment(v).spec.replication[0].suspend, false);
  const creds = declaration(v).credentials;
  assert.equal(creds.bindings.restic.replication.secondary.destination.secretName, 'secondary-writer');
  assert.deepEqual(creds.requirements.restic.replication.secondary.destination.keys, ['username', 'restPassword', 'password', 'ca.crt']);
  for (const host of ['restic.acme.example', 'RESTIC.ACME.EXAMPLE', 'backup-restic', 'backup-restic.backup', 'backup-restic.backup.svc', 'backup-restic.backup.svc.cluster.local']) {
    selected(v).replication = [copy({destination: {host, repository: 'records', credentialsSecret: 'writer'}})]; rejects(v); rejects(v, {mode: 'connections'});
  }
  selected(v).replication = [copy(), copy({name: 'other'})]; rejects(v);
  selected(v).replication = [copy(), copy({destination: {host: 'third.example', repository: 'records', credentialsSecret: 'third-writer'}})]; rejects(v);
  selected(v).replication = [copy({repository: 'undeclared'})]; rejects(v);
  selected(v).replication = [copy({activeDeadlineSeconds: 0})]; rejects(v);
  selected(v).replication = [copy({destination: {host: 'restic.acme.example', repository: 'different', credentialsSecret: 'writer'}})]; deployment(v);
});
check('recovery declarations expose external retained prerequisites without credential content', () => {
  const v = base(); const recovery = {host: 'secondary.example', repository: 'records', credentialsSecret: 'secondary-reader'};
  selected(v).repositories = [{name: 'records', recovery}];
  const d = declaration(v);
  assert.equal(d.credentials.bindings.restic.repositories.records.recovery.secretName, 'secondary-reader');
  assert.deepEqual(d.credentials.requirements.restic.repositories.records.recovery.sources, ['external', 'recovered']);
  assert.deepEqual(d.credentials.requirements.restic.repositories.records.recovery.keys, ['username', 'restPassword', 'password', 'ca.crt']);
});
check('duplicate repositories fail before either rendering mode publishes misleading connections', () => {
  const v = base(); selected(v).repositories = [{name: 'records'}, {name: 'records'}]; rejects(v); rejects(v, {mode: 'connections'});
});
check('maintenance remains explicit, repository scoped, admin only and snapshot constrained', () => {
  const v = base(); selected(v).repositories = [{name: 'records'}];
  assert.equal(deployment(v).docs.some(d => d.kind === 'Job'), false);
  selected(v).maintenance = {enabled: true}; rejects(v);
  selected(v).maintenance = {enabled: true, repository: 'records', host: 'restic.acme.example', credentialsSecret: 'records-repository-admin'};
  const job = deployment(v).docs.find(d => d.kind === 'Job'); assert.ok(job);
  const container = job.spec.template.spec.containers[0];
  assert.equal(container.env.find(e => e.name === 'RESTIC_REPOSITORY').value, 'rest:https://restic.acme.example/records/');
  selected(v).maintenance.action = 'forget-prune'; rejects(v);
  selected(v).maintenance.snapshot = 'a'.repeat(64);
  deployment(v);
  selected(v).maintenance.snapshot = 'short'; rejects(v);
  selected(v).maintenance.snapshot = 'a'.repeat(64); selected(v).maintenance.repository = 'undeclared'; rejects(v);
});
console.log(`${checks} chart behavior checks passed`);
