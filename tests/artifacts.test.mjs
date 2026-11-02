import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactDirectory, snapshotSource, persistArtifacts, failureReason } from './artifacts.mjs';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'bartl-restic-artifact-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('artifact bases reject checkout paths, including nonexistent children through symlink parents', t => {
  const outside = temporary(t);
  const alias = join(outside, 'alias');
  symlinkSync(checkout, alias, 'dir');
  for (const base of [checkout, join(checkout, 'evidence', 'future'), alias, join(alias, 'not-created', 'child')]) {
    assert.throws(() => createArtifactDirectory(checkout, 'boundary', base), /outside the checkout/);
    for (const runner of ['kubernetes.mjs', 'replication.mjs']) {
      const result = spawnSync(process.execPath, [join(checkout, 'tests', runner)], {
        encoding: 'utf8', env: { ...process.env, BARTL_RESTIC_LAB: 'hetzner', KUBECONFIG: '/not-used', BARTL_RESTIC_EVIDENCE_DIR: base },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Artifact directory must be outside the checkout/);
    }
  }
});

test('default and explicit artifact directories are external, unique and private', t => {
  const outside = temporary(t);
  const directory = createArtifactDirectory(checkout, 'fixture', outside);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.notEqual(createArtifactDirectory(checkout, 'fixture', outside), directory);
  const directoryDefault = createArtifactDirectory(checkout, 'fixture', '');
  t.after(() => rmSync(directoryDefault, { recursive: true, force: true }));
  assert.ok(relative(realpathSync(checkout), realpathSync(directoryDefault)).startsWith('..'));
  assert.equal(statSync(directoryDefault).mode & 0o777, 0o700);
});

test('real writer selects a compact whitelist while redacting the private raw record', t => {
  const directory = createArtifactDirectory(checkout, 'fixture', temporary(t));
  const evidence = { started: '2026-11-02T00:00:00Z', status: 'failed', namespace: 'fixture',
    source: { head: 'a'.repeat(40), dirty: true, relevantDirty: true, files: [{ path: 'chart/values.yaml', sha256: 'b'.repeat(64), commands: 'LEAK' }] },
    environment: { kubernetesServer: 'v1.36.5+k3s1', endpointImages: [{ endpoint: 'primary', name: 'repository', image: 'pinned-image', logs: 'LEAK' }], objects: 'LEAK' },
    assertions: [{ name: 'named scenario', passed: true, logs: 'LEAK', stdout: 'LEAK', details: { commands: 'LEAK' } }],
    commands: [{ stdout: 'PRIVATE_SECRET', stderr: 'LEAK' }], scheduledJobs: [{ logs: 'LEAK' }],
    failure: 'Error: LEAK\n at stack LEAK', failureSummary: 'kubectl failed (exit 1); inspect private raw.json.', namespaceCleanup: 'retained-after-failure' };
  persistArtifacts(directory, evidence, value => value.replaceAll('PRIVATE_SECRET', '[REDACTED]'));
  const raw = readFileSync(join(directory, 'raw.json'), 'utf8');
  const compact = readFileSync(join(directory, 'qualification.json'), 'utf8');
  assert.match(raw, /\[REDACTED\]/);
  assert.ok(!raw.includes('PRIVATE_SECRET'));
  assert.ok(!compact.includes('LEAK'));
  assert.ok(!compact.includes('commands'));
  assert.ok(!compact.includes('stdout'));
  const selected = JSON.parse(compact);
  assert.deepEqual(selected.scenarios, [{ name: 'named scenario', result: 'passed' }]);
  assert.equal(selected.environment.kubernetesServer, 'v1.36.5+k3s1');
  assert.equal(selected.cleanup.namespace, 'retained-after-failure');
  assert.match(selected.cleanup.infrastructure, /not-established-by-runner/);
  assert.match(selected.cleanup.budget, /not-established-by-runner/);
  assert.equal(statSync(join(directory, 'raw.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, 'qualification.json')).mode & 0o777, 0o600);
});

test('source snapshot binds start-time HEAD, dirty state and tested working bytes', t => {
  const root = temporary(t);
  mkdirSync(join(root, 'chart')); mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'chart', 'values.yaml'), 'original chart\n');
  writeFileSync(join(root, 'tests', 'runner.mjs'), 'original runner\n');
  git(root, ['init', '-q', '-b', 'artifact-fixture']); git(root, ['add', 'chart', 'tests']);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Create fixture']);
  const clean = snapshotSource(root);
  assert.equal(clean.head, git(root, ['rev-parse', 'HEAD']));
  assert.equal(clean.dirty, false); assert.equal(clean.relevantDirty, false);
  const testedBytes = 'uncommitted tested runner\n';
  writeFileSync(join(root, 'tests', 'runner.mjs'), testedBytes);
  writeFileSync(join(root, 'tests', 'untracked.mjs'), 'untracked test\n');
  const start = snapshotSource(root);
  assert.equal(start.head, clean.head); assert.equal(start.dirty, true); assert.equal(start.relevantDirty, true);
  assert.equal(start.files.find(file => file.path === 'tests/runner.mjs').sha256, createHash('sha256').update(testedBytes).digest('hex'));
  assert.ok(start.files.some(file => file.path === 'tests/untracked.mjs'));
  writeFileSync(join(root, 'tests', 'runner.mjs'), 'later bytes\n');
  assert.notEqual(snapshotSource(root).files.find(file => file.path === 'tests/runner.mjs').sha256, start.files.find(file => file.path === 'tests/runner.mjs').sha256);
});

test('failure summaries exclude raw diagnostics while retaining scenario and exit context', () => {
  const scenario = 'selected snapshot';
  const diagnostic = 'PRIVATE_DIAGNOSTIC';
  const assertion = failureReason(new Error(`Assertion failed: ${scenario}\n at ${diagnostic}`));
  assert.ok(assertion.includes(scenario));
  assert.ok(!assertion.includes(diagnostic));
  assert.ok(!failureReason(new Error(`${diagnostic}\n at private stack`)).includes(diagnostic));
  const command = failureReason(Object.assign(new Error(diagnostic), { publicReason: 'kubectl failed (exit 11); inspect private raw.json.' }));
  assert.ok(command.includes('exit 11'));
  assert.ok(!command.includes(diagnostic));
});
