#!/usr/bin/env node
// Existing authorized disposable Hetzner cluster only; immutable chart/image inputs.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactDirectory } from './artifacts.mjs';
import { uninstallStoppedApplication } from './removal.mjs';

const chart = process.env.BARTL_RESTIC_CHART || '';
const image = process.env.BARTL_RESTIC_IMAGE || '';
const reuse = process.env.BARTL_RESTIC_REUSE === '1';
const publishedChart = /^oci:\/\/[^\s]+@sha256:[a-f0-9]{64}$/.test(chart);
const localChart = !chart.startsWith('oci:') && chart.endsWith('.tgz') && (() => {
  try { return statSync(chart).isFile(); } catch { return false; }
})();
if (process.env.BARTL_RESTIC_LAB !== 'hetzner' || !process.env.KUBECONFIG ||
    !(publishedChart || localChart) ||
    !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(image)) {
  console.error('Require BARTL_RESTIC_LAB=hetzner, KUBECONFIG, digest-pinned OCI or local packaged .tgz BARTL_RESTIC_CHART and immutable BARTL_RESTIC_IMAGE. Set BARTL_RESTIC_REUSE=1 for candidate reinstall proof.');
  process.exit(2);
}
const chartFingerprint = localChart ? createHash('sha256').update(readFileSync(chart)).digest('hex') : null;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const namespace = `restic-uninstall-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const release = 'preservation';
const application = `${release}-restic`;
const hostname = `${application}.${namespace}.svc`;
const directory = createArtifactDirectory(root, namespace);
const privateDir = join(directory, 'private');
mkdirSync(privateDir, { mode: 0o700 });
const rawLog = join(directory, 'raw.jsonl');
const sensitive = [];
const redact = value => sensitive.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
const log = entry => appendFileSync(rawLog, redact(JSON.stringify(entry)) + '\n', { mode: 0o600 });
function command(binary, args, { input, allowFailure = false, record = true, timeout = 30000 } = {}) {
  if (binary === 'helm' && localChart && createHash('sha256').update(readFileSync(chart)).digest('hex') !== chartFingerprint) {
    throw new Error('Local packaged chart changed during regression; refusing a different installation artifact');
  }
  const started = Date.now();
  const result = spawnSync(binary, args, { input, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  // Secret reads never enter the raw log, even in an error response.
  log({ command: [binary, ...args], durationMs: Date.now() - started, status: result.status,
    ...(record ? { stdout: result.stdout || '', stderr: result.stderr || '' } : { output: '[PRIVATE]' }),
    error: result.error?.code });
  if ((result.status !== 0 || result.error) && !allowFailure) throw new Error(`${binary} failed; inspect raw logs`);
  return { ...result, stdout: result.stdout || '', stderr: result.stderr || '' };
}
const k = (args, options) => command('kubectl', ['--namespace', namespace, '--request-timeout=20s', ...args], options);
const get = (kind, name) => JSON.parse(k(['get', kind, ...(name ? [name] : []), '-o', 'json'], { record: kind !== 'secret' }).stdout);
const apply = object => k(['apply', '-f', '-'], { input: JSON.stringify(object) });
function secret(name, data, type = 'Opaque') {
  for (const value of Object.values(data)) sensitive.push(value, Buffer.from(value).toString('base64'));
  apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name }, type, stringData: data });
}
function assert(name, passed) {
  log({ assertion: name, passed: !!passed });
  if (!passed) throw new Error(`Assertion failed: ${name}`);
  console.log(`PASS ${name}`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(name, check, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await sleep(1000);
  }
  throw new Error(`Timed out: ${name}`);
}
const app = () => get('resticapplication', application);
async function state(expected) {
  return until(`current-generation ${expected}`, () => {
    const object = app();
    const generation = object.metadata.generation;
    if (expected === 'Ready' && object.status?.state === 'Failed' && object.status.observedGeneration === generation) {
      throw new Error(`Ready refused: ${object.status.reason || object.status.conditions?.find(condition => condition.type === 'Failed')?.message || 'Failed without reason'}`);
    }
    return object.status?.state === expected && object.status.observedGeneration === generation &&
      object.status.conditions?.some(condition => condition.type === expected && condition.status === 'True' && condition.observedGeneration === generation) &&
      (expected !== 'Stopped' || object.spec.replicas === 0) ? object : null;
  }, 600000);
}
const exec = (script, options) => k(['exec', 'native-client', '--', '/bin/sh', '-ec', script], options);
function restic(operation, options) {
  return exec(`export RESTIC_REPOSITORY='rest:https://${hostname}/alpha/' RESTIC_PASSWORD_FILE=/credentials/password; export RESTIC_REST_USERNAME="$(cat /credentials/username)" RESTIC_REST_PASSWORD="$(cat /credentials/restPassword)"; restic --cacert /credentials/ca.crt ${operation}`, options);
}
function install() {
  command('helm', ['upgrade', '--install', release, chart, '--namespace', namespace, '-f', join(privateDir, 'values.json'), '--wait=legacy', '--timeout', '5m'], { timeout: 330000 });
}
const ready = pod => pod.status.phase === 'Running' && !pod.metadata.deletionTimestamp &&
  pod.status.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True');
function controller() {
  const deployment = get('deployment', `${application}-controller`);
  const replicaSets = get('replicasets').items.filter(item => item.metadata.ownerReferences?.some(owner => owner.uid === deployment.metadata.uid));
  const pods = get('pods').items.filter(item => item.metadata.ownerReferences?.some(owner => replicaSets.some(rs => rs.metadata.uid === owner.uid)));
  const running = pods.filter(ready);
  if (running.length !== 1) throw new Error('Controller is not a single Ready running Pod');
  return running[0];
}
function assertPublishedImages(round) {
  const object = app();
  const pods = get('pods').items;
  const owned = pods.filter(pod => pod.metadata.labels?.['app.kubernetes.io/name'] === application);
  const worker = pods.filter(pod => pod.metadata.ownerReferences?.some(owner => owner.uid === object.status.operation?.jobUID))
    .flatMap(pod => pod.status.containerStatuses || []).filter(container => container.name === 'worker');
  const guard = owned.flatMap(pod => pod.status.initContainerStatuses || []).filter(container => container.name === 'install-admission-guard');
  const controllers = controller().status.containerStatuses.filter(container => container.name === 'controller');
  const digest = image.slice(image.indexOf('@') + 1);
  const matches = statuses => statuses.length > 0 && statuses.every(status => status.imageID?.endsWith(digest));
  assert(`${round}: chart default, application, controller, native worker and guard use the supplied digest`,
    object.spec.image === image && matches(controllers) && matches(worker) && matches(guard));
}
function retainedSecrets() {
  return Object.fromEntries(['fixture-auth', 'fixture-key', 'fixture-tls', 'fixture-client'].map(name => {
    const object = get('secret', name);
    return [name, { uid: object.metadata.uid, type: object.type, data: object.data }];
  }));
}
function secretsUnchanged(before) {
  const after = retainedSecrets();
  return Object.keys(before).every(name => before[name].uid === after[name].uid && before[name].type === after[name].type &&
    Object.keys(before[name].data).length === Object.keys(after[name].data).length &&
    Object.entries(before[name].data).every(([key, value]) => after[name].data[key] === value));
}
const owner = () => get('pvc', 'fixture-data').metadata.annotations?.['restic.bartl.sh/application-uid'];
async function contender(round, originalUID) {
  const competingRelease = 'contender';
  const name = `${competingRelease}-restic`;
  command('helm', ['upgrade', '--install', competingRelease, chart, '--namespace', namespace,
    '-f', join(privateDir, 'values.json'), '--wait=legacy', '--timeout', '5m'], { timeout: 330000 });
  const rejected = await until(`${round}: contender ownership refusal`, () => {
    const object = get('resticapplication', name);
    return object.status?.state === 'Failed' && object.status.observedGeneration === object.metadata.generation ? object : null;
  });
  assert(`${round}: fresh contender is refused without changing owner`,
    rejected.metadata.uid !== originalUID && /another application UID/.test(rejected.status.reason) && owner() === originalUID &&
    !get('jobs').items.some(job => job.metadata.ownerReferences?.some(reference => reference.uid === rejected.metadata.uid)));
  command('helm', ['upgrade', competingRelease, chart, '--namespace', namespace, '--reuse-values',
    '--set', 'application.replicas=0', '--wait=legacy', '--timeout', '5m'], { timeout: 330000 });
  await until(`${round}: contender stopped`, () => {
    const object = get('resticapplication', name);
    return object.spec.replicas === 0 && object.status?.state === 'Stopped' &&
      object.status.observedGeneration === object.metadata.generation &&
      object.status.conditions?.some(condition => condition.type === 'Stopped' && condition.status === 'True' &&
        condition.observedGeneration === object.metadata.generation);
  });
  uninstallStoppedApplication({ namespace, release: competingRelease, command });
  assert(`${round}: contender deletion preserves the foreign owner`, owner() === originalUID);
}
function captureLifecycle() {
  const object = app();
  const job = get('job', object.status.operation.jobName);
  const configs = Object.fromEntries(job.spec.template.spec.volumes.filter(volume => volume.configMap)
    .map(volume => [volume.configMap.name, get('configmap', volume.configMap.name).data]));
  assert('capture completed real lifecycle Job with original application identity',
    job.spec.template.spec.containers.find(container => container.name === 'worker').env
      .some(variable => variable.name === 'APPLICATION_UID' && variable.value === object.metadata.uid));
  return { spec: job.spec, configs };
}
async function replayStaleLifecycle(captured, oldUID, history) {
  apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'retained-inspector' }, spec: {
    automountServiceAccountToken: false, restartPolicy: 'Never',
    containers: [{ name: 'inspect', image, command: ['/bin/sh', '-ec', 'while :; do sleep 3600; done'],
      volumeMounts: [{ name: 'data', mountPath: '/repository', readOnly: true }] }],
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'fixture-data', readOnly: true } }] } });
  k(['wait', '--for=condition=Ready', 'pod/retained-inspector', '--timeout=5m'], { timeout: 330000 });
  const fingerprint = () => k(['exec', 'retained-inspector', '--', '/bin/sh', '-ec',
    'find /repository -type f -exec sha256sum {} + > /tmp/retained-files; sort /tmp/retained-files; find /repository -print > /tmp/retained-paths; sort /tmp/retained-paths']).stdout;
  const before = fingerprint();
  assert('stale replay fingerprints native repository data and existing lock marker',
    before.includes('/repository/alpha/config') && before.includes('/repository/.bartl-lock'));
  const spec = structuredClone(captured.spec);
  delete spec.selector;
  delete spec.manualSelector;
  delete spec.managedBy;
  spec.suspend = false;
  spec.backoffLimit = 0;
  spec.activeDeadlineSeconds = 120;
  spec.template.metadata = { labels: { 'restic.bartl.sh/stale-replay': 'true' } };
  for (const [index, volume] of spec.template.spec.volumes.entries()) {
    if (!volume.configMap) continue;
    const name = `stale-lifecycle-config-${index}`;
    apply({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name }, data: captured.configs[volume.configMap.name] });
    volume.configMap.name = name;
  }
  const worker = spec.template.spec.containers.find(container => container.name === 'worker');
  assert('replay retains old APPLICATION_UID and original lifecycle command',
    worker.env.some(variable => variable.name === 'APPLICATION_UID' && variable.value === oldUID) &&
    worker.command[1] === 'lifecycle' && oldUID !== app().metadata.uid);
  apply({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'stale-lifecycle-replay' }, spec });
  await until('stale lifecycle worker exits', () => {
    const job = get('job', 'stale-lifecycle-replay');
    return job.status?.conditions?.some(condition => ['Failed', 'Complete'].includes(condition.type) && condition.status === 'True');
  });
  const job = get('job', 'stale-lifecycle-replay');
  const pods = get('pods').items.filter(pod => pod.metadata.ownerReferences?.some(reference => reference.uid === job.metadata.uid));
  const output = pods.map(pod => k(['logs', pod.metadata.name, '-c', 'worker']).stdout).join('\n');
  assert('actual stale lifecycle worker refuses the old application identity before native mutation',
    pods.length === 1 && pods[0].status.containerStatuses?.find(container => container.name === 'worker')?.state.terminated?.exitCode !== 0 &&
    /current application identity refuses work/.test(output) &&
    job.status.conditions?.some(condition => condition.type === 'Failed' && condition.status === 'True'));
  assert('stale replay leaves every retained file and native marker unchanged', fingerprint() === before);
  assert('stale replay preserves exact repository history and new owner',
    JSON.stringify(JSON.parse(restic('snapshots --json').stdout)) === JSON.stringify(history) && owner() === app().metadata.uid);
  k(['delete', 'job', 'stale-lifecycle-replay', '--wait=true', '--timeout=3m'], { timeout: 210000 });
  k(['delete', 'pod', 'retained-inspector', '--wait=true', '--timeout=3m'], { timeout: 210000 });
}
async function stopAndUninstall(round, pvcUID, secrets) {
  const initialController = controller();
  const initialStatus = initialController.status.containerStatuses.find(container => container.name === 'controller');
  command('helm', ['upgrade', release, chart, '--namespace', namespace, '--reuse-values', '--set', 'application.replicas=0', '--wait=legacy', '--timeout', '5m'], { timeout: 330000 });
  const stopped = await state('Stopped');
  await until('actual endpoint and lifecycle drainage', () => {
    const deployment = get('deployment', application);
    const replicasets = get('replicasets').items.filter(object => object.metadata.ownerReferences?.some(owner => owner.uid === deployment.metadata.uid));
    const pods = get('pods').items.filter(pod => pod.metadata.labels?.['app.kubernetes.io/name'] === application);
    const jobs = get('jobs').items.filter(job => job.metadata.ownerReferences?.some(owner => owner.uid === stopped.metadata.uid));
    const cronjobs = get('cronjobs').items.filter(job => job.metadata.ownerReferences?.some(owner => owner.uid === stopped.metadata.uid));
    const slices = get('endpointslices').items.filter(slice => slice.metadata.labels?.['kubernetes.io/service-name'] === application);
    return deployment.spec.replicas === 0 && deployment.status?.observedGeneration >= deployment.metadata.generation &&
      (deployment.status?.replicas || 0) === 0 && replicasets.every(rs => rs.spec.replicas === 0 && (rs.status?.replicas || 0) === 0) &&
      pods.every(pod => ['Succeeded', 'Failed'].includes(pod.status.phase)) &&
      jobs.every(job => !job.status?.active) && cronjobs.every(job => job.spec.suspend === true) &&
      !slices.some(slice => slice.endpoints?.some(endpoint => endpoint.conditions?.ready !== false));
  });
  assert(`${round}: current-generation Stopped condition and actual endpoint/lifecycle drainage`, true);
  if (reuse) {
    assert(`${round}: ordinary stop retains the original owner fence`, owner() === stopped.metadata.uid);
    await contender(`${round}-stopped`, stopped.metadata.uid);
  }
  uninstallStoppedApplication({ namespace, release, command(binary, args, options) {
    if (binary === 'helm' && args[0] === 'uninstall') {
      const absent = k(['get', 'resticapplication', application, '--ignore-not-found', '-o', 'json']).stdout.trim() === '';
      const current = controller();
      const currentStatus = current.status.containerStatuses.find(container => container.name === 'controller');
      assert(`${round}: application finalized before Helm removal with the same Ready running controller UID`,
        absent && current.metadata.uid === initialController.metadata.uid &&
        currentStatus.restartCount === initialStatus.restartCount &&
        currentStatus.state.running?.startedAt === initialStatus.state.running?.startedAt);
    }
    return command(binary, args, options);
  } });
  await until('application and controller absent', () => {
    const objects = get('resticapplications,deployments,pods').items;
    return !objects.some(object => object.metadata.name === application || object.metadata.name === `${application}-controller` || object.metadata.name.startsWith(`${application}-controller-`));
  });
  const releases = JSON.parse(command('helm', ['list', '--namespace', namespace, '--filter', `^${release}$`, '-o', 'json']).stdout);
  assert(`${round}: application, controller and Helm release are gone`, releases.length === 0);
  assert(`${round}: operator PVC UID and Secret UIDs/types/data are unchanged`, get('pvc', 'fixture-data').metadata.uid === pvcUID && secretsUnchanged(secrets));
}
async function restore(snapshot, expectedHash, target, round) {
  restic(`--no-cache restore ${snapshot} --target /${target}`, { timeout: 330000 });
  const hash = exec(`sha256sum /${target}/fixture/payload`).stdout.trim().split(/\s/)[0];
  assert(`${round}: authenticated native restore is byte-correct`, hash === expectedHash);
}
let owned = false;
try {
  const defaults = command('helm', ['show', 'values', chart], { timeout: 120000 }).stdout;
  const defaultImage = defaults.match(/^image:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
  assert('immutable chart default image equals the supplied image', defaultImage === image);
  k(['create', 'namespace', namespace]);
  owned = true;
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Disposable Uninstall CA', '-keyout', join(privateDir, 'ca.key'), '-out', join(privateDir, 'ca.crt')]);
  command('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${hostname}`, '-keyout', join(privateDir, 'tls.key'), '-out', join(privateDir, 'tls.csr')]);
  writeFileSync(join(privateDir, 'tls.ext'), `subjectAltName=DNS:${hostname}\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
  command('openssl', ['x509', '-req', '-in', join(privateDir, 'tls.csr'), '-CA', join(privateDir, 'ca.crt'), '-CAkey', join(privateDir, 'ca.key'), '-CAcreateserial', '-days', '2', '-extfile', join(privateDir, 'tls.ext'), '-out', join(privateDir, 'tls.crt')]);
  const password = randomBytes(32).toString('hex');
  const roles = Object.fromEntries(['reader', 'writer', 'admin'].map(role => [role, randomBytes(24).toString('hex')]));
  sensitive.push(password, ...Object.values(roles));
  const htpasswd = Object.entries(roles).map(([role, value]) => `${role}:${command('openssl', ['passwd', '-apr1', '-stdin'], { input: value + '\n', record: false }).stdout.trim()}`).join('\n') + '\n';
  secret('fixture-auth', { htpasswd });
  secret('fixture-key', { password });
  secret('fixture-tls', { 'tls.crt': readFileSync(join(privateDir, 'tls.crt'), 'utf8'), 'tls.key': readFileSync(join(privateDir, 'tls.key'), 'utf8') }, 'kubernetes.io/tls');
  secret('fixture-client', { username: 'admin', restPassword: roles.admin, password, 'ca.crt': readFileSync(join(privateDir, 'ca.crt'), 'utf8') });
  apply({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'fixture-data' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '3Gi' } } } });
  writeFileSync(join(privateDir, 'values.json'), JSON.stringify({ existingClaim: 'fixture-data', tlsSecret: 'fixture-tls', repositories: [{ name: 'alpha', authSecret: 'fixture-auth', passwordSecret: 'fixture-key' }] }), { mode: 0o600 });
  install();
  await state('Ready');
  assertPublishedImages('initial install');
  apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'native-client' }, spec: { automountServiceAccountToken: false, restartPolicy: 'Never',
    containers: [{ name: 'native', image, command: ['/bin/sh', '-ec', 'while :; do sleep 3600; done'], volumeMounts: [{ name: 'credentials', mountPath: '/credentials', readOnly: true }] }],
    volumes: [{ name: 'credentials', secret: { secretName: 'fixture-client', defaultMode: 0o400 } }] } });
  k(['wait', '--for=condition=Ready', 'pod/native-client', '--timeout=5m'], { timeout: 330000 });
  assert('native client runs the supplied image digest', get('pod', 'native-client').status.containerStatuses[0].imageID.endsWith(image.split('@')[1]));
  const repositoryID = JSON.parse(restic('cat config').stdout).id;
  assert('native repository has an ID', /^[a-f0-9]{64}$/.test(repositoryID));
  exec('mkdir /fixture; dd if=/dev/urandom of=/fixture/payload bs=1024 count=64');
  const payloadHash = exec('sha256sum /fixture/payload').stdout.trim().split(/\s/)[0];
  restic('backup /fixture --host uninstall-proof --tag preserved', { timeout: 330000 });
  const snapshots = JSON.parse(restic('snapshots --json').stdout);
  assert('authenticated backup creates exactly one native snapshot', snapshots.length === 1);
  const snapshot = snapshots[0].id;
  await restore(snapshot, payloadHash, 'before-uninstall', 'initial install');
  const pvcUID = get('pvc', 'fixture-data').metadata.uid;
  const secrets = retainedSecrets();
  const originalUID = app().metadata.uid;
  const originalSpec = app().spec;
  const capturedLifecycle = reuse ? captureLifecycle() : null;
  if (reuse) {
    assert('initial owner is bound to the live application UID', owner() === originalUID);
    await contender('live-owner', originalUID);
  }
  await stopAndUninstall('uninstall', pvcUID, secrets);
  // Trusted operator readback of retained storage, not a new application claim.
  // Native locks remain enabled; readback never edits ownership or transition markers.
  apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'retained-reader' }, spec: { automountServiceAccountToken: false, restartPolicy: 'Never',
    containers: [{ name: 'native', image, command: ['/bin/sh', '-ec', 'while :; do sleep 3600; done'],
      volumeMounts: [{ name: 'data', mountPath: '/repository' }, { name: 'credentials', mountPath: '/credentials', readOnly: true }] }],
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'fixture-data' } },
      { name: 'credentials', secret: { secretName: 'fixture-client', defaultMode: 0o400 } }] } });
  k(['wait', '--for=condition=Ready', 'pod/retained-reader', '--timeout=5m'], { timeout: 330000 });
  const native = args => k(['exec', 'retained-reader', '--', 'restic', '--repo', '/repository/alpha',
    '--password-file', '/credentials/password', ...args], { timeout: 330000 });
  assert('retained repository identity and snapshot survive uninstall',
    JSON.parse(native(['cat', 'config']).stdout).id === repositoryID &&
    JSON.parse(native(['snapshots', '--json']).stdout).some(object => object.id === snapshot));
  native(['check', '--read-data']);
  native(['--no-cache', 'restore', snapshot, '--target', '/restore']);
  const restoredHash = k(['exec', 'retained-reader', '--', 'sha256sum', '/restore/fixture/payload']).stdout.trim().split(/\s/)[0];
  assert('retained repository passes native data check and byte-correct restore after uninstall', restoredHash === payloadHash);
  assert('readback preserves original PVC and Secrets', get('pvc', 'fixture-data').metadata.uid === pvcUID && secretsUnchanged(secrets));
  k(['delete', 'pod', 'retained-reader', '--wait=true', '--timeout=3m'], { timeout: 210000 });
  if (reuse) {
    assert('supported deletion released only the retired owner fence', !owner());
    install();
    const replacement = await state('Ready');
    assertPublishedImages('reinstall');
    assert('reinstall binds the identical PVC to a fresh application UID with unchanged configuration and Secrets',
      replacement.metadata.uid !== originalUID && owner() === replacement.metadata.uid &&
      get('pvc', 'fixture-data').metadata.uid === pvcUID && secretsUnchanged(secrets) &&
      JSON.stringify(replacement.spec) === JSON.stringify(originalSpec));
    const oldHistory = JSON.parse(restic('snapshots --json').stdout);
    assert('reinstalled endpoint exposes the identical repository ID and exact old history',
      JSON.parse(restic('cat config').stdout).id === repositoryID &&
      JSON.stringify(oldHistory) === JSON.stringify(snapshots));
    await restore(snapshot, payloadHash, 'after-reinstall-old', 'reinstall old point');
    await replayStaleLifecycle(capturedLifecycle, originalUID, oldHistory);
    exec('dd if=/dev/urandom of=/fixture/payload bs=1024 count=96');
    const changedHash = exec('sha256sum /fixture/payload').stdout.trim().split(/\s/)[0];
    assert('new backup payload differs from retained restore point', changedHash !== payloadHash);
    restic('backup /fixture --host uninstall-proof --tag after-reinstall', { timeout: 330000 });
    const newHistory = JSON.parse(restic('snapshots --json').stdout);
    const newPoints = newHistory.filter(point => !snapshots.some(old => old.id === point.id));
    assert('new owner accepts a new backup after stale worker refusal and preserves the old point',
      newHistory.length === snapshots.length + 1 && newPoints.length === 1 &&
      snapshots.every(old => newHistory.some(point => JSON.stringify(point) === JSON.stringify(old))) &&
      JSON.parse(restic('cat config').stdout).id === repositoryID);
    await restore(newPoints[0].id, changedHash, 'after-reinstall-new', 'reinstall new point');
    await restore(snapshot, payloadHash, 'after-new-backup-old', 'retained old point after new backup');
    restic('check --read-data', { timeout: 330000 });
    await stopAndUninstall('reinstalled teardown', pvcUID, secrets);
    assert('reinstalled application finalization releases its own fence', !owner());
  }
  // Separate destructive cleanup, after supported uninstall and preservation proof.
  k(['delete', 'namespace', namespace, '--wait=true', '--timeout=3m'], { timeout: 210000 });
  const absent = k(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'json']).stdout.trim() === '';
  assert('separate destructive fixture cleanup deletes the owned namespace', absent);
  owned = false;
  console.log(`Raw redacted logs: ${rawLog}`);
} catch (error) {
  log({ failure: error.message, namespace, namespaceRetained: owned });
  if (owned) {
    try {
      k(['get', 'resticapplications,deployments,replicasets,pods,jobs,cronjobs,services,endpointslices,pvc,events', '-o', 'json']);
      for (const pod of get('pods').items) k(['logs', pod.metadata.name, '--all-containers=true', '--tail=200'], { allowFailure: true, timeout: 30000 });
    } catch (diagnosticError) { log({ diagnosticsFailure: diagnosticError.message }); }
  }
  console.error(`FAIL ${error.message}${owned ? `; namespace retained: ${namespace}` : ''}`);
  console.error(`Raw redacted logs: ${rawLog}`);
  process.exitCode = 1;
} finally {
  rmSync(privateDir, { recursive: true, force: true });
}
