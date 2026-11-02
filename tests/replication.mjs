#!/usr/bin/env node
// Dedicated Hetzner K3s proof; never provisions infrastructure or starts local containers.
// BARTL_RESTIC_LAB=hetzner KUBECONFIG=/private/kubeconfig node tests/replication.mjs
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.BARTL_RESTIC_LAB !== 'hetzner' || !process.env.KUBECONFIG) {
  console.error('Require BARTL_RESTIC_LAB=hetzner and KUBECONFIG for a dedicated disposable Hetzner K3s cluster. No infrastructure is created.');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const namespace = `restic-copy-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const directory = process.env.BARTL_RESTIC_EVIDENCE_DIR
  ? resolve(process.env.BARTL_RESTIC_EVIDENCE_DIR, namespace)
  : mkdtempSync(join(tmpdir(), 'bartl-restic-replication-'));
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const privateDir = join(directory, 'private');
mkdirSync(privateDir, { mode: 0o700 });
const chart = join(root, 'chart');
const image = 'docker.io/restic/restic:0.19.1';
const endpoints = Object.fromEntries(['primary', 'secondary'].map(name => [name, {
  name, deployment: `${name}-restic`, host: `${name}-restic.${namespace}.svc`,
  password: randomBytes(32).toString('hex'),
  roles: Object.fromEntries(['writer', 'reader', 'admin'].map(role => [role, `p:@/$!#%+_${randomBytes(24).toString('hex')}`])),
}]));
const secrets = Object.values(endpoints).flatMap(endpoint => [endpoint.password, ...Object.values(endpoint.roles)]);
const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
const bounded = value => redact(value).slice(-24000);
const evidence = { schema: 1, started: new Date().toISOString(), namespace, image, status: 'running',
  scope: 'Two endpoints and independent PVCs in one disposable Hetzner cluster; actual CronJob controller scheduling, not a cross-provider outage',
  commands: [], assertions: [], scheduledJobs: [], hosts: Object.fromEntries(Object.entries(endpoints).map(([name, endpoint]) => [name, endpoint.host])) };
