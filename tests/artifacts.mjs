import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const inside = (root, path) => {
  const part = relative(root, path);
  return part === '' || (!part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && part !== '..' && !isAbsolute(part));
};
// Resolve existing ancestors too: the selected base need not exist yet.
function canonical(path) {
  try { return realpathSync(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonical(parent), basename(path));
  }
}
function requireExternal(root, path) {
  const selected = resolve(path);
  if (inside(resolve(root), selected) || inside(realpathSync(root), canonical(selected))) {
    throw new Error('Artifact directory must be outside the checkout, including through symlinks.');
  }
  return selected;
}

export function createArtifactDirectory(root, name, base = process.env.BARTL_RESTIC_EVIDENCE_DIR) {
  let selected;
  if (base) selected = requireExternal(root, base);
  else {
    try { selected = requireExternal(root, tmpdir()); }
    catch { selected = requireExternal(root, '/tmp'); }
  }
  mkdirSync(selected, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(selected, `${name}-`));
  chmodSync(directory, 0o700);
  return directory;
}

export function snapshotSource(root) {
  function git(args) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    if (result.status !== 0 || result.error) throw new Error('Cannot establish tested source provenance before the run.');
    return result.stdout.trim();
  }
  const files = [];
  function visit(directory) {
    for (const name of readdirSync(join(root, directory)).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push({ path, sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') });
      else throw new Error(`Unsupported source entry: ${path}`);
    }
  }
  visit('chart'); visit('tests');
  return { captured: new Date().toISOString(), head: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain', '--untracked-files=all']) !== '',
    relevantDirty: git(['status', '--porcelain', '--untracked-files=all', '--', 'chart', 'tests']) !== '', files };
}

export function failureReason(error) {
  if (typeof error.publicReason === 'string') return error.publicReason;
  const message = String(error.message || '');
  if (/^(Assertion failed: |Timed out: |Repository seed failed;|Seed failed;)/.test(message)) return message.split('\n')[0];
  return 'Runner failed; inspect private raw.json for diagnostics.';
}

const text = value => typeof value === 'string' ? value : undefined;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
const version = value => typeof value === 'string' ? value.split('\n')[0].slice(0, 240) : undefined;
const namespaceStates = new Set(['not-created', 'deleted', 'retained-by-request', 'retained-after-failure']);

// Deliberate selection, never spread raw evidence or assertion details into this product.
export function qualification(evidence) {
  return {
    schema: 1, started: text(evidence.started), finished: text(evidence.finished), status: text(evidence.status),
    namespace: text(evidence.namespace), scope: text(evidence.scope),
    source: { captured: text(evidence.source?.captured), head: text(evidence.source?.head),
      dirty: evidence.source?.dirty === true, relevantDirty: evidence.source?.relevantDirty === true,
      files: (evidence.source?.files || []).map(file => ({ path: text(file.path), sha256: hash(file.sha256) })) },
    environment: { provider: 'hetzner', topology: 'one existing disposable Kubernetes cluster',
      kubernetesClient: version(evidence.environment?.kubernetesClient), kubernetesServer: version(evidence.environment?.kubernetesServer),
      helm: version(evidence.environment?.helm), openssl: version(evidence.environment?.openssl),
      restic: version(evidence.environment?.restic),
      endpointImages: (evidence.environment?.endpointImages || []).map(image => ({ endpoint: text(image.endpoint), name: text(image.name), image: text(image.image) })) },
    scenarios: (evidence.assertions || []).map(assertion => ({ name: text(assertion.name), result: assertion.passed === true ? 'passed' : 'failed' })),
    result: { payloadSHA256: hash(evidence.payloadSHA256), snapshotID: hash(evidence.snapshotID), repositoryID: hash(evidence.repositoryID),
      failure: text(evidence.failureSummary) },
    limitations: ['No actual cross-provider outage was exercised.', 'Infrastructure provisioning, provider cleanup and cost verification are outside this runner.'],
    cleanup: { namespace: namespaceStates.has(evidence.namespaceCleanup) ? evidence.namespaceCleanup : 'not-established',
      infrastructure: 'not-established-by-runner; operator verification required',
      budget: 'not-established-by-runner; operator-supplied budget and cost verification required' },
    provenance: { raw: 'raw.json', publication: 'Operator review and selection required; neither output is automatically published.' },
  };
}

export function persistArtifacts(directory, evidence, redact = String) {
  writeFileSync(join(directory, 'raw.json'), redact(JSON.stringify(evidence, null, 2)) + '\n', { mode: 0o600 });
  writeFileSync(join(directory, 'qualification.json'), redact(JSON.stringify(qualification(evidence), null, 2)) + '\n', { mode: 0o600 });
}
