// Uses the existing observation fixture and its external artifact helpers only.
// stopController/startController must await controller suspension/restoration.
export async function qualifyDrain({ k, get, shell, assert, until, namespace, name = 'primary', host, stopController, startController }) {
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const application = `${name}-restic`;
  const client = `${name}-client`;
  const hostname = host(name);
  const directory = `/tmp/endpoint-drain-${Date.now()}`;
  const pods = get('pods', null, { record: false }).items;
  const pod = pods.find(object => object.metadata.labels?.['app.kubernetes.io/name'] === application &&
    !object.metadata.deletionTimestamp && object.status.containerStatuses?.some(container => container.name === 'https' && container.ready));
  assert('drain fixture has a ready native nginx endpoint', !!pod && !!pod.status.podIP, { namespace });
  const ip = pod.status.podIP;
  const initialRestarts = pod.status.containerStatuses.find(container => container.name === 'https').restartCount;
  const initialContainerID = pod.status.containerStatuses.find(container => container.name === 'https').containerID;
  const connect = `--noproxy '*' --http1.1 --connect-to ${quote(`${hostname}:443:${ip.includes(':') ? `[${ip}]` : ip}:8443`)}`;
  const auth = '--cacert /credentials/reader/ca.crt --user "$(cat /credentials/reader/username):$(cat /credentials/reader/restPassword)"';
  const curl = `curl --silent --show-error ${connect} ${auth}`;
  const listing = shell(client, 'curl', `${curl} --fail --header 'Accept: application/vnd.x.restic.rest.v2' ${quote(`https://${hostname}/alpha/data/`)}`, { record: false });
  const packs = JSON.parse(listing.stdout).filter(object => /^[a-f0-9]{64}$/.test(object.name) &&
    Number.isSafeInteger(object.size) && object.size >= 8 * 1024 * 1024 && object.size <= 20 * 1024 * 1024);
  const pack = packs.sort((left, right) => right.size - left.size)[0];
  assert('native REST listing supplies a substantial SHA256-named pack', !!pack, { candidates: packs.length });
  const url = `https://${hostname}/alpha/data/${pack.name}`;
  // Twelve seconds leaves time for observation well inside the guard's 20s WaitDelay.
  const rate = Math.ceil(pack.size / 12);
  const clientState = () => {
    const result = shell(client, 'curl', `bytes=0; if test -f ${quote(`${directory}/pack`)}; then bytes=$(wc -c < ${quote(`${directory}/pack`)}); fi; printf 'bytes=%s\n' "$bytes"; if test -f ${quote(`${directory}/done`)}; then cat ${quote(`${directory}/done`)}; else printf 'pending=1\n'; fi`, { record: false });
    return Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('=')));
  };
  const processState = () => shell(pod.metadata.name, 'https', `
for p in /proc/[0-9]*; do
  test -r "$p/comm" || continue
  test "$(cat "$p/comm" 2>/dev/null)" = nginx || continue
  printf 'nginx '; tr '\\000' ' ' < "$p/cmdline"; printf '\\n'
done
for table in /proc/net/tcp /proc/net/tcp6; do
  while read -r slot local remote state queues timer retry uid timeout socket rest; do
    case "$local" in *:20FB) if test "$state" = 01; then printf 'accepted=%s remote=%s\\n' "$socket" "$remote"; fi;; esac
  done < "$table"
done`, { record: false, allowFailure: true });
  let paused = false;
  try {
    await stopController(name); paused = true;
    shell(client, 'curl', `mkdir -p ${quote(directory)}; (
      set +e
      ${curl} --fail --limit-rate ${rate} --max-time 25 --output ${quote(`${directory}/pack`)} --write-out '%{http_code}\\n' ${quote(url)} > ${quote(`${directory}/http`)} 2> ${quote(`${directory}/stderr`)}
      code=$?
      printf 'exit=%s\\nhttp=%s\\nsha256=%s\\n' "$code" "$(cat ${quote(`${directory}/http`)})" "$(sha256sum ${quote(`${directory}/pack`)} | cut -d ' ' -f 1)" > ${quote(`${directory}/result`)}
      mv ${quote(`${directory}/result`)} ${quote(`${directory}/done`)}
    ) </dev/null >/dev/null 2>&1 &`, { record: false });
    const flowing = await until('native pack download is still flowing before revocation', () => {
      const transfer = clientState();
      return transfer.pending === '1' && Number(transfer.bytes) >= 65536 && Number(transfer.bytes) < pack.size ? transfer : null;
    }, 8000);
    const accepted = processState();
    assert('real incomplete download has an accepted endpoint TLS socket and active nginx worker before stop', /accepted=\d+/.test(accepted.stdout) && /nginx: worker process/.test(accepted.stdout),
      { pack: pack.name, size: pack.size, bytes: Number(flowing.bytes), processes: accepted.stdout });
    const stoppedAt = Date.now();
    k(['patch', 'resticapplication', application, '--type=merge', '-p', JSON.stringify({ spec: { replicas: 0 } })]);
    const refused = await until('guard refuses a new direct PodIP connection during native drain', () => {
      const probe = shell(client, 'curl', `${curl} --connect-timeout 1 --max-time 1 --output /dev/null ${quote(url)}`, { record: false, allowFailure: true, timeout: 5000 });
      if (probe.status !== 7) return null;
      const transfer = clientState();
      const processes = processState();
      assert('new direct connection refused while prior download and graceful nginx worker remain active',
        transfer.pending === '1' && Number(transfer.bytes) > Number(flowing.bytes) && Number(transfer.bytes) < pack.size &&
          /worker process is shutting down/.test(processes.stdout),
        { curlExit: probe.status, bytes: Number(transfer.bytes), size: pack.size, processes: processes.stdout, sinceStopMs: Date.now() - stoppedAt });
      return { transfer, processes };
    }, 10000);
    assert('controller did not withdraw the Service or scale endpoint during guard-only drain',
      get('deployment', application, { record: false }).spec.replicas === 1 &&
      get('service', application, { record: false }).spec.selector?.['app.kubernetes.io/name'] === application,
      { podIP: ip, bytesAtRefusal: Number(refused.transfer.bytes) });
    const completed = await until('admitted native pack download finishes without truncation', () => {
      const transfer = clientState();
      return transfer.pending !== '1' ? transfer : null;
    }, Math.max(1000, 19000 - (Date.now() - stoppedAt)));
    const elapsed = Date.now() - stoppedAt;
    assert('in-flight native pack completes byte-correctly before graceful fallback', completed.exit === '0' && completed.http === '200' &&
      completed.sha256 === pack.name && Number(completed.bytes) === pack.size && elapsed < 19000,
      { pack: pack.name, sha256: completed.sha256, bytes: Number(completed.bytes), elapsedMs: elapsed });
    const exited = await until('guard exits after graceful nginx completion', () => {
      const current = get('pod', pod.metadata.name, { record: false });
      const status = current.status.containerStatuses?.find(container => container.name === 'https');
      const terminated = [status?.state?.terminated, status?.lastState?.terminated]
        .find(result => result?.containerID === initialContainerID);
      return terminated ? { status, terminated } : null;
    }, 15000);
    const logs = k(['logs', pod.metadata.name, '-c', 'https', ...(exited.status.restartCount > initialRestarts && !exited.status.state?.terminated ? ['--previous'] : [])], { record: false, allowFailure: true });
    const exitAfterStopMs = Date.parse(exited.terminated.finishedAt) - stoppedAt;
    assert('actual guard exits on intent revocation before nginx forced-termination fallback', exited.terminated.exitCode === 1 &&
      !exited.terminated.signal && exitAfterStopMs >= 0 && exitAfterStopMs < 19000 &&
      /admission revoked: current application intent refuses work/.test(logs.stdout + logs.stderr),
      { termination: exited.terminated, exitAfterStopMs, log: logs.stdout + logs.stderr });
  } finally {
    if (paused) await startController(name);
  }
  const stopped = await until('drain fixture reaches current-generation Stopped', () => {
    const object = get('resticapplication', application, { record: false });
    return object.spec.replicas === 0 && object.status?.state === 'Stopped' && object.status.observedGeneration === object.metadata.generation ? object : null;
  }, 180000);
  const deployment = get('deployment', application, { record: false });
  const replicasets = get('replicasets', null, { record: false }).items.filter(object =>
    object.metadata.ownerReferences?.some(owner => owner.uid === deployment.metadata.uid));
  assert('resumed controller acknowledges fully drained endpoint while durable stop intent remains zero',
    stopped.spec.replicas === 0 && deployment.spec.replicas === 0 && (deployment.status?.replicas || 0) === 0 &&
    replicasets.every(object => object.spec.replicas === 0 && (object.status?.replicas || 0) === 0) &&
    !get('pods', null, { record: false }).items.some(object => object.metadata.labels?.['app.kubernetes.io/name'] === application),
    { generation: stopped.metadata.generation });
}
