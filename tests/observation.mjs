#!/usr/bin/env node
// BARTL_RESTIC_LAB=hetzner KUBECONFIG=/private/kubeconfig BARTL_RESTIC_IMAGE=imported-image node tests/observation.mjs
// Existing disposable cluster only; all diagnostics and temporary credentials stay outside Git.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactDirectory, snapshotSource, failureReason } from './artifacts.mjs';
import { qualifyDrain } from './endpoint-drain.mjs';
import { uninstallStoppedApplication } from './removal.mjs';

if (process.env.BARTL_RESTIC_LAB !== 'hetzner' || !process.env.KUBECONFIG || !process.env.BARTL_RESTIC_IMAGE) {
  console.error('Require BARTL_RESTIC_LAB=hetzner, KUBECONFIG and BARTL_RESTIC_IMAGE; no infrastructure is created.'); process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const namespace = `restic-observe-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const directory = createArtifactDirectory(root, namespace);
const privateDir = join(directory, 'private'); mkdirSync(privateDir, { mode: 0o700 });
const evidence = { schema: 1, started: new Date().toISOString(), source: snapshotSource(root), namespace,
  scope: 'Endpoint admission observation outage, fresh-process refusal, confirmed ownership revocation, scoped worker RBAC and active HTTPS drain',
  environment: { endpointImages: [] }, namespaceCleanup: 'not-created', commands: [], assertions: [], status: 'running' };
const sensitive = [];
const redact = value => sensitive.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
const persist = () => writeFileSync(join(directory, 'raw.json'), redact(JSON.stringify(evidence, null, 2)) + '\n', { mode: 0o600 });
function command(binary, args, { input, allowFailure = false, record = true, timeout = 180000 } = {}) {
  const start = Date.now();
  const result = spawnSync(binary, args, { input, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  if (record) {
    evidence.commands.push({ command: [binary, ...args].map(redact), exit: result.status, durationMs: Date.now() - start,
      stdout: redact(result.stdout || '').slice(-24000), stderr: redact(result.stderr || '').slice(-24000), error: result.error?.message }); persist();
  }
  if ((result.status !== 0 || result.error) && !allowFailure) throw Object.assign(new Error(`${binary}: ${result.stderr || result.error || result.stdout}`),
    { publicReason: `${binary} failed (${result.error?.code || `exit ${result.status}`}); inspect private raw.json.` });
  return { ...result, stdout: result.stdout || '', stderr: result.stderr || '' };
}
const k = (args, options) => command('kubectl', ['--namespace', namespace, ...args], options);
const get = (kind, name, options) => JSON.parse(k(['get', kind, ...(name ? [name] : []), '-o', 'json'], options).stdout);
const apply = object => k(['apply', '-f', '-'], { input: JSON.stringify(object), record: false });
const shell = (pod, container, script, options) => k(['exec', pod, '-c', container, '--', '/bin/sh', '-ec', script], options);
const host = name => `${name}-restic.${namespace}.svc`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, syncCheck, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = syncCheck(); if (result) return result; await sleep(1000); }
  throw new Error(`Timed out: ${label}`);
}
function assert(name, condition, details = {}) {
  evidence.assertions.push({ name, passed: !!condition, ...details }); persist();
  if (!condition) throw new Error(`Assertion failed: ${name}`);
}
const app = () => get('resticapplication', 'primary-restic', { record: false });
async function state(expected) {
  return until(`primary current-generation ${expected}`, () => {
    const object = app();
    const condition = object.status?.conditions?.find(condition => condition.type === expected);
    return object.status?.state === expected && object.status.observedGeneration === object.metadata.generation
      && condition?.status === 'True' && condition.observedGeneration === object.metadata.generation ? object : null;
  }, 600000);
}
const endpointPods = () => get('pods', null, { record: false }).items.filter(pod => pod.metadata.labels?.['app.kubernetes.io/name'] === 'primary-restic' && !pod.metadata.deletionTimestamp);
async function endpoint() {
  return until('running endpoint Pod', () => endpointPods().find(pod => pod.status.phase === 'Running'), 300000);
}
async function stopController(name = 'primary') {
  k(['scale', `deployment/${name}-restic-controller`, '--replicas=0']);
  await until(`${name} controller paused`, () => !get('pods', null, { record: false }).items.some(pod => pod.metadata.name.startsWith(`${name}-restic-controller-`) && !['Succeeded', 'Failed'].includes(pod.status.phase)));
}
async function startController(name = 'primary') {
  k(['scale', `deployment/${name}-restic-controller`, '--replicas=1']);
  k(['rollout', 'status', `deployment/${name}-restic-controller`, '--timeout=3m'], { timeout: 210000 });
}
const restic = (role, operation, options) => shell('primary-client', 'restic',
  `export RESTIC_REPOSITORY='rest:https://${host('primary')}/alpha/' RESTIC_PASSWORD_FILE=/credentials/${role}/password; export RESTIC_REST_USERNAME="$(cat /credentials/${role}/username)" RESTIC_REST_PASSWORD="$(cat /credentials/${role}/restPassword)"; restic --cacert /credentials/${role}/ca.crt ${operation}`, options);
function request(pod, options = {}) {
  const direct = pod ? `--resolve '${host('primary')}:8443:${pod.status.podIP}'` : '';
  return shell('primary-client', 'curl', `curl --silent --show-error --fail --connect-timeout 2 --max-time 5 --cacert /credentials/reader/ca.crt --user "$(cat /credentials/reader/username):$(cat /credentials/reader/restPassword)" ${direct} 'https://${host('primary')}${pod ? ':8443' : ''}/alpha/config'`, { record: false, ...options });
}
async function accessible() { await until('client HTTPS accessible', () => request(null, { allowFailure: true }).status === 0); }
async function addProbe(pod) {
  const tokenVolume = pod.spec.volumes.find(volume => volume.projected?.sources?.some(source => source.serviceAccountToken));
  assert('endpoint uses its actual worker ServiceAccount and projected token', pod.spec.serviceAccountName === 'primary-restic-worker' && !!tokenVolume);
  k(['patch', 'pod', pod.metadata.name, '--subresource=ephemeralcontainers', '--type=strategic', '-p', JSON.stringify({ spec: { ephemeralContainers: [{
    name: 'api-probe', image: 'docker.io/curlimages/curl:8.12.1', targetContainerName: 'https',
    securityContext: { runAsUser: 0, capabilities: { add: ['NET_ADMIN'] } },
    command: ['/bin/sh', '-ec', 'apk add --no-cache iptables; exec sleep infinity'],
    volumeMounts: [{ name: tokenVolume.name, mountPath: '/var/run/secrets/kubernetes.io/serviceaccount', readOnly: true }]
  }] } })]);
  await until('endpoint network namespace API probe ready', () => shell(pod.metadata.name, 'api-probe', 'iptables --version', { allowFailure: true, record: false }).status === 0);
}
function apiRequest(pod, path, options = {}) {
  return shell(pod.metadata.name, 'api-probe', `curl --silent --show-error --connect-timeout 2 --max-time 5 --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt -H "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" -o /dev/null -w '%{http_code}' "https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT${path}"`, { record: false, ...options });
}
const appPath = `/apis/restic.bartl.sh/v1alpha1/namespaces/${namespace}/resticapplications/primary-restic`;
const pvcPath = `/api/v1/namespaces/${namespace}/persistentvolumeclaims/primary-data`;
function guardLogs(pod, since, previous = false) {
  return k(['logs', pod.metadata.name, '-c', 'https', `--since-time=${since}`, ...(previous ? ['--previous'] : [])], { allowFailure: true, record: false }).stdout;
}
let exclusions, isolatedPod;
function isolate(pod) {
  apply({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'endpoint-api-outage' }, spec: {
    podSelector: { matchLabels: { 'app.kubernetes.io/name': 'primary-restic' } }, policyTypes: ['Egress'],
    egress: [{ to: [{ ipBlock: { cidr: '0.0.0.0/0', except: exclusions.filter(ip => isIP(ip) === 4).map(ip => `${ip}/32`) } },
      { ipBlock: { cidr: '::/0', except: exclusions.filter(ip => isIP(ip) === 6).map(ip => `${ip}/128`) } }] }]
  } });
  // CNI policy can preserve established conntrack sessions. Reject API traffic
  // inside this network namespace too, without touching client HTTPS traffic.
  shell(pod.metadata.name, 'api-probe', exclusions.filter(ip => isIP(ip) === 4).map(ip => `iptables -I OUTPUT 1 -p tcp -d ${ip} -j REJECT`).join('; '), { record: false });
  isolatedPod = pod.metadata.name;
}
function unisolate() {
  if (isolatedPod) shell(isolatedPod, 'api-probe', exclusions.filter(ip => isIP(ip) === 4).map(ip => `while iptables -C OUTPUT -p tcp -d ${ip} -j REJECT 2>/dev/null; do iptables -D OUTPUT -p tcp -d ${ip} -j REJECT; done`).join('; '), { allowFailure: true, record: false });
  isolatedPod = undefined;
  k(['delete', 'networkpolicy', 'endpoint-api-outage', '--ignore-not-found']);
}
async function proveOutage(pod, since) {
  await until('endpoint real token API GET fails under egress isolation', () => {
    const result = apiRequest(pod, appPath, { allowFailure: true }); return result.status !== 0 && result.stdout.trim() === '000';
  }, 30000);
  assert('endpoint API egress really fails, rather than assuming NetworkPolicy enforcement', true, { excludedAddresses: exclusions });
  await until('admitted guard reports unavailable observation', () => /endpoint admission observation unavailable; retaining admitted process/.test(guardLogs(pod, since)), 90000);
  assert('actual guard retains previously admitted process on unavailable observation', true);
}
async function backupRestore(tag) {
  const hashes = 'sha256sum payload; if test -f outage-new; then sha256sum outage-new; fi';
  const before = shell('primary-client', 'restic', `cd /fixture; ${hashes}`, { record: false }).stdout.trim();
  const output = restic('writer', `backup /fixture --tag ${tag} --json`, { timeout: 600000 }).stdout.trim().split('\n').map(line => JSON.parse(line));
  const snapshot = output.find(line => line.message_type === 'summary')?.snapshot_id;
  assert(`${tag} creates a real new native snapshot`, /^[a-f0-9]{8,64}$/.test(snapshot || ''));
  restic('reader', `--no-cache restore ${snapshot} --target /restore-${tag}`, { timeout: 600000 });
  const actual = shell('primary-client', 'restic', `cd /restore-${tag}/fixture; ${hashes}`, { record: false }).stdout.trim();
  assert(`${tag} restores every fixture file with matching SHA256`, actual === before, { hashes: actual, snapshot });
  return { sha256: actual.split(/\s/)[0], snapshot };
}
let owned = false;
try {
  const versions = JSON.parse(command('kubectl', ['version', '-o', 'json']).stdout);
  evidence.environment.kubernetesClient = versions.clientVersion?.gitVersion; evidence.environment.kubernetesServer = versions.serverVersion?.gitVersion;
  evidence.environment.helm = command('helm', ['version', '--short']).stdout.trim();
  k(['create', 'namespace', namespace]); owned = true; evidence.namespaceCleanup = 'retained-after-failure';
  const clusterGet = (kind, args = []) => JSON.parse(command('kubectl', ['get', kind, ...args, '-o', 'json']).stdout);
  const service = clusterGet('service', ['kubernetes', '-n', 'default']);
  const slices = clusterGet('endpointslices', ['-n', 'default', '-l', 'kubernetes.io/service-name=kubernetes']);
  exclusions = [...new Set([...(service.spec.clusterIPs || [service.spec.clusterIP]), ...slices.items.flatMap(slice => slice.endpoints.flatMap(endpoint => endpoint.addresses)),
    ...clusterGet('nodes').items.flatMap(node => node.status.addresses.map(address => address.address))].filter(address => isIP(address)))];
  assert('API Service, actual EndpointSlices and node addresses discovered for all-protocol exclusion', slices.items.length > 0 && exclusions.length > 0, { addresses: exclusions });
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Disposable Observation CA', '-keyout', join(privateDir, 'ca.key'), '-out', join(privateDir, 'ca.crt')], { record: false });
  command('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${host('primary')}`, '-keyout', join(privateDir, 'tls.key'), '-out', join(privateDir, 'tls.csr')], { record: false });
  writeFileSync(join(privateDir, 'tls.ext'), `subjectAltName=DNS:${host('primary')}\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
  command('openssl', ['x509', '-req', '-in', join(privateDir, 'tls.csr'), '-CA', join(privateDir, 'ca.crt'), '-CAkey', join(privateDir, 'ca.key'), '-CAcreateserial', '-days', '2', '-extfile', join(privateDir, 'tls.ext'), '-out', join(privateDir, 'tls.crt')], { record: false });
  const secret = (name, stringData, type = 'Opaque') => apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name }, type, stringData });
  const password = randomBytes(32).toString('hex'); sensitive.push(password);
  const auth = [];
  for (const role of ['reader', 'writer', 'admin']) {
    const restPassword = randomBytes(24).toString('hex'); sensitive.push(restPassword, Buffer.from(`${role}:${restPassword}`).toString('base64'));
    auth.push(`${role}:${command('openssl', ['passwd', '-apr1', '-stdin'], { input: `${restPassword}\n`, record: false }).stdout.trim()}`);
    secret(`primary-${role}`, { username: role, restPassword, password, 'ca.crt': readFileSync(join(privateDir, 'ca.crt'), 'utf8') });
  }
  secret('primary-auth', { htpasswd: auth.join('\n') + '\n' }); secret('primary-key', { password });
  secret('primary-tls', { 'tls.crt': readFileSync(join(privateDir, 'tls.crt'), 'utf8'), 'tls.key': readFileSync(join(privateDir, 'tls.key'), 'utf8') }, 'kubernetes.io/tls');
  apply({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'primary-data' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '3Gi' } } } });
  const values = { image: process.env.BARTL_RESTIC_IMAGE, existingClaim: 'primary-data', tlsSecret: 'primary-tls', repositories: [{ name: 'alpha', authSecret: 'primary-auth', passwordSecret: 'primary-key' }] };
  const valuesPath = join(privateDir, 'values.json'); writeFileSync(valuesPath, JSON.stringify(values), { mode: 0o600 });
  command('helm', ['upgrade', '--install', 'primary', join(root, 'chart'), '--namespace', namespace, '-f', valuesPath, '--wait=legacy', '--timeout', '5m'], { timeout: 330000 });
  await state('Ready');
  const volumeMounts = ['reader', 'writer', 'admin'].map(role => ({ name: role, mountPath: `/credentials/${role}`, readOnly: true }));
  apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'primary-client' }, spec: { automountServiceAccountToken: false, restartPolicy: 'Never',
    containers: [{ name: 'restic', image: 'docker.io/restic/restic:0.19.1', command: ['/bin/sh', '-ec', 'while :; do sleep 3600; done'], volumeMounts },
      { name: 'curl', image: 'docker.io/curlimages/curl:8.12.1', command: ['/bin/sh', '-ec', 'while :; do sleep 3600; done'], volumeMounts }],
    volumes: ['reader', 'writer', 'admin'].map(role => ({ name: role, secret: { secretName: `primary-${role}`, defaultMode: 0o444 } })) } });
  k(['wait', '--for=condition=Ready', 'pod/primary-client', '--timeout=5m'], { timeout: 330000 });
  shell('primary-client', 'restic', 'mkdir -p /fixture; dd if=/dev/urandom of=/fixture/payload bs=1048576 count=64', { timeout: 180000 });
  const seed = await backupRestore('baseline'); evidence.payloadSHA256 = seed.sha256;
  evidence.environment.restic = restic('reader', 'version').stdout.trim();
  let pod = await endpoint(); await addProbe(pod);
  evidence.environment.endpointImages.push(...pod.spec.containers.map(container => ({ endpoint: 'primary', name: container.name, image: container.image })));
  for (const [label, path, expected] of [
    ['named application', appPath, '200'], ['named PVC', pvcPath, '200'],
    ['Secret read', `/api/v1/namespaces/${namespace}/secrets/primary-key`, '403'],
    ['application list', `/apis/restic.bartl.sh/v1alpha1/namespaces/${namespace}/resticapplications`, '403'],
    ['PVC list', `/api/v1/namespaces/${namespace}/persistentvolumeclaims`, '403'],
    ['other PVC', `/api/v1/namespaces/${namespace}/persistentvolumeclaims/not-the-owned-claim`, '403']
  ]) assert(`actual endpoint worker token ${label}: HTTP ${expected}`, apiRequest(pod, path).stdout.trim() === expected);

  await stopController();
  try {
    const before = get('pod', pod.metadata.name, { record: false });
    assert('baseline HTTPS container has zero restarts', before.status.containerStatuses.find(status => status.name === 'https').restartCount === 0);
    const since = new Date().toISOString(); isolate(pod); await proveOutage(pod, since);
    await accessible();
    shell('primary-client', 'restic', 'dd if=/dev/urandom of=/fixture/outage-new bs=1048576 count=1');
    await backupRestore('api-outage');
    const after = get('pod', pod.metadata.name, { record: false });
    assert('same endpoint Pod and every container restart count remain unchanged through API outage', after.metadata.uid === before.metadata.uid && after.status.containerStatuses.every(status => status.restartCount === 0));
    unisolate(); await until('guard observes API recovery', () => /observation verified again/.test(guardLogs(pod, since))); await accessible();
  } finally { unisolate(); await startController(); }

  await state('Ready'); pod = await endpoint();
  await stopController();
  try {
    const admitted = app(); const since = new Date().toISOString(); isolate(pod); await proveOutage(pod, since);
    k(['delete', 'pod', pod.metadata.name, '--wait=true', '--timeout=2m']);
    pod = await until('replacement endpoint runs under preexisting isolation', () => endpointPods().find(candidate => candidate.metadata.uid !== pod.metadata.uid && candidate.status.phase === 'Running'), 300000);
    await until('new HTTPS process reports actual admission observation error', () => /(?:context deadline exceeded|Client.Timeout|i\/o timeout|connect:|admission observation unavailable)/.test(guardLogs(pod, since) + guardLogs(pod, since, true)), 120000);
    assert('old successful CR admission is preserved during replacement isolation', app().status.operation?.result === admitted.status.operation?.result && admitted.status.operation?.result === 'Succeeded');
    for (let attempt = 0; attempt < 5; attempt++) {
      assert('fresh Pod has no direct client HTTPS before fresh positive observation', request(pod, { allowFailure: true }).status !== 0);
      await sleep(1000);
    }
    const blocked = get('pod', pod.metadata.name, { record: false });
    assert('replacement HTTPS has not become Ready while API unavailable', !blocked.status.containerStatuses.find(status => status.name === 'https')?.ready);
    unisolate(); await accessible(); await addProbe(await endpoint());
    assert('fresh process starts successfully after observation connectivity restored', true);
  } finally { unisolate(); await startController(); }

  await state('Ready'); pod = await endpoint();
  await stopController();
  try {
    const uid = app().metadata.uid; const since = new Date().toISOString(); isolate(pod); await proveOutage(pod, since);
    k(['annotate', 'pvc', 'primary-data', 'restic.bartl.sh/application-uid-']);
    for (let attempt = 0; attempt < 5; attempt++) { assert('unobservable ownership revocation does not stop admitted endpoint', request(pod, { allowFailure: true }).status === 0); await sleep(1000); }
    unisolate();
    await until('confirmed ownership revocation shuts down HTTPS guard', () => /current PVC ownership refuses work/.test(guardLogs(pod, since) + guardLogs(pod, since, true)), 120000);
    await until('confirmed revocation refuses new direct client requests', () => request(pod, { allowFailure: true }).status !== 0);
    assert('observed ownership revocation refuses new HTTPS requests without controller intervention', true);
    k(['annotate', 'pvc', 'primary-data', `restic.bartl.sh/application-uid=${uid}`, '--overwrite']);
    await accessible();
    assert('correct ownership permits fresh guard startup and client recovery', true);
  } finally { unisolate(); await startController(); }
  await state('Ready');
  await qualifyDrain({ k, get, shell, assert, until, namespace, name: 'primary', host, stopController, startController });
  await state('Stopped');
  uninstallStoppedApplication({ command, namespace, release: 'primary' });
  k(['delete', 'namespace', namespace, '--wait=true', '--timeout=3m'], { timeout: 210000 }); evidence.namespaceCleanup = 'deleted'; evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.failure = redact(error.stack || error); evidence.failureSummary = failureReason(error); process.exitCode = 1;
  if (owned) {
    k(['get', 'resticapplications,pods,jobs,deployments,pvc,networkpolicies,endpointslices', '-o', 'json'], { allowFailure: true });
    k(['get', 'events', '--sort-by=.lastTimestamp'], { allowFailure: true });
    const result = k(['get', 'pods', '-o', 'json'], { allowFailure: true, record: false });
    if (result.status === 0) for (const pod of JSON.parse(result.stdout).items) for (const container of pod.spec.containers) {
      k(['logs', pod.metadata.name, '-c', container.name, '--tail=100'], { allowFailure: true });
      k(['logs', pod.metadata.name, '-c', container.name, '--previous', '--tail=100'], { allowFailure: true });
    }
  }
} finally {
  rmSync(privateDir, { recursive: true, force: true }); evidence.finished = new Date().toISOString(); persist();
  console.log(`${evidence.status === 'passed' ? 'PASS' : 'FAIL'}: observation runtime; private diagnostics: ${join(directory, 'raw.json')}`);
  if (owned && evidence.namespaceCleanup !== 'deleted') console.log(`Retained namespace: ${namespace}; inspect private raw.json, then follow README.md supported uninstall before separate destructive namespace cleanup.`);
}