const persist = () => writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
function command(binary, args, { input, allowFailure = false, timeout = 180000, record = true } = {}) {
  const started = new Date().toISOString();
  const result = spawnSync(binary, args, { input, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const entry = { command: [binary, ...args].map(redact), started, exit: result.status, stdout: bounded(result.stdout || ''), stderr: bounded(result.stderr || ''), error: result.error?.message };
  if (record) { evidence.commands.push(entry); persist(); }
  if ((result.status !== 0 || result.error) && !allowFailure) throw new Error(`${binary} failed: ${entry.stderr || entry.error || entry.stdout}`);
  return { ...result, stdout: result.stdout || '', stderr: result.stderr || '' };
}
const kubectl = (args, options) => command('kubectl', ['--namespace', namespace, ...args], options);
const apply = object => kubectl(['apply', '-f', '-'], { input: JSON.stringify(object), record: false });
const secret = (name, data) => apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name }, type: 'Opaque', stringData: data });
function assert(name, condition, details = {}) {
  evidence.assertions.push({ name, passed: !!condition, ...details }); persist();
  if (!condition) throw new Error(`Assertion failed: ${name}`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(name, check, milliseconds = 120000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const value = check(); if (value) return value; await sleep(1500); }
  throw new Error(`Timed out: ${name}`);
}
const exec = (pod, script, options) => kubectl(['exec', pod, '--', '/bin/sh', '-ec', script], options);
function resticScript(endpoint, role, operation) {
  return `export RESTIC_REPOSITORY='rest:https://${endpoints[endpoint].host}/alpha/' RESTIC_PASSWORD_FILE=/credentials/${role}/password; export RESTIC_REST_USERNAME="$(cat /credentials/${role}/username)" RESTIC_REST_PASSWORD="$(cat /credentials/${role}/restPassword)"; restic --cacert /credentials/${role}/ca.crt ${operation}`;
}
const restic = (endpoint, role, operation, options) => exec(`${endpoint}-client`, resticScript(endpoint, role, operation), options);
const snapshots = endpoint => JSON.parse(restic(endpoint, 'reader', 'snapshots --json').stdout);
function client(name, endpoint, roles) {
  apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name }, spec: {
    automountServiceAccountToken: false, restartPolicy: 'Never', containers: [{ name: 'restic', image,
      command: ['/bin/sh', '-ec', 'while :; do sleep 3600; done'],
      volumeMounts: roles.map(role => ({ name: role, mountPath: `/credentials/${role}`, readOnly: true })) }],
    volumes: roles.map(role => ({ name: role, secret: { secretName: `${endpoint}-${role}`, defaultMode: 0o400 } })),
  } });
  kubectl(['wait', '--for=condition=Ready', `pod/${name}`, '--timeout=5m'], { timeout: 330000 });
}
const cronName = 'primary-restic-copy-alpha';
let cronUID;
const jobs = () => JSON.parse(kubectl(['get', 'jobs', '-l', 'bartl-restic/replication=alpha', '-o', 'json'], { record: false }).stdout).items;
const jobUIDs = () => new Set(jobs().map(job => job.metadata.uid));
async function scheduledJob(phase, previous, expected, pattern) {
  const job = await until(`controller-scheduled ${phase}`, () => {
    const candidates = jobs().filter(job => !previous.has(job.metadata.uid) && job.metadata.ownerReferences?.some(owner => owner.uid === cronUID && owner.kind === 'CronJob'));
    return candidates.sort((a, b) => a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp))
      .find(job => job.status?.conditions?.some(condition => condition.status === 'True' && ['Complete', 'Failed'].includes(condition.type)));
  }, 240000);
  const logs = kubectl(['logs', `job/${job.metadata.name}`]).stdout;
  const pods = JSON.parse(kubectl(['get', 'pods', '-l', `job-name=${job.metadata.name}`, '-o', 'json']).stdout).items;
  const exits = pods.flatMap(pod => (pod.status.containerStatuses || []).map(container => ({ pod: pod.metadata.name, uid: pod.metadata.uid, container: container.name, ...container.state.terminated })));
  const result = { phase, name: job.metadata.name, uid: job.metadata.uid, cronUID,
    scheduledTimestamp: job.metadata.annotations?.['batch.kubernetes.io/cronjob-scheduled-timestamp'],
    created: job.metadata.creationTimestamp, startTime: job.status.startTime, completionTime: job.status.completionTime,
    conditions: job.status.conditions, succeeded: job.status.succeeded || 0, failed: job.status.failed || 0, exits, logs: bounded(logs) };
  evidence.scheduledJobs.push(result); persist();
  assert(`${phase}: real scheduled Job and Pod identities`, !!result.scheduledTimestamp && !!result.startTime && exits.length > 0 && exits.every(exit => !!exit.finishedAt), result);
  assert(`${phase}: ${expected}`, expected === 'complete'
    ? result.succeeded === 1 && exits.every(exit => exit.exitCode === 0)
    : result.failed >= 1 && exits.some(exit => exit.exitCode !== 0) && (!pattern || pattern.test(logs)), { job: result.name, exits, logs: bounded(logs) });
  return result;
}
async function idle() {
  await until('all copy jobs finished', () => !jobs().some(job => job.status?.active), 240000);
}
function suspend(value) {
  kubectl(['patch', 'cronjob', cronName, '--type=merge', '-p', JSON.stringify({ spec: { suspend: value } })]);
}
function correlate(source, destination, name) {
  assert(name, source.length === 2 && destination.length === 2 && source.every(point => destination.some(copy => copy.original === (point.original || point.id) && copy.tree === point.tree && copy.time === point.time)), { source, destination });
}
async function maintenanceConflict(endpoint) {
  // A rate-limited real full check holds its native exclusive lock across a schedule tick.
  // SIGINT lets Restic remove its own lock; no synthetic lock or unlock operation is used.
  await idle();
  const script = resticScript(endpoint, 'admin', '--no-cache --limit-download 32 check --read-data');
  exec(`${endpoint}-client`, `(${script.replace('; restic ', '; exec restic ')}) >/tmp/check.log 2>&1 & echo $! >/tmp/check.pid`);
  const locks = await until(`${endpoint} full check native lock`, () => {
    exec(`${endpoint}-client`, 'kill -0 "$(cat /tmp/check.pid)"');
    return restic(endpoint, 'reader', 'list locks', { record: false }).stdout.trim();
  });
  assert(`${endpoint} real full check holds native lock`, true, { operation: 'check --read-data --no-cache --limit-download 32', locks: locks.split(/\s+/) });
  const previous = jobUIDs();
  try {
    const result = await scheduledJob(`${endpoint} exclusive maintenance blocks copy`, previous, 'failed', /lock|locked/i);
    assert(`${endpoint} copy reports native lock failure`, result.exits.some(exit => exit.exitCode === 11), { exits: result.exits });
  } finally {
    exec(`${endpoint}-client`, 'kill -INT "$(cat /tmp/check.pid)"', { allowFailure: true });
    await until(`${endpoint} check releases native lock`, () => restic(endpoint, 'reader', 'list locks', { record: false }).stdout.trim() === '');
    exec(`${endpoint}-client`, 'cat /tmp/check.log');
  }
}
let owned = false;
try {
  for (const binary of ['kubectl', 'helm', 'openssl']) command(binary, binary === 'kubectl' ? ['version', '--client=true', '-o', 'json'] : binary === 'helm' ? ['version', '--short'] : ['version']);
  // No inspection or mutation of any other namespace or cluster-scoped resource.
  kubectl(['create', 'namespace', namespace]); owned = true;
  const caKey = join(privateDir, 'ca.key'), ca = join(privateDir, 'ca.crt');
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Disposable Replication Proof CA', '-keyout', caKey, '-out', ca]);
  const caText = readFileSync(ca, 'utf8');
  for (const endpoint of Object.values(endpoints)) {
    const key = join(privateDir, `${endpoint.name}.key`), csr = join(privateDir, `${endpoint.name}.csr`), cert = join(privateDir, `${endpoint.name}.crt`), extensions = join(privateDir, `${endpoint.name}.ext`);
    command('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${endpoint.host}`, '-keyout', key, '-out', csr]);
    writeFileSync(extensions, `subjectAltName=DNS:${endpoint.host}\nextendedKeyUsage=serverAuth\n`);
    command('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '2', '-extfile', extensions, '-out', cert]);
    const htpasswd = Object.entries(endpoint.roles).map(([role, password]) => `${role}:${command('openssl', ['passwd', '-apr1', '-stdin'], { input: password + '\n', record: false }).stdout.trim()}`).join('\n') + '\n';
    secret(`${endpoint.name}-auth`, { htpasswd });
    for (const [role, password] of Object.entries(endpoint.roles)) secret(`${endpoint.name}-${role}`, { username: role, restPassword: password, password: endpoint.password, 'ca.crt': caText });
    secret(`${endpoint.name}-key`, { password: endpoint.password });
    apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: `${endpoint.name}-tls` }, type: 'kubernetes.io/tls', stringData: { 'tls.crt': readFileSync(cert, 'utf8'), 'tls.key': readFileSync(key, 'utf8') } });
    apply({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: `${endpoint.name}-data` }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } });
  }
  secret('source-key', { password: endpoints.primary.password });
  apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'seed' }, spec: { automountServiceAccountToken: false, restartPolicy: 'Never', containers: [{ name: 'seed', image,
    command: ['/bin/sh', '-ec', 'restic -r /primary/alpha --password-file /primary-key/password init; restic -r /secondary/alpha --password-file /secondary-key/password init --from-repo /primary/alpha --from-password-file /primary-key/password --copy-chunker-params'],
    volumeMounts: ['primary', 'secondary'].flatMap(name => [{ name: `${name}-data`, mountPath: `/${name}` }, { name: `${name}-key`, mountPath: `/${name}-key`, readOnly: true }]) }],
    volumes: ['primary', 'secondary'].flatMap(name => [{ name: `${name}-data`, persistentVolumeClaim: { claimName: `${name}-data` } }, { name: `${name}-key`, secret: { secretName: `${name}-key` } }]) } });
  await until('explicit independent initialization', () => {
    const pod = JSON.parse(kubectl(['get', 'pod', 'seed', '-o', 'json'], { record: false }).stdout);
    if (pod.status.phase === 'Failed') throw new Error('Seed failed; inspect seed logs');
    return pod.status.phase === 'Succeeded';
  }, 300000);
  kubectl(['logs', 'seed']);
  kubectl(['delete', 'pod', 'seed', '--wait=true']);
  evidence.pvcs = JSON.parse(kubectl(['get', 'pvc', '-o', 'json']).stdout).items.map(pvc => ({ name: pvc.metadata.name, uid: pvc.metadata.uid, volumeName: pvc.spec.volumeName }));
  assert('independent primary and secondary volumes', evidence.pvcs.length === 2 && new Set(evidence.pvcs.map(pvc => pvc.volumeName)).size === 2);
  for (const name of ['secondary', 'primary']) {
    const values = { existingClaim: `${name}-data`, tlsSecret: `${name}-tls`, repositories: [{ name: 'alpha', authSecret: `${name}-auth` }] };
    if (name === 'primary') values.replication = [{ name: 'alpha', repository: 'alpha', sourceCredentialsSecret: 'source-key', destination: { host: endpoints.secondary.host, repository: 'alpha', credentialsSecret: 'secondary-writer' }, schedule: '* * * * *' }];
    const valuesFile = join(directory, `${name}-values.json`);
    writeFileSync(valuesFile, JSON.stringify(values, null, 2) + '\n');
    const args = [name, chart, '--namespace', namespace, '-f', valuesFile];
    writeFileSync(join(directory, `${name}-rendered.yaml`), command('helm', ['template', ...args]).stdout);
    command('helm', ['upgrade', '--install', ...args, '--wait', '--timeout', '5m'], { timeout: 330000 });
    client(`${name}-client`, name, ['writer', 'reader', 'admin']);
    await until(`${name} authenticated TLS access`, () => restic(name, 'reader', 'cat config', { allowFailure: true, record: false }).status === 0);
  }
  const configs = Object.fromEntries(['primary', 'secondary'].map(name => [name, JSON.parse(restic(name, 'reader', 'cat config').stdout)]));
  assert('separate repository identities and shared chunker parameters', configs.primary.id !== configs.secondary.id && configs.primary.chunker_polynomial === configs.secondary.chunker_polynomial, { configs });
  cronUID = JSON.parse(kubectl(['get', 'cronjob', cronName, '-o', 'json']).stdout).metadata.uid;
  exec('primary-client', 'mkdir /fixture; dd if=/dev/urandom of=/fixture/payload bs=1048576 count=16; sha256sum /fixture/payload');
  evidence.payloadSHA256 = exec('primary-client', 'sha256sum /fixture/payload').stdout.trim().split(/\s/)[0];
  restic('primary', 'writer', 'backup /fixture --host replication-proof --tag first');
  const first = snapshots('primary')[0];
  let previous = jobUIDs();
  await scheduledJob('initial copy', previous, 'complete');
  let destination = snapshots('secondary');
  assert('initial point copied with native metadata', destination.length === 1 && destination[0].original === first.id && destination[0].tree === first.tree && destination[0].time === first.time, { first, destination });
  await idle();
  const bad = `invalid-${randomBytes(16).toString('hex')}`; secrets.push(bad);
  secret('secondary-writer', { username: 'writer', restPassword: bad, password: endpoints.secondary.password, 'ca.crt': caText });
  previous = jobUIDs();
  exec('primary-client', "printf 'second recovery point\n' > /fixture/marker");
  const backup = restic('primary', 'writer', 'backup /fixture --host replication-proof --tag second');
  assert('primary backup succeeds while secondary authentication is broken', backup.status === 0, { exit: backup.status });
  const source = snapshots('primary');
  await scheduledJob('destination authentication outage', previous, 'failed', /401|unauthorized|authentication|wrong password/i);
  assert('failed destination leaves previous point usable', snapshots('secondary').map(point => point.id).join() === destination.map(point => point.id).join());
  secret('secondary-writer', { username: 'writer', restPassword: endpoints.secondary.roles.writer, password: endpoints.secondary.password, 'ca.crt': caText });
  previous = jobUIDs();
  await scheduledJob('catch-up after credential repair', previous, 'complete');
  destination = snapshots('secondary');
  correlate(source, destination, 'catch-up copies both points, preserving original, tree and time');
  const ids = destination.map(point => point.id).sort();
  previous = jobUIDs();
  await scheduledJob('idempotent repeat', previous, 'complete');
  assert('repeated scheduled copy preserves full destination IDs', JSON.stringify(snapshots('secondary').map(point => point.id).sort()) === JSON.stringify(ids), { ids });
  await maintenanceConflict('primary');
  await maintenanceConflict('secondary');
  suspend(true); await idle();
  restic('primary', 'admin', `forget ${first.id} --prune`);
  assert('primary forget-prune removes selected point only', snapshots('primary').length === 1 && !snapshots('primary').some(point => point.id === first.id));
  previous = jobUIDs(); suspend(false);
  await scheduledJob('copy after primary forget-prune', previous, 'complete');
  assert('secondary history survives primary deletion and subsequent copy', JSON.stringify(snapshots('secondary').map(point => point.id).sort()) === JSON.stringify(ids), { ids });
  const selected = destination.find(point => point.original === first.id).id;
  assert('recovery binds retained full secondary ID', /^[a-f0-9]{64}$/.test(selected), { selected, source: first.id });
  suspend(true); await idle();
  command('helm', ['uninstall', 'primary', '--namespace', namespace, '--wait', '--timeout', '3m'], { timeout: 210000 });
  kubectl(['delete', 'pod', 'primary-client', '--wait=true']);
  kubectl(['delete', 'pvc', 'primary-data', '--wait=true', '--timeout=2m'], { timeout: 150000 });
  kubectl(['delete', 'secret', 'source-key', 'primary-key', 'primary-writer', 'primary-reader', 'primary-admin', 'primary-auth', 'primary-tls']);
  const remaining = JSON.parse(kubectl(['get', 'pods,pvc,secrets,deployments,cronjobs', '-o', 'json'], { record: false }).stdout).items;
  assert('primary endpoint, PVC, source credentials and original client data removed', !remaining.some(item => item.metadata.name === 'source-key' || item.metadata.name.startsWith('primary-')), { remaining: remaining.map(item => ({ kind: item.kind, name: item.metadata.name })) });
  client('recovery', 'secondary', ['reader']);
  const recovery = JSON.parse(kubectl(['get', 'pod', 'recovery', '-o', 'json']).stdout);
  assert('new recovery client has only independent secondary reader Secret', recovery.spec.volumes.filter(volume => volume.secret).length === 1 && recovery.spec.volumes.find(volume => volume.secret)?.secret.secretName === 'secondary-reader');
  exec('recovery', resticScript('secondary', 'reader', `--no-cache restore ${selected} --target /restore`));
  const actual = exec('recovery', 'sha256sum /restore/fixture/payload; test ! -e /restore/fixture/marker').stdout.trim().split(/\s/)[0];
  assert('direct cache-disabled retained-point restore matches original SHA256 after primary loss', actual === evidence.payloadSHA256, { selected, expectedSHA256: evidence.payloadSHA256, actualSHA256: actual, firstPointMarkerAbsent: true });
  restic('secondary', 'admin', '--no-cache check --read-data', { timeout: 300000 });
  assert('full secondary data check passes via separate admin access', true);
  evidence.status = 'passed';
  if (process.env.BARTL_RESTIC_KEEP_NAMESPACE !== '1') {
    kubectl(['delete', 'namespace', namespace, '--wait=true', '--timeout=3m'], { timeout: 210000 });
    evidence.cleanup = 'owned namespace deleted';
  } else evidence.cleanup = `retained by request; kubectl --namespace ${namespace} delete namespace ${namespace}`;
} catch (error) {
  evidence.status = 'failed'; evidence.failure = bounded(error.stack || error);
  if (owned) {
    for (const args of [['get', 'pods,deployments,pvc,cronjobs,jobs', '-o', 'wide'], ['describe', 'pods'], ['get', 'events', '--sort-by=.lastTimestamp']]) kubectl(args, { allowFailure: true });
    const pods = kubectl(['get', 'pods', '-o', 'json'], { allowFailure: true, record: false });
    if (pods.status === 0) for (const pod of JSON.parse(pods.stdout).items) for (const container of [...(pod.spec.initContainers || []), ...pod.spec.containers]) kubectl(['logs', pod.metadata.name, '-c', container.name, '--tail=100'], { allowFailure: true });
    for (const endpoint of ['primary', 'secondary']) exec(`${endpoint}-client`, 'test ! -f /tmp/check.log || cat /tmp/check.log', { allowFailure: true });
  }
  evidence.cleanup = `failure retained diagnostics and namespace; inspect evidence, then kubectl --namespace ${namespace} delete namespace ${namespace}`;
  process.exitCode = 1;
} finally {
  rmSync(privateDir, { recursive: true, force: true });
  evidence.finished = new Date().toISOString(); persist();
  console.log(JSON.stringify({ status: evidence.status, namespace, evidence: join(directory, 'evidence.json'), cleanup: evidence.cleanup, failure: evidence.failure }, null, 2));
}
