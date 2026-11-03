#!/usr/bin/env node
// BARTL_RESTIC_LAB=hetzner KUBECONFIG=/private/kubeconfig BARTL_RESTIC_IMAGE=imported-image node tests/lifecycle.mjs
// Existing disposable cluster only. No provisioning, local containers or product test hooks.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactDirectory, snapshotSource, persistArtifacts, failureReason } from './artifacts.mjs';

if (process.env.BARTL_RESTIC_LAB !== 'hetzner' || !process.env.KUBECONFIG) {
  console.error('Require BARTL_RESTIC_LAB=hetzner and KUBECONFIG; no infrastructure is created.'); process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const namespace = `restic-life-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const directory = createArtifactDirectory(root, namespace);
if (!process.env.BARTL_RESTIC_IMAGE) throw new Error('Require BARTL_RESTIC_IMAGE imported into the lab cluster.');
const image = process.env.BARTL_RESTIC_IMAGE;
const nativeImage = 'docker.io/restic/restic:0.19.1';
const privateDir = join(directory, 'private'); mkdirSync(privateDir, { mode: 0o700 });
const evidence = { schema: 1, started: new Date().toISOString(), source: snapshotSource(root), namespace,
  scope: 'Native lifecycle, source-independent replacement, interrupted recovery and durable stop in one existing disposable Hetzner cluster',
  environment: { endpointImages: [] }, namespaceCleanup: 'not-created', commands: [], assertions: [], status: 'running' };
const sensitive = [];
const redact = value => sensitive.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
const persist = () => persistArtifacts(directory, evidence, redact);
function command(binary, args, { input, allowFailure = false, record = true, timeout = 180000 } = {}) {
  const start = Date.now();
  const result = spawnSync(binary, args, { input, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  if (record) { evidence.commands.push({ command: [binary, ...args].map(redact), exit: result.status, durationMs: Date.now() - start,
    stdout: redact(result.stdout || '').slice(-24000), stderr: redact(result.stderr || '').slice(-24000), error: result.error?.message }); persist(); }
  if ((result.status !== 0 || result.error) && !allowFailure) {
    throw Object.assign(new Error(`${binary}: ${result.stderr || result.error || result.stdout}`), { publicReason: `${binary} failed (${result.error?.code || `exit ${result.status}`}); inspect private raw.json.` });
  }
  return { ...result, stdout: result.stdout || '', stderr: result.stderr || '' };
}
const k = (args, options) => command('kubectl', ['--namespace', namespace, ...args], options);
const get = (kind, name, options) => JSON.parse(k(['get', kind, ...(name ? [name] : []), '-o', 'json'], options).stdout);
const apply = object => k(['apply', '-f', '-'], { input: JSON.stringify(object), record: false });
const secret = (name, data, type = 'Opaque') => apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name }, type, stringData: data });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(name, check, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = check(); if (value) return value; await sleep(1000); }
  throw new Error(`Timed out: ${name}`);
}
function assert(name, passed, details = {}) {
  evidence.assertions.push({ name, passed: !!passed, ...details }); persist();
  if (!passed) throw new Error(`Assertion failed: ${name}`);
}
const app = name => get('resticapplication', `${name}-restic`, { record: false });
async function state(name, expected, timeout = 600000) {
  return until(`${name} current generation ${expected}`, () => {
    const object = app(name);
    return object.status?.state === expected && object.status.observedGeneration === object.metadata.generation ? object : null;
  }, timeout);
}
function patch(name, spec) { k(['patch', 'resticapplication', `${name}-restic`, '--field-manager=helm', '--type=merge', '-p', JSON.stringify({ spec })]); }
async function stop(name) {
  patch(name, { replicas: 0 }); await state(name, 'Stopped');
  const cronjobs = get('cronjobs').items.filter(object => object.metadata.ownerReferences?.some(owner => owner.uid === app(name).metadata.uid));
  const deployment = get('deployments').items.find(object => object.metadata.name === `${name}-restic`);
  assert(`${name} stop drains endpoint and suspends every copy`, (!deployment || deployment.spec.replicas === 0) && cronjobs.every(job => job.spec.suspend === true));
  const replicasets = get('replicasets').items.filter(object => deployment && object.metadata.ownerReferences?.some(owner => owner.uid === deployment.metadata.uid));
  assert(`${name} Stopped acknowledges Deployment and every owned ReplicaSet at zero`, (!deployment || deployment.status?.observedGeneration >= deployment.metadata.generation && (deployment.status?.replicas || 0) === 0) && replicasets.every(object => object.spec.replicas === 0 && (object.status?.replicas || 0) === 0));
  await noAccess(name);
}
async function nativeLocksReleased(phase) {
  await until(`${phase} releases secondary native locks`, () => restic('secondary', 'reader', 'list locks', { record: false }).stdout.trim() === '');
  assert(`${phase} releases secondary native locks without unlock`, true);
}
async function stoppedRestart(name) {
  const previous = new Set(get('jobs').items.map(job => job.metadata.uid));
  k(['rollout', 'restart', `deployment/${name}-restic-controller`]);
  k(['rollout', 'status', `deployment/${name}-restic-controller`, '--timeout=3m'], { timeout: 210000 });
  await state(name, 'Stopped'); await noAccess(name);
  await sleep(3000);
  const newCopies = get('jobs').items.filter(job => !previous.has(job.metadata.uid) && job.metadata.name.startsWith(`${name}-restic-copy-`));
  assert(`${name} controller restart preserves durable stop without new copies`, app(name).spec.replicas === 0 && newCopies.length === 0);
}
async function noAccess(name) {
  await until(`${name} no ready Service endpoints`, () => !get('endpointslices').items.filter(slice => slice.metadata.labels?.['kubernetes.io/service-name'] === `${name}-restic`)
    .some(slice => slice.endpoints?.some(endpoint => endpoint.conditions?.ready !== false)));
}
const exec = (name, script, options) => k(['exec', name, '--', '/bin/sh', '-ec', script], options);
const host = name => `${name}-restic.${namespace}.svc`;
function script(name, role, operation, repository = 'alpha') {
  return `export RESTIC_REPOSITORY='rest:https://${host(name)}/${repository}/' RESTIC_PASSWORD_FILE=/credentials/${role}/password; export RESTIC_REST_USERNAME="$(cat /credentials/${role}/username)" RESTIC_REST_PASSWORD="$(cat /credentials/${role}/restPassword)"; restic --cacert /credentials/${role}/ca.crt ${operation}`;
}
const restic = (name, role, operation, options, repository) => exec(`${name}-client`, script(name, role, operation, repository), options);
const snapshots = name => JSON.parse(restic(name, 'reader', 'snapshots --json').stdout);
function pvc(name) { apply({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: `${name}-data` }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '3Gi' } } } }); }
async function client(name, credentialOwner = name) {
  apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: `${name}-client` }, spec: { automountServiceAccountToken: false, restartPolicy: 'Never',
    containers: [{ name: 'restic', image: nativeImage, command: ['/bin/sh', '-ec', 'while :; do sleep 3600; done'],
      volumeMounts: ['reader', 'writer', 'admin'].map(role => ({ name: role, mountPath: `/credentials/${role}`, readOnly: true })) }],
    volumes: ['reader', 'writer', 'admin'].map(role => ({ name: role, secret: { secretName: `${credentialOwner}-${role}`, defaultMode: 0o400 } })) } });
  k(['wait', '--for=condition=Ready', `pod/${name}-client`, '--timeout=5m'], { timeout: 330000 });
}
const configurations = {};
function install(name, values) {
  configurations[name] = values;
  const path = join(privateDir, `${name}-values.json`); writeFileSync(path, JSON.stringify(values), { mode: 0o600 });
  command('helm', ['upgrade', '--install', name, join(root, 'chart'), '--namespace', namespace, '-f', path, '--wait=legacy', '--timeout', '5m'], { timeout: 330000 });
}
const baseValues = (name, recovery) => ({ image, existingClaim: `${name}-data`, tlsSecret: `${name}-tls`, repositories: ['alpha', 'beta'].map(repository => ({
  name: repository, authSecret: `${name}-auth`, passwordSecret: `${name}-key`, ...(recovery ? { recovery: { host: host('secondary'), repository, credentialsSecret: 'secondary-reader' } } : {}) })) });
let caText;
function credentials(name, password = randomBytes(32).toString('hex')) {
  const roles = Object.fromEntries(['reader', 'writer', 'admin'].map(role => [role, name === 'secondary' ? ` \t${randomBytes(24).toString('hex')} \t` : randomBytes(24).toString('hex')]));
  sensitive.push(password, ...Object.values(roles));
  for (const [role, value] of Object.entries(roles)) sensitive.push(Buffer.from(`${role}:${value}`).toString('base64'));
  const key = join(privateDir, `${name}.key`), csr = join(privateDir, `${name}.csr`), cert = join(privateDir, `${name}.crt`), ext = join(privateDir, `${name}.ext`);
  command('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${host(name)}`, '-keyout', key, '-out', csr]);
  writeFileSync(ext, `subjectAltName=DNS:${host(name)}\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
  command('openssl', ['x509', '-req', '-in', csr, '-CA', join(privateDir, 'ca.crt'), '-CAkey', join(privateDir, 'ca.key'), '-CAcreateserial', '-days', '2', '-extfile', ext, '-out', cert]);
  const data = { htpasswd: Object.entries(roles).map(([role, value]) => `${role}:${command('openssl', ['passwd', '-apr1', '-stdin'], { input: value + '\n', record: false }).stdout.trim()}`).join('\n') + '\n' };
  secret(`${name}-auth`, data); secret(`${name}-key`, { password });
  secret(`${name}-tls`, { 'tls.crt': readFileSync(cert, 'utf8'), 'tls.key': readFileSync(key, 'utf8') }, 'kubernetes.io/tls');
  for (const [role, restPassword] of Object.entries(roles)) secret(`${name}-${role}`, { username: role, restPassword, password, 'ca.crt': caText });
  return { password, roles };
}
async function restore(name, snapshot, expected, target, absentMarker = false) {
  restic(name, 'reader', `--no-cache restore ${snapshot} --target /${target}`, { timeout: 600000 });
  const actual = exec(`${name}-client`, `sha256sum /${target}/fixture/payload${absentMarker ? `; test ! -e /${target}/fixture/marker` : ''}`).stdout.trim().split(/\s/)[0];
  assert(`${name} byte-correct selected restore ${target}`, actual === expected, { snapshot, sha256: actual });
}
async function activeJob(name, copy = false) {
  return until(`${name} real ${copy ? 'copy' : 'recovery'} native work`, () => {
    const uid = app(name).metadata.uid;
    const candidates = get('jobs', null, { record: false }).items.filter(job => copy
      ? job.metadata.labels?.['bartl-restic/replication'] === 'alpha' && job.metadata.name.startsWith(`${name}-restic-`)
      : job.metadata.ownerReferences?.some(owner => owner.uid === uid));
    for (const job of candidates.filter(job => job.status?.active)) {
      const pods = get('pods', null, { record: false }).items.filter(pod => pod.metadata.ownerReferences?.some(owner => owner.uid === job.metadata.uid));
      for (const pod of pods.filter(pod => pod.status.phase === 'Running')) {
        const output = k(['exec', pod.metadata.name, '-c', 'worker', '--', '/bin/sh', '-ec', 'for p in /proc/[0-9]*/comm; do test "$(cat "$p" 2>/dev/null)" != restic || cat "${p%comm}cmdline"; done'], { allowFailure: true, record: false });
        if (output.status === 0 && /copy/.test(output.stdout)) return { job, pod };
      }
    }
    return null;
  }, 240000);
}
let unrestrictedNginx, secondaryIdentity;
async function rateLimit(enabled) {
  if (enabled) {
    k(['scale', 'deployment/secondary-restic-controller', '--replicas=0']);
    await until('secondary controller temporarily paused', () => !get('pods').items.some(pod => pod.metadata.name.startsWith('secondary-restic-controller-') && !['Succeeded', 'Failed'].includes(pod.status.phase)));
  }
  const config = get('configmap', 'secondary-restic');
  if (enabled) unrestrictedNginx = config.data['nginx.conf'];
  const reader = Buffer.from(`reader:${secondaryIdentity.roles.reader}`).toString('base64');
  const writer = Buffer.from(`writer:${secondaryIdentity.roles.writer}`).toString('base64');
  const restriction = `\n map_hash_bucket_size 128;\n map $http_authorization $qualification_rate { default 0; \"Basic ${reader}\" 128k; }\n map $http_authorization $qualification_copy { default \"\"; \"Basic ${writer}\" \"copy\"; }\n limit_req_zone $qualification_copy zone=qualification_copy:1m rate=1r/s;\n limit_req zone=qualification_copy burst=10000;\n limit_rate $qualification_rate;\n limit_rate_after 0;\n`;
  const changed = enabled ? unrestrictedNginx.replace(/http\s*\{/, `http {${restriction}`) : unrestrictedNginx;
  assert(`secondary real-work restriction ${enabled ? 'installed' : 'removed'}`, typeof changed === 'string' && (!enabled || changed !== unrestrictedNginx));
  k(['patch', 'configmap', 'secondary-restic', '--type=merge', '-p', JSON.stringify({ data: { 'nginx.conf': changed } })]);
  // nginx.conf is a subPath mount. A Pod replacement loads the temporary configuration.
  k(['rollout', 'restart', 'deployment/secondary-restic']);
  k(['rollout', 'status', 'deployment/secondary-restic', '--timeout=5m'], { timeout: 330000 });
  if (!enabled) k(['scale', 'deployment/secondary-restic-controller', '--replicas=1']);
  await until('secondary still serves reader recovery', () => restic('secondary', 'reader', 'cat config', { allowFailure: true, record: false }).status === 0);
}
async function inspectVolume(name, shell) {
  const pod = `${name}-inspect`;
  apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: pod }, spec: { automountServiceAccountToken: false, restartPolicy: 'Never',
    containers: [{ name: 'inspect', image: nativeImage, command: ['/bin/sh', '-ec', shell], volumeMounts: [{ name: 'data', mountPath: '/data' }] }],
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `${name}-data` } }] } });
  const result = await until(`${name} volume inspection`, () => {
    const object = get('pod', pod, { record: false });
    return ['Succeeded', 'Failed'].includes(object.status.phase) ? object : null;
  }, 300000);
  k(['logs', pod]); k(['delete', 'pod', pod, '--wait=true']);
  assert(`${name} native on-disk state assertion`, result.status.phase === 'Succeeded');
}
async function remove(name) {
  await stop(name);
  command('helm', ['uninstall', name, '--namespace', namespace, '--wait', '--timeout', '3m'], { timeout: 210000 });
  k(['delete', 'pod', `${name}-client`, '--ignore-not-found', '--wait=true']);
  k(['delete', 'pvc', `${name}-data`, '--wait=true', '--timeout=3m'], { timeout: 210000 });
  k(['delete', 'secret', ...['auth', 'key', 'tls', 'reader', 'writer', 'admin'].map(suffix => `${name}-${suffix}`)]);
  const remaining = await until(`${name} owned resource garbage collection`, () => {
    const items = get('pods,pvc,secrets,deployments,cronjobs,jobs,services,configmaps,resticapplications', null, { record: false }).items;
    return items.some(item => item.metadata.name.startsWith(`${name}-`)) ? null : items;
  });
  assert(`${name} release and owned storage removed`, true, { remaining: remaining.map(item => ({ kind: item.kind, name: item.metadata.name })) });
}
let owned = false;
try {
  const versions = JSON.parse(command('kubectl', ['version', '-o', 'json']).stdout);
  evidence.environment.kubernetesClient = versions.clientVersion?.gitVersion; evidence.environment.kubernetesServer = versions.serverVersion?.gitVersion;
  evidence.environment.helm = command('helm', ['version', '--short']).stdout.trim(); evidence.environment.openssl = command('openssl', ['version']).stdout.trim();
  k(['create', 'namespace', namespace]); owned = true; evidence.namespaceCleanup = 'retained-after-failure';
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Disposable Lifecycle CA', '-keyout', join(privateDir, 'ca.key'), '-out', join(privateDir, 'ca.crt')]);
  caText = readFileSync(join(privateDir, 'ca.crt'), 'utf8');
  credentials('primary'); pvc('primary'); install('primary', baseValues('primary')); await state('primary', 'Ready'); await client('primary');
  evidence.environment.restic = restic('primary', 'reader', 'version').stdout.trim();
  assert('fresh initialization creates all declared repositories', ['alpha', 'beta'].every(repository => restic('primary', 'reader', 'cat config', {}, repository).status === 0));
  secondaryIdentity = credentials('secondary'); pvc('secondary');
  const secondaryValues = baseValues('secondary');
  for (const repository of secondaryValues.repositories) repository.recovery = { host: host('primary'), repository: repository.name, credentialsSecret: 'primary-reader' };
  install('secondary', secondaryValues); await state('secondary', 'Ready'); await client('secondary');
  assert('configured empty native history initializes secondary', snapshots('secondary').length === 0);
  for (const name of ['primary', 'secondary']) {
    for (const deployment of [`${name}-restic`, `${name}-restic-controller`]) evidence.environment.endpointImages.push(...get('deployment', deployment).spec.template.spec.containers.map(container => ({ endpoint: name, name: container.name, image: container.image })));
  }
  const pvcs = get('pvc').items;
  assert('independent primary and secondary storage', pvcs.length === 2 && pvcs.every(volume => volume.spec.volumeName) && new Set(pvcs.map(volume => volume.spec.volumeName)).size === 2);
  // Restic 0.19.1 retries transient backend errors for up to 15 minutes.
  // Start this independent refusal early; never shorten or bypass native behavior.
  credentials('unreachable'); pvc('unreachable');
  const unreachable = baseValues('unreachable');
  for (const repository of unreachable.repositories) repository.recovery = { host: 'unreachable.invalid', repository: repository.name, credentialsSecret: 'secondary-reader' };
  install('unreachable', unreachable);
  const identity = JSON.parse(restic('primary', 'reader', 'cat config').stdout).id;
  await stop('primary');
  await stoppedRestart('primary');
  credentials('competitor');
  install('competitor', { ...baseValues('competitor'), existingClaim: 'primary-data' });
  const competitor = await state('competitor', 'Failed'); await noAccess('competitor');
  assert('second application cannot admit the already-owned PVC', /another application|claim belongs/i.test(competitor.status.reason) && !get('jobs').items.some(job => job.metadata.ownerReferences?.some(owner => owner.uid === competitor.metadata.uid)));
  await stop('competitor');
  const existing = app('primary').spec.repositories.map(repository => ({ ...repository, recovery: { host: 'unreachable.invalid', repository: repository.name, credentialsSecret: 'unavailable' } }));
  patch('primary', { replicas: 1, repositories: existing }); await state('primary', 'Ready');
  assert('existing state restarts without recovery credentials or network', JSON.parse(restic('primary', 'reader', 'cat config').stdout).id === identity);
  // Keep the older point in a small independent native pack, so it remains promptly restorable during throttled reconstruction of the much larger newer point.
  exec('primary-client', 'mkdir /fixture; dd if=/dev/urandom of=/fixture/payload bs=1024 count=64');
  evidence.payloadSHA256 = exec('primary-client', 'sha256sum /fixture/payload').stdout.trim().split(/\s/)[0];
  restic('primary', 'writer', 'backup /fixture --host lifecycle-proof --tag older', { timeout: 300000 });
  const older = snapshots('primary')[0];
  exec('primary-client', "dd if=/dev/urandom of=/fixture/payload bs=1048576 count=64; printf 'newer point\\n' > /fixture/marker");
  restic('primary', 'writer', 'backup /fixture --host lifecycle-proof --tag newer');
  patch('primary', { replication: [{ name: 'alpha', repository: 'alpha', sourceCredentialsSecret: 'primary-key', destination: { host: host('secondary'), repository: 'alpha', credentialsSecret: 'secondary-writer' }, schedule: '* * * * *' }] });
  await state('primary', 'Ready');
  await until('two native points copied', () => snapshots('secondary').length === 2, 300000);
  const retained = snapshots('secondary').find(point => point.original === older.id);
  assert('secondary retains exact older native history', retained?.tree === older.tree && retained?.time === older.time);
  // An independently queued old Job must not gain the current installation's authority.
  // Leave it unowned so reconciliation cannot merely delete it instead of exercising worker admission.
  const template = get('cronjob', 'primary-restic-copy-alpha').spec.jobTemplate;
  apply({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'queued-stale-copy' }, spec: { ...template.spec, suspend: true } });
  const originalReplication = app('primary').spec.replication;
  patch('primary', { replication: originalReplication.map(copy => ({ ...copy, suspend: true, destination: { ...copy.destination, host: 'changed-destination.invalid' } })) });
  await state('primary', 'Ready');
  k(['patch', 'job', 'queued-stale-copy', '--type=merge', '-p', '{"spec":{"suspend":false}}']);
  const stale = await until('old queued copy rejects changed application generation', () => {
    const job = get('job', 'queued-stale-copy', { record: false });
    return job.status?.conditions?.some(condition => condition.type === 'Failed' && condition.status === 'True') ? job : null;
  }, 180000);
  const refusal = k(['logs', 'job/queued-stale-copy']).stdout;
  assert('queued copy refuses stale generation before native destination access', stale.status.failed >= 1 && /replication requires its admitted generation to be current and Ready/.test(refusal) && !/changed-destination\.invalid|no such host|dial tcp/i.test(refusal));
  k(['delete', 'job', 'queued-stale-copy', '--wait=true']);
  patch('primary', { replication: originalReplication.map(copy => ({ ...copy, suspend: true })) }); await state('primary', 'Ready');
  await remove('primary');
  await restore('secondary', retained.id, evidence.payloadSHA256, 'survivor', true);
  // No primary PVC, installation Secret or original client remains. New target uses only saved independent configuration and surviving secondary credentials.
  credentials('replacement'); pvc('replacement'); install('replacement', baseValues('replacement', true)); await state('replacement', 'Ready'); await client('replacement');
  const restored = snapshots('replacement');
  const restoredOlder = restored.find(point => (point.original || point.id) === older.id || point.tree === older.tree && point.time === older.time);
  assert('ordinary replacement startup reconstructs complete native history', restored.length === 2 && !!restoredOlder);
  evidence.snapshotID = restoredOlder.id;
  evidence.repositoryID = JSON.parse(restic('replacement', 'reader', 'cat config').stdout).id;
  await restore('replacement', restoredOlder.id, evidence.payloadSHA256, 'older', true);
  const newest = restored.find(point => point.tags?.includes('newer'));
  restic('replacement', 'reader', `restore ${newest.id} --target /latest`);
  exec('replacement-client', 'test -f /latest/fixture/marker');
  assert('replacement latest point includes newer data', true);
  exec('replacement-client', 'mkdir /new; dd if=/dev/urandom of=/new/payload bs=1048576 count=32');
  const denied = restic('replacement', 'reader', 'backup /new --host denied-reader', { allowFailure: true });
  assert('reader cannot create new backup after replacement', denied.status !== 0 && /403|forbidden|permission/i.test(denied.stderr + denied.stdout));
  const unauthorized = exec('replacement-client', script('replacement', 'writer', 'backup /new --host denied-authentication').replace('; restic ', '; RESTIC_REST_PASSWORD=invalid-qualification-password restic '), { allowFailure: true });
  assert('invalid credentials cannot publish new backup after recovery', unauthorized.status !== 0 && /401|unauthorized|authentication/i.test(unauthorized.stderr + unauthorized.stdout) && snapshots('replacement').length === 2);
  restic('replacement', 'writer', 'backup /new --host replacement-writer');
  assert('writer creates new native backup after recovery', snapshots('replacement').length === 3);
  await rateLimit(true);
  // Recovery is demonstrably executing native copy, not merely waiting for a Pod.
  for (const [name, abrupt] of [['interrupted', true], ['stopped', false]]) {
    credentials(name); pvc(name);
    const recoveryValues = baseValues(name, true);
    install(name, recoveryValues);
    const active = await activeJob(name); await noAccess(name);
    await restore('secondary', retained.id, evidence.payloadSHA256, `during-${name}`, true);
    assert(`${name} recovery stays active during independent secondary restore`, get('pod', active.pod.metadata.name).status.phase === 'Running' && get('job', active.job.metadata.name).status.active === 1);
    if (abrupt) {
      k(['delete', 'pod', active.pod.metadata.name, '--grace-period=30', '--wait=true']);
      await state(name, 'Failed'); await noAccess(name);
      await nativeLocksReleased('interrupted recovery');
      k(['rollout', 'restart', `deployment/${name}-restic-controller`]);
      await state(name, 'Failed'); await noAccess(name);
      assert('interrupted recovery remains Failed across controller restart', true);
    } else {
      await stop(name);
      await nativeLocksReleased('stop during recovery');
      await inspectVolume(name, 'test -z \"$(find /data/alpha/locks -type f -print 2>/dev/null)\"; test -f /data/.bartl-transition');
      await stoppedRestart(name);
      patch(name, { replicas: 1 }); await state(name, 'Failed'); await noAccess(name);
      assert('stop during recovery remains blocking on ordinary start', true);
    }
  }
  await rateLimit(false);
  // A fresh discarded target succeeds, unlike an ambiguous interrupted target.
  credentials('retry'); pvc('retry'); install('retry', baseValues('retry', true)); await state('retry', 'Ready'); await client('retry');
  await restore('retry', snapshots('retry').find(point => point.tags?.includes('older')).id, evidence.payloadSHA256, 'retry-older', true);
  // Long copy uses new incompressible bytes, so existing deduplication cannot make it instantaneous.
  exec('replacement-client', 'dd if=/dev/urandom of=/new/long bs=1048576 count=128');
  restic('replacement', 'writer', 'backup /new --host replacement-long', { timeout: 300000 });
  await rateLimit(true);
  patch('replacement', { replication: [{ name: 'alpha', repository: 'alpha', sourceCredentialsSecret: 'replacement-key', destination: { host: host('secondary'), repository: 'alpha', credentialsSecret: 'secondary-writer' }, schedule: '* * * * *' }] });
  await state('replacement', 'Ready'); const copying = await activeJob('replacement', true);
  await restore('secondary', retained.id, evidence.payloadSHA256, 'during-copy', true);
  assert('real replication remains active during secondary restore', get('job', copying.job.metadata.name).status.active === 1);
  await stop('replacement');
  await nativeLocksReleased('stop during replication');
  await stoppedRestart('replacement');
  assert('stop cancels real copy before reporting Stopped', !get('pods').items.some(pod => pod.metadata.name.startsWith('replacement-restic-copy-') && !['Succeeded', 'Failed'].includes(pod.status.phase)));
  await rateLimit(false);
  await stop('retry');
  await inspectVolume('retry', 'mkdir /data/damaged; printf orphan > /data/damaged/orphan');
  const damagedRepositories = [...app('retry').spec.repositories, { name: 'damaged', authSecret: 'retry-auth', passwordSecret: 'retry-key' }];
  patch('retry', { replicas: 1, repositories: damagedRepositories }); await state('retry', 'Failed'); await noAccess('retry');
  await stop('retry');
  await inspectVolume('retry', 'test -s /data/damaged/orphan; test ! -e /data/damaged/config; test -s /data/alpha/config');
  assert('damaged nonempty repository blocks entire application without reinitialization', true);
  // A malformed native snapshot can be warned about and skipped by snapshots --json with exit zero.
  // Keep this source independent of the surviving secondary and all its consumers.
  credentials('corruptsource'); pvc('corruptsource');
  install('corruptsource', baseValues('corruptsource')); await state('corruptsource', 'Ready'); await client('corruptsource');
  const corruptID = 'c'.repeat(64);
  k(['exec', 'deployment/corruptsource-restic', '-c', 'repository', '--', '/bin/sh', '-ec', `printf malformed-encrypted-snapshot > /data/alpha/snapshots/${corruptID}`]);
  const skipped = restic('corruptsource', 'reader', 'snapshots --json');
  const listed = restic('corruptsource', 'reader', 'list snapshots');
  assert('native snapshot enumeration can warn and omit a corrupt object with successful exit', skipped.status === 0 && JSON.parse(skipped.stdout).length === 0 && /error|invalid|failed|unable|short/i.test(skipped.stderr) && listed.stdout.includes(corruptID));
  credentials('corrupttarget'); pvc('corrupttarget');
  const corruptTarget = baseValues('corrupttarget');
  for (const repository of corruptTarget.repositories) repository.recovery = { host: host('corruptsource'), repository: repository.name, credentialsSecret: 'corruptsource-reader' };
  install('corrupttarget', corruptTarget); await state('corrupttarget', 'Failed'); await noAccess('corrupttarget');
  await stop('corrupttarget');
  await inspectVolume('corrupttarget', 'test ! -e /data/alpha/config; test ! -e /data/beta/config');
  assert('corrupt configured snapshot object fails observation instead of initializing an empty repository', true);
  await state('unreachable', 'Failed', 1200000); await noAccess('unreachable');
  await stop('unreachable');
  await inspectVolume('unreachable', 'test ! -e /data/alpha/config; test ! -e /data/beta/config');
  assert('unreachable configured recovery does not initialize empty target', true);
  evidence.status = 'passed';
  if (process.env.BARTL_RESTIC_KEEP_NAMESPACE === '1') evidence.namespaceCleanup = 'retained-by-request';
  else {
    for (const object of get('resticapplications').items) await stop(object.metadata.name.replace(/-restic$/, ''));
    k(['delete', 'namespace', namespace, '--wait=true', '--timeout=3m'], { timeout: 210000 }); evidence.namespaceCleanup = 'deleted';
  }
} catch (error) {
  evidence.status = 'failed'; evidence.failure = redact(error.stack || error); evidence.failureSummary = failureReason(error); process.exitCode = 1;
  if (owned) {
    k(['get', 'resticapplications,pods,jobs,deployments,pvc,cronjobs', '-o', 'json'], { allowFailure: true });
    k(['get', 'events', '--sort-by=.lastTimestamp'], { allowFailure: true });
    const pods = k(['get', 'pods', '-o', 'json'], { allowFailure: true, record: false });
    if (pods.status === 0) for (const pod of JSON.parse(pods.stdout).items) for (const container of pod.spec.containers) k(['logs', pod.metadata.name, '-c', container.name, '--tail=100'], { allowFailure: true });
  }
} finally {
  rmSync(privateDir, { recursive: true, force: true }); evidence.finished = new Date().toISOString(); persist();
  console.log(`Qualification: ${join(directory, 'qualification.json')}`);
  console.log(`Private diagnostics: ${join(directory, 'raw.json')}`);
  if (owned && evidence.namespaceCleanup !== 'deleted') console.log(`Retained namespace: ${namespace}`);
}
