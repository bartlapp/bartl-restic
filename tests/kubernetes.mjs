#!/usr/bin/env node
// Dedicated remote-cluster proof. No local containers or infrastructure provisioning.
// BARTL_RESTIC_LAB=hetzner KUBECONFIG=/private/kubeconfig node tests/kubernetes.mjs
// Optional: BARTL_RESTIC_KEEP_NAMESPACE=1, BARTL_RESTIC_EVIDENCE_DIR=/private/path.
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.BARTL_RESTIC_LAB !== 'hetzner' || !process.env.KUBECONFIG) {
  console.error('Require BARTL_RESTIC_LAB=hetzner and KUBECONFIG for a dedicated Hetzner K3s cluster. No infrastructure is created.');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const namespace = `restic-proof-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const release = 'proof';
const endpoint = `${release}-restic`;
const host = `${endpoint}.${namespace}.svc`;
const base = `https://${host}`;
const directory = process.env.BARTL_RESTIC_EVIDENCE_DIR
  ? resolve(process.env.BARTL_RESTIC_EVIDENCE_DIR, namespace)
  : mkdtempSync(join(tmpdir(), 'bartl-restic-kubernetes-'));
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const privateDir = join(directory, 'private');
mkdirSync(privateDir, { mode: 0o700 });
const evidence = { schema: 1, started: new Date().toISOString(), namespace, host, images: {
  restic: 'docker.io/restic/restic:0.19.1', curl: 'docker.io/curlimages/curl:8.12.1',
}, commands: [], assertions: [], status: 'running' };
const secrets = [];
const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
const bounded = text => redact(text).slice(-24000);
const persist = () => writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
function command(binary, args, { input, allowFailure = false, timeout = 180000, record = true } = {}) {
  const start = Date.now();
  const result = spawnSync(binary, args, { input, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const entry = { command: [binary, ...args].map(redact), exit: result.status, durationMs: Date.now() - start,
    stdout: bounded(result.stdout || ''), stderr: bounded(result.stderr || ''), error: result.error?.message };
  if (record) { evidence.commands.push(entry); persist(); }
  if ((result.status !== 0 || result.error) && !allowFailure) throw new Error(`${binary} failed: ${entry.stderr || entry.error || entry.stdout}`);
  return { ...result, stdout: result.stdout || '', stderr: result.stderr || '' };
}
const kubectl = (args, options) => command('kubectl', ['--namespace', namespace, ...args], options);
const apply = object => kubectl(['apply', '-f', '-'], { input: JSON.stringify(object), record: false });
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
const exec = (container, script, options) => kubectl(['exec', 'client', '-c', container, '--', '/bin/sh', '-ec', script], options);
const resticScript = (role, operation) => `export RESTIC_REPOSITORY='rest:${base}/alpha/' RESTIC_PASSWORD_FILE=/credentials/password RESTIC_REST_USERNAME=${role}; export RESTIC_REST_PASSWORD="$(cat /credentials/alpha-${role})"; restic --cacert /credentials/ca.crt ${operation}`;
const restic = (role, operation, options) => exec('restic', resticScript(role, operation), options);
async function waitHTTPS(phase) {
  let attempts = 0;
  await until(`authenticated HTTPS readiness after ${phase}`, () => {
    attempts++;
    const result = exec('curl', `curl --silent --show-error --fail --connect-timeout 2 --max-time 5 --head --cacert /credentials/ca.crt --netrc-file /credentials/alpha-reader.netrc -o /dev/null -w '%{http_code}' '${base}/alpha/config'`, { allowFailure: true, timeout: 12000 });
    return !result.error && result.status === 0 && result.stdout.trim() === '200';
  }, 90000);
  assert(`authenticated HTTPS ready after ${phase}`, true, { attempts, method: 'HEAD', path: '/alpha/config', status: 200 });
}
const secret = (name, data) => apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name }, type: 'Opaque', stringData: data });
const roles = ['writer', 'reader', 'admin', 'unknown'];
const credentials = { password: randomBytes(32).toString('hex') };
secrets.push(credentials.password);
for (const repo of ['alpha', 'beta']) for (const role of roles) {
  credentials[`${repo}-${role}`] = randomBytes(24).toString('hex'); secrets.push(credentials[`${repo}-${role}`]);
}
const values = { existingClaim: 'repositories', tlsSecret: 'repository-tls', repositories: [
  { name: 'alpha', authSecret: 'alpha-auth' }, { name: 'beta', authSecret: 'beta-auth' },
] };
const valuesFile = join(directory, 'values.json');
writeFileSync(valuesFile, JSON.stringify(values, null, 2));
const chart = join(root, 'chart');
const render = (extra = []) => command('helm', ['template', release, chart, '--namespace', namespace, '-f', valuesFile, ...extra]).stdout;
function maintenance(name, action = 'check', snapshot) {
  const args = ['--show-only', 'templates/maintenance.yaml', '--set', 'maintenance.enabled=true', '--set', `maintenance.name=${name}`,
    '--set', 'maintenance.repository=alpha', '--set', `maintenance.action=${action}`, '--set', `maintenance.host=${host}`,
    '--set', 'maintenance.credentialsSecret=alpha-admin'];
  if (snapshot) args.push('--set-string', `maintenance.snapshot=${snapshot}`);
  kubectl(['apply', '-f', '-'], { input: render(args) });
  return `${endpoint}-${name}`;
}
async function jobResult(name, expected) {
  const job = await until(`Job ${name} terminal state`, () => {
    const object = JSON.parse(kubectl(['get', 'job', name, '-o', 'json'], { record: false }).stdout);
    return object.status?.succeeded || object.status?.failed ? object : null;
  }, 600000);
  const logs = kubectl(['logs', `job/${name}`]).stdout;
  assert(`maintenance ${name}: ${expected}`, expected === 'complete' ? job.status.succeeded === 1 : job.status.failed === 1 && /lock|locked/i.test(logs), { logs: bounded(logs) });
}
async function waitLock(exclusive) {
  return until(`${exclusive ? 'exclusive check' : 'reader restore'} native lock`, () => {
    // `list locks` intentionally does not acquire a lock; `cat lock` would,
    // and therefore cannot inspect an exclusive holder without bypassing it.
    const output = restic('reader', 'list locks', { record: false });
    const ids = output.stdout.trim().split(/\s+/).filter(id => /^[a-f0-9]{64}$/.test(id));
    if (!ids.length) return null;
    exec('restic', 'kill -0 \"$(cat /tmp/held.pid)\"');
    assert(`observed native lock during ${exclusive ? 'admin check' : 'reader restore'}`, true, { ids, operation: exclusive ? 'check --read-data' : 'restore', exclusiveExpected: exclusive });
    return ids;
  });
}
async function stopHeld() {
  exec('restic', 'kill -INT "$(cat /tmp/held.pid)"; rm -f /tmp/held.pid');
  await until('held operation releases native lock', () => {
    const output = restic('reader', 'list locks', { record: false });
    return output.stdout.trim() === '';
  });
}
async function restoreAndCompare(snapshot, target) {
  restic('reader', `restore ${snapshot} --target ${target}`);
  const actual = exec('restic', `sha256sum ${target}/fixture/payload`).stdout.trim().split(/\s/)[0];
  assert(`byte-correct reader restore ${target}`, actual === evidence.payloadSHA256, { sha256: actual, snapshot });
}
let owned = false;
try {
  for (const binary of ['kubectl', 'helm', 'openssl']) command(binary, binary === 'kubectl' ? ['version', '--client=true', '-o', 'json'] : binary === 'helm' ? ['version', '--short'] : ['version']);
  // Deliberately do not inspect or mutate other namespaces or cluster-scoped resources.
  kubectl(['create', 'namespace', namespace]); owned = true;
  const caKey = join(privateDir, 'ca.key'), ca = join(privateDir, 'ca.crt');
  const key = join(privateDir, 'tls.key'), csr = join(privateDir, 'tls.csr'), cert = join(privateDir, 'tls.crt');
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Disposable Restic Proof CA', '-keyout', caKey, '-out', ca]);
  command('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${host}`, '-keyout', key, '-out', csr]);
  const extensions = join(privateDir, 'tls.ext');
  writeFileSync(extensions, `subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\n`);
  command('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '2', '-extfile', extensions, '-out', cert]);
  credentials['ca.crt'] = readFileSync(ca, 'utf8');
  for (const repo of ['alpha', 'beta']) {
    const htpasswd = roles.map(role => `${role}:${command('openssl', ['passwd', '-apr1', '-stdin'], { input: credentials[`${repo}-${role}`] + '\n', record: false }).stdout.trim()}`).join('\n') + '\n';
    secret(`${repo}-auth`, { htpasswd });
    for (const role of ['writer', 'reader', 'admin']) secret(`${repo}-${role}`, { username: role, restPassword: credentials[`${repo}-${role}`], password: credentials.password, 'ca.crt': credentials['ca.crt'] });
    for (const role of roles) credentials[`${repo}-${role}.netrc`] = `machine ${host} login ${role} password ${credentials[`${repo}-${role}`]}\n`;
  }
  secret('clients', credentials);
  apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'repository-tls' }, type: 'kubernetes.io/tls', stringData: { 'tls.crt': readFileSync(cert, 'utf8'), 'tls.key': readFileSync(key, 'utf8') } });
  apply({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'repositories' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '2Gi' } } } });
  apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'seed' }, spec: { automountServiceAccountToken: false, restartPolicy: 'Never', containers: [{ name: 'seed', image: evidence.images.restic,
    command: ['/bin/sh', '-ec', 'export RESTIC_PASSWORD_FILE=/credentials/password; restic -r /data/alpha init; restic -r /data/beta init'],
    volumeMounts: [{ name: 'data', mountPath: '/data' }, { name: 'credentials', mountPath: '/credentials', readOnly: true }] }],
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'repositories' } }, { name: 'credentials', secret: { secretName: 'clients' } }] } });
  await until('seed Pod completion', () => {
    const pod = JSON.parse(kubectl(['get', 'pod', 'seed', '-o', 'json'], { record: false }).stdout);
    if (pod.status.phase === 'Failed') throw new Error('Repository seed failed; inspect seed logs');
    return pod.status.phase === 'Succeeded';
  }, 300000);
  kubectl(['logs', 'seed']);
  kubectl(['delete', 'pod', 'seed', '--wait=true']);
  evidence.pvcUID = JSON.parse(kubectl(['get', 'pvc', 'repositories', '-o', 'json']).stdout).metadata.uid;
  const rendered = render(); writeFileSync(join(directory, 'endpoint-rendered.yaml'), rendered);
  command('helm', ['upgrade', '--install', release, chart, '--namespace', namespace, '-f', valuesFile, '--wait', '--timeout', '5m'], { timeout: 330000 });
  const deployed = JSON.parse(kubectl(['get', 'deployment', endpoint, '-o', 'json']).stdout);
  evidence.images.endpoint = deployed.spec.template.spec.containers.map(({ name, image }) => ({ name, image }));
  apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'client' }, spec: { automountServiceAccountToken: false, restartPolicy: 'Never',
    containers: ['restic', 'curl'].map(name => ({ name, image: evidence.images[name], command: ['/bin/sh', '-ec', 'while :; do sleep 3600; done'],
      volumeMounts: [{ name: 'credentials', mountPath: '/credentials', readOnly: true }, { name: 'work', mountPath: '/work' }], securityContext: { runAsUser: 0 } })),
    volumes: [{ name: 'credentials', secret: { secretName: 'clients', defaultMode: 0o400 } }, { name: 'work', emptyDir: {} }] } });
  kubectl(['wait', '--for=condition=Ready', 'pod/client', '--timeout=5m'], { timeout: 330000 });
  await waitHTTPS('initial deployment');
  restic('reader', 'version');
  const payload = 'disposable permission probe\n';
  const objectID = createHash('sha256').update(payload).digest('hex');
  exec('curl', `printf 'disposable permission probe\\n' > /work/body`);
  function probe(name, role, method, path, expected, repo = 'alpha') {
    const output = exec('curl', `curl --silent --show-error --max-time 60 --path-as-is --cacert /credentials/ca.crt --netrc-file /credentials/${repo}-${role}.netrc ${method === 'HEAD' ? '--head' : `-X ${method}`} ${method === 'POST' ? '--data-binary @/work/body' : ''} -o /work/response -w '%{http_code}' '${base}${path}'`).stdout.trim();
    assert(name, expected.includes(Number(output)), { method, path, status: Number(output), expected });
  }
  for (const role of ['reader', 'writer', 'admin']) {
    probe(`${role} GET config`, role, 'GET', '/alpha/config', [200]);
    probe(`${role} HEAD config`, role, 'HEAD', '/alpha/config', [200]);
    probe(`${role} native lock POST`, role, 'POST', `/alpha/locks/${objectID}`, [200]);
    probe(`${role} native lock DELETE`, role, 'DELETE', `/alpha/locks/${objectID}`, [200]);
  }
  for (const path of [`/alpha/data/${objectID}`, `/alpha/snapshots/${objectID}`, `/alpha/index/${objectID}`, `/alpha/keys/${objectID}`, '/alpha/config', '/alpha/', '/alpha/locks/invalid', `/alpha/locks/${objectID}/extra`]) {
    probe(`reader cannot POST ${path}`, 'reader', 'POST', path, [403]);
    probe(`reader cannot DELETE ${path}`, 'reader', 'DELETE', path, [403]);
  }
  for (const path of [`/alpha/data/${objectID}`, `/alpha/snapshots/${objectID}`, '/alpha/config']) probe(`writer cannot delete ${path}`, 'writer', 'DELETE', path, [403]);
  probe('writer creates disposable data', 'writer', 'POST', `/alpha/data/${objectID}`, [200]);
  probe('writer cannot overwrite data', 'writer', 'POST', `/alpha/data/${objectID}`, [403]);
  probe('admin removes disposable data', 'admin', 'DELETE', `/alpha/data/${objectID}`, [200]);
  probe('authenticated unknown user denied', 'unknown', 'GET', '/alpha/config', [403]);
  probe('undeclared repository denied', 'reader', 'GET', '/undeclared/config', [404]);
  probe('alpha credentials denied at beta', 'reader', 'GET', '/beta/config', [401]);
  probe('beta credentials denied at alpha', 'reader', 'GET', '/alpha/config', [401], 'beta');
  for (const path of ['/alpha/../beta/config', '/alpha/%2e%2e/beta/config', '/alpha//../beta/config', '/alpha/%2f..%2fbeta/config']) probe(`normalized cross-repo path denied ${path}`, 'reader', 'GET', path, [400, 401, 403, 404]);
  for (const path of [`/alpha/locks/../data/${objectID}`, `/alpha/locks/%2e%2e/data/${objectID}`, `/alpha/locks/${objectID}%2f..%2f../config`]) probe(`normalized write denied ${path}`, 'reader', 'POST', path, [400, 403, 404]);
  exec('restic', 'mkdir /fixture; dd if=/dev/urandom of=/fixture/payload bs=1048576 count=32; sha256sum /fixture/payload');
  evidence.payloadSHA256 = exec('restic', 'sha256sum /fixture/payload').stdout.trim().split(/\s/)[0];
  restic('writer', 'backup /fixture --host kubernetes-proof --tag retained');
  const snapshots = () => JSON.parse(restic('reader', 'snapshots --json').stdout);
  evidence.snapshotID = snapshots()[0].id;
  assert('full snapshot identifier', /^[a-f0-9]{64}$/.test(evidence.snapshotID));
  evidence.repositoryID = JSON.parse(restic('reader', 'cat config').stdout).id;
  await restoreAndCompare(evidence.snapshotID, '/restore-before');
  // Force a real shared-lock interval without synthetic locks or --no-lock.
  exec('restic', `${resticScript('reader', `--limit-download 64 restore ${evidence.snapshotID} --target /held-restore --no-cache`)} >/tmp/held.log 2>&1 & echo $! >/tmp/held.pid`);
  await waitLock(false);
  await jobResult(maintenance('blocked-by-reader'), 'locked');
  await stopHeld();
  exec('restic', `${resticScript('admin', '--limit-download 64 check --read-data --no-cache')} >/tmp/held.log 2>&1 & echo $! >/tmp/held.pid`);
  await waitLock(true);
  for (const [role, operation] of [['reader', `restore ${evidence.snapshotID} --target /blocked-restore`], ['writer', 'backup /fixture --host blocked-writer']]) {
    const result = restic(role, operation, { allowFailure: true });
    assert(`${role} rejects exclusive maintenance lock`, result.status === 11 && /lock/i.test(result.stderr), { exit: result.status, stderr: bounded(result.stderr) });
  }
  await stopHeld();
  await jobResult(maintenance('full-check'), 'complete');
  exec('restic', "printf 'disposable selected point\\n' > /fixture/marker");
  restic('writer', 'backup /fixture --host kubernetes-proof --tag disposable');
  const disposable = snapshots().find(point => point.tags?.includes('disposable'))?.id;
  assert('distinct disposable full point selected', /^[a-f0-9]{64}$/.test(disposable || '') && disposable !== evidence.snapshotID, { snapshot: disposable });
  await jobResult(maintenance('selected-forget', 'forget-prune', disposable), 'complete');
  const remaining = snapshots().map(point => point.id);
  assert('forget-prune removes only selected recovery point', !remaining.includes(disposable) && remaining.includes(evidence.snapshotID), { remaining });
  kubectl(['delete', 'deployment', endpoint, '--wait=true']);
  command('helm', ['upgrade', release, chart, '--namespace', namespace, '-f', valuesFile, '--wait', '--timeout', '5m'], { timeout: 330000 });
  kubectl(['rollout', 'status', `deployment/${endpoint}`, '--timeout=5m'], { timeout: 330000 });
  await waitHTTPS('Deployment replacement');
  const pvcAfter = JSON.parse(kubectl(['get', 'pvc', 'repositories', '-o', 'json']).stdout).metadata.uid;
  const repoAfter = JSON.parse(restic('reader', 'cat config').stdout).id;
  assert('replacement preserves PVC UID, repository identity and snapshot', pvcAfter === evidence.pvcUID && repoAfter === evidence.repositoryID && snapshots().some(point => point.id === evidence.snapshotID), { pvcUID: pvcAfter, repositoryID: repoAfter, snapshotID: evidence.snapshotID });
  await restoreAndCompare(evidence.snapshotID, '/restore-after');
  const missingValues = { ...values, repositories: [...values.repositories, { name: 'missing', authSecret: 'alpha-auth' }] };
  const missingFile = join(directory, 'missing-values.json'); writeFileSync(missingFile, JSON.stringify(missingValues));
  command('helm', ['upgrade', release, chart, '--namespace', namespace, '-f', missingFile]);
  const failed = await until('missing repository rejected by startup init container', () => {
    const pods = JSON.parse(kubectl(['get', 'pods', '-l', `app.kubernetes.io/name=${endpoint}`, '-o', 'json'], { record: false }).stdout);
    for (const pod of pods.items) {
      const init = pod.status.initContainerStatuses?.find(item => item.name === 'require-initialized-repositories');
      if (init?.state?.terminated?.exitCode || init?.lastState?.terminated?.exitCode) return pod;
    }
    return null;
  });
  const startupLogs = kubectl(['logs', failed.metadata.name, '-c', 'require-initialized-repositories']).stdout;
  assert('missing repository fails visibly without implicit initialization', /Repository missing is missing its config/.test(startupLogs) && failed.spec.initContainers[0].volumeMounts.find(mount => mount.mountPath === '/data')?.readOnly === true, { logs: bounded(startupLogs), initReadOnly: true });
  command('helm', ['upgrade', release, chart, '--namespace', namespace, '-f', valuesFile, '--wait', '--timeout', '5m'], { timeout: 330000 });
  await waitHTTPS('original startup values restored');
  kubectl(['exec', `deployment/${endpoint}`, '-c', 'repository', '--', '/bin/sh', '-ec', 'test ! -e /data/missing/config']);
  assert('missing repository was not initialized on PVC', true);
  assert('startup failure preserves existing repository and point', JSON.parse(restic('reader', 'cat config').stdout).id === evidence.repositoryID && snapshots().some(point => point.id === evidence.snapshotID));
  await restoreAndCompare(evidence.snapshotID, '/restore-resumed');
  evidence.status = 'passed';
  if (process.env.BARTL_RESTIC_KEEP_NAMESPACE !== '1') {
    kubectl(['delete', 'namespace', namespace, '--wait=true', '--timeout=3m'], { timeout: 210000 });
    evidence.cleanup = 'owned namespace deleted';
  } else evidence.cleanup = `retained by request; kubectl --namespace ${namespace} delete namespace ${namespace}`;
} catch (error) {
  evidence.status = 'failed'; evidence.failure = bounded(error.stack || error);
  if (owned) {
    for (const args of [['get', 'pods,deployments,pvc,jobs', '-o', 'wide'], ['describe', 'pods'], ['get', 'events', '--sort-by=.lastTimestamp']]) kubectl(args, { allowFailure: true });
    const pods = kubectl(['get', 'pods', '-o', 'json'], { allowFailure: true, record: false });
    if (pods.status === 0) for (const pod of JSON.parse(pods.stdout).items) for (const container of [...(pod.spec.initContainers || []), ...pod.spec.containers]) {
      kubectl(['logs', pod.metadata.name, '-c', container.name, '--tail=100'], { allowFailure: true });
    }
    exec('restic', 'test ! -f /tmp/held.log || tail -c 16000 /tmp/held.log', { allowFailure: true });
  }
  evidence.cleanup = `failure retained diagnostics and namespace; inspect evidence, then kubectl --namespace ${namespace} delete namespace ${namespace}`;
  process.exitCode = 1;
} finally {
  rmSync(privateDir, { recursive: true, force: true });
  evidence.finished = new Date().toISOString(); persist();
  console.log(JSON.stringify({ status: evidence.status, namespace, evidence: join(directory, 'evidence.json'), cleanup: evidence.cleanup, failure: evidence.failure }, null, 2));
}
