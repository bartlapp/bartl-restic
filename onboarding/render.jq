# Each function receives one application object; $i is the full inventory.
def prepare($i; $id):
  .readiness = {resource:"resticapplications.restic.bartl.sh",
    name:((.release + "-restic")[:20] | rtrimstr("-"))};

# Repository membership, protocol bindings and Secrets are resolved generically
# through the package's restic-endpoint role before configure runs.
def configure($i; $id): .;

def resources($i; $id):
  . as $a |
  (if $a.helm.tlsSecret != null then
    [{apiVersion:"cert-manager.io/v1",kind:"Certificate",
      metadata:{name:"repository",namespace:$a.namespace},
      spec:{secretName:$a.helm.tlsSecret,dnsNames:[$a.hostname],
        issuerRef:{name:$i.clusters[$a.cluster].platform.issuer.name,kind:"ClusterIssuer"}}}]
  else [] end) +
  [{apiVersion:"traefik.io/v1alpha1",kind:"IngressRouteTCP",
    metadata:{name:$a.release,namespace:$a.namespace},
    spec:{entryPoints:["websecure"],
      routes:[{match:("HostSNI(`" + $a.hostname + "`)"),
        services:[{name:(($a.release + "-restic")[:20] | rtrimstr("-")),port:8443}]}],
      tls:{passthrough:true}}}];

def files($i; $id): {};
