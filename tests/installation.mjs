// The documented native precreation sequence, shared by live qualification runners.
export function precreateApplication({command, chart, release, namespace, valuesFile, running = true}) {
  const crdName = 'resticapplications.restic.bartl.sh';
  const installed = command('kubectl', ['get', 'crd', crdName, '--ignore-not-found', '-o', 'json']).stdout.trim();
  if (installed) {
    const crd = JSON.parse(installed);
    if (!crd.spec.versions.some(version => version.name === 'v1alpha2' && version.served && version.storage)) {
      throw new Error('Existing Restic CRD is incompatible; use an independent target cluster, not API adoption');
    }
  } else {
    const crds = command('helm', ['show', 'crds', chart]).stdout;
    command('kubectl', ['create', '-f', '-'], {input: crds});
  }
  command('kubectl', ['wait', `crd/${crdName}`, '--for=condition=Established', '--timeout=60s']);
  const rendered = command('helm', ['template', release, chart, '--namespace', namespace, '-f', valuesFile,
    '--show-only', 'templates/application.yaml']).stdout;
  const application = JSON.parse(command('yq', ['-o=json', '.'], {input: rendered}).stdout);
  application.metadata.namespace = namespace;
  application.metadata.labels = {...application.metadata.labels, 'app.kubernetes.io/managed-by': 'Helm'};
  application.metadata.annotations = {...application.metadata.annotations,
    'meta.helm.sh/release-name': release, 'meta.helm.sh/release-namespace': namespace};
  application.spec.running = running;
  command('kubectl', ['--namespace', namespace, 'create', '-f', '-'], {input: JSON.stringify(application)});
}
