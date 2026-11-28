export function uninstallStoppedApplication({ command, namespace, release }) {
  const name = `${release}-restic`;
  const application = JSON.parse(command('kubectl', ['--namespace', namespace, 'get', 'resticapplication', name, '-o', 'json']).stdout);
  const generation = application.metadata?.generation;
  const stopped = application.status?.conditions?.find(condition => condition.type === 'Stopped');
  if (generation === undefined || application.spec?.running !== false || application.status?.state !== 'Stopped'
      || application.status.observedGeneration !== generation || stopped?.status !== 'True' || stopped.observedGeneration !== generation) {
    throw new Error(`${name} must acknowledge current-generation Stopped before uninstall`);
  }
  command('kubectl', ['--namespace', namespace, 'delete', 'resticapplication', name, '--wait=true', '--timeout=3m'], { timeout: 210000 });
  command('helm', ['uninstall', release, '--namespace', namespace, '--wait', '--timeout', '3m'], { timeout: 210000 });
}
