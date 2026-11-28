package controller

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	api "github.com/bartlapp/bartl-restic/api/v1alpha2"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"maps"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func metadata(a *api.ResticApplication, name string) metav1.ObjectMeta {
	return metav1.ObjectMeta{Name: name, Namespace: a.Namespace, Labels: map[string]string{appLabel: a.Name}}
}
func secretVolume(name, secret string, optional bool) corev1.Volume {
	return corev1.Volume{Name: name, VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: secret, Optional: ptr(optional)}}}
}
func mount(name, path string) corev1.VolumeMount {
	return corev1.VolumeMount{Name: name, MountPath: path, ReadOnly: true}
}
func remoteConfig(r *api.Remote, dir string) map[string]string {
	return map[string]string{"host": r.Host, "repository": r.Repository, "credentialsDirectory": dir}
}
func (r *Reconciler) configuration(ctx context.Context, a *api.ResticApplication) error {
	cm := &corev1.ConfigMap{ObjectMeta: metadata(a, a.Name)}
	if err := r.apply(ctx, a, cm, func() { cm.Data = map[string]string{"nginx.conf": nginx(a)} }); err != nil {
		return err
	}
	data := map[string]string{}
	repos := []any{}
	for _, repo := range a.Spec.Repositories {
		v := map[string]any{"name": repo.Name, "passwordFile": "/credentials/local-" + repo.Name + "/password"}
		if repo.Recovery != nil {
			v["recovery"] = remoteConfig(repo.Recovery, "/credentials/recovery-"+repo.Name)
		}
		repos = append(repos, v)
	}
	b, err := json.Marshal(map[string]any{"dataDirectory": "/data", "repositories": repos})
	if err != nil {
		return err
	}
	data["lifecycle.json"] = string(b)
	for _, copy := range a.Spec.Replication {
		b, err = json.Marshal(map[string]any{"dataDirectory": "/data", "replication": map[string]any{"repository": copy.Repository, "passwordFile": "/credentials/source/password", "destination": remoteConfig(&copy.Destination, "/credentials/destination")}})
		if err != nil {
			return err
		}
		data["copy-"+copy.Name+".json"] = string(b)
	}
	work := &corev1.ConfigMap{ObjectMeta: metadata(a, workerConfigName(a))}
	err = r.Get(ctx, r.key(work.Name), work)
	if err == nil {
		if !metav1.IsControlledBy(work, a) || work.Immutable == nil || !*work.Immutable || !maps.Equal(work.Data, data) {
			return fmt.Errorf("worker configuration %s does not match admitted generation", work.Name)
		}
		return nil
	}
	if !apierrors.IsNotFound(err) {
		return err
	}
	work.Data = data
	work.Immutable = ptr(true)
	if err := ctrl.SetControllerReference(a, work, r.Scheme); err != nil {
		return err
	}
	return r.Create(ctx, work)
}
func workerConfigName(a *api.ResticApplication) string {
	return fmt.Sprintf("%s-work-%d", a.Name, a.Generation)
}
func workerPod(a *api.ResticApplication, pvcUID, key, command string) corev1.PodTemplateSpec {
	return corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{appLabel: a.Name}}, Spec: corev1.PodSpec{ServiceAccountName: a.Name + "-worker", RestartPolicy: corev1.RestartPolicyNever, TerminationGracePeriodSeconds: ptr(int64(45)), Containers: []corev1.Container{{Name: "worker", Image: a.Spec.Image, Command: []string{"/bartl-restic-worker", command, "--config", "/config/config.json"}, Env: []corev1.EnvVar{{Name: "APPLICATION_NAME", Value: a.Name}, {Name: "APPLICATION_GENERATION", Value: fmt.Sprint(a.Generation)}, {Name: "APPLICATION_UID", Value: string(a.UID)}, {Name: "PVC_UID", Value: pvcUID}, {Name: "POD_NAMESPACE", Value: a.Namespace}, {Name: "OPERATION_UID", ValueFrom: &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.labels['batch.kubernetes.io/controller-uid']"}}}}, VolumeMounts: []corev1.VolumeMount{{Name: "data", MountPath: "/data"}, {Name: "config", MountPath: "/config/config.json", SubPath: key, ReadOnly: true}}}}, Volumes: []corev1.Volume{{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: a.Spec.ExistingClaim}}}, {Name: "config", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: workerConfigName(a)}}}}}}}
}
func (r *Reconciler) lifecycleJob(a *api.ResticApplication) *batchv1.Job {
	op := a.Status.Operation
	p := workerPod(a, op.PVCUID, "lifecycle.json", "lifecycle")
	p.Labels[operationLabel] = op.ID
	for _, repo := range a.Spec.Repositories {
		local := "l-" + repo.Name
		p.Spec.Volumes = append(p.Spec.Volumes, secretVolume(local, repo.PasswordSecret, false))
		p.Spec.Containers[0].VolumeMounts = append(p.Spec.Containers[0].VolumeMounts, mount(local, "/credentials/local-"+repo.Name))
		if repo.Recovery != nil {
			name := "r-" + repo.Name
			p.Spec.Volumes = append(p.Spec.Volumes, secretVolume(name, repo.Recovery.CredentialsSecret, true))
			p.Spec.Containers[0].VolumeMounts = append(p.Spec.Containers[0].VolumeMounts, mount(name, "/credentials/recovery-"+repo.Name))
		}
	}
	job := &batchv1.Job{ObjectMeta: metadata(a, op.JobName), Spec: batchv1.JobSpec{Suspend: ptr(true), BackoffLimit: ptr(int32(0)), Template: p}}
	job.Labels[operationLabel] = op.ID
	job.Annotations = map[string]string{"restic.bartl.sh/pvc-uid": op.PVCUID, "restic.bartl.sh/input-hash": op.InputHash}
	_ = ctrl.SetControllerReference(a, job, r.Scheme)
	return job
}
func (r *Reconciler) serving(ctx context.Context, a *api.ResticApplication, pvc *corev1.PersistentVolumeClaim) error {
	if err := r.configuration(ctx, a); err != nil {
		return err
	}
	d := &appsv1.Deployment{ObjectMeta: metadata(a, a.Name)}
	if err := r.apply(ctx, a, d, func() {
		selector := map[string]string{"app.kubernetes.io/name": a.Name}
		p := corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: selector, Annotations: map[string]string{"checksum/config": fmt.Sprintf("%x", sha256.Sum256([]byte(nginx(a))))}}, Spec: corev1.PodSpec{ServiceAccountName: a.Name + "-worker", AutomountServiceAccountToken: ptr(true), TerminationGracePeriodSeconds: ptr(int64(45)), Volumes: []corev1.Volume{{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: a.Spec.ExistingClaim}}}, {Name: "nginx", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: a.Name}}}}, secretVolume("tls", a.Spec.TLSSecret, false), {Name: "guard", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}}}}}
		p.Spec.InitContainers = []corev1.Container{{Name: "install-admission-guard", Image: a.Spec.Image, Command: []string{"cp", "/bartl-restic-worker", "/guard/worker"}, VolumeMounts: []corev1.VolumeMount{{Name: "guard", MountPath: "/guard"}}}}
		image := "docker.io/restic/rest-server@sha256:d2aff06f47eb38637dff580c3e6bce4af98f386c396a25d32eb6727ec96214a5"
		for i, name := range []string{"writer", "repository"} {
			args := []string{"--path", "/data", "--listen", fmt.Sprintf("127.0.0.1:%d", 8000+i), "--no-auth"}
			if i == 0 {
				args = append(args, "--append-only")
			}
			p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Name: name, Image: image, Command: []string{"rest-server"}, Args: args, VolumeMounts: []corev1.VolumeMount{{Name: "data", MountPath: "/data"}}})
		}
		https := corev1.Container{Name: "https", Image: "docker.io/library/nginx:1.28.0@sha256:552e7481ca93ffccd046aa658dbbed22caefbc09c66fa7cd247cbb90b8a5c609", Command: []string{"/guard/worker", "serve"}, Env: []corev1.EnvVar{{Name: "APPLICATION_NAME", Value: a.Name}, {Name: "APPLICATION_UID", Value: string(a.UID)}, {Name: "APPLICATION_GENERATION", Value: fmt.Sprint(a.Status.Operation.Generation)}, {Name: "PVC_UID", Value: string(pvc.UID)}, {Name: "POD_NAMESPACE", Value: a.Namespace}}, Ports: []corev1.ContainerPort{{Name: "https", ContainerPort: 8443}}, ReadinessProbe: &corev1.Probe{ProbeHandler: corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromString("https")}}}, VolumeMounts: []corev1.VolumeMount{{Name: "nginx", MountPath: "/etc/nginx/nginx.conf", SubPath: "nginx.conf", ReadOnly: true}, mount("tls", "/tls"), mount("guard", "/guard")}}
		for _, repo := range a.Spec.Repositories {
			name := "auth-" + repo.Name
			p.Spec.Volumes = append(p.Spec.Volumes, secretVolume(name, repo.AuthSecret, false))
			https.VolumeMounts = append(https.VolumeMounts, mount(name, "/auth/"+repo.Name))
		}
		p.Spec.Containers = append(p.Spec.Containers, https)
		d.Spec = appsv1.DeploymentSpec{Replicas: ptr(int32(1)), Strategy: appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType}, Selector: &metav1.LabelSelector{MatchLabels: selector}, Template: p}
	}); err != nil {
		return err
	}
	policy := &networkingv1.NetworkPolicy{ObjectMeta: metadata(a, a.Name)}
	if err := r.apply(ctx, a, policy, func() {
		policy.Spec = networkingv1.NetworkPolicySpec{PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"app.kubernetes.io/name": a.Name}}, PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress}, Ingress: []networkingv1.NetworkPolicyIngressRule{{Ports: []networkingv1.NetworkPolicyPort{{Protocol: ptr(corev1.ProtocolTCP), Port: ptr(intstr.FromInt32(8443))}}}}}
	}); err != nil {
		return err
	}
	svc := &corev1.Service{ObjectMeta: metadata(a, a.Name)}
	if err := r.apply(ctx, a, svc, func() {
		svc.Spec.Selector = map[string]string{"app.kubernetes.io/name": a.Name}
		svc.Spec.Ports = []corev1.ServicePort{{Name: "https", Port: 443, TargetPort: intstr.FromString("https"), Protocol: corev1.ProtocolTCP}}
	}); err != nil {
		return err
	}
	desired := map[string]bool{}
	for _, copy := range a.Spec.Replication {
		name := a.Name + "-copy-" + copy.Name
		desired[name] = true
		p := workerPod(a, string(pvc.UID), "copy-"+copy.Name+".json", "replicate")
		p.Labels["bartl-restic/replication"] = copy.Name
		p.Spec.Containers[0].VolumeMounts[0].SubPath = copy.Repository
		p.Spec.Containers[0].VolumeMounts[0].MountPath = "/data/" + copy.Repository
		p.Spec.Volumes = append(p.Spec.Volumes, secretVolume("source", copy.SourceCredentialsSecret, false), secretVolume("destination", copy.Destination.CredentialsSecret, false))
		p.Spec.Containers[0].VolumeMounts = append(p.Spec.Containers[0].VolumeMounts, mount("source", "/credentials/source"), mount("destination", "/credentials/destination"))
		p.Spec.Affinity = &corev1.Affinity{PodAffinity: &corev1.PodAffinity{RequiredDuringSchedulingIgnoredDuringExecution: []corev1.PodAffinityTerm{{LabelSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"app.kubernetes.io/name": a.Name}}, TopologyKey: "kubernetes.io/hostname"}}}}
		cron := &batchv1.CronJob{ObjectMeta: metadata(a, name)}
		deadline := copy.ActiveDeadlineSeconds
		if deadline == 0 {
			deadline = 3600
		}
		zone := copy.TimeZone
		if zone == "" {
			zone = "Etc/UTC"
		}
		if err := r.apply(ctx, a, cron, func() {
			cron.Labels["bartl-restic/replication"] = copy.Name
			cron.Spec = batchv1.CronJobSpec{Schedule: copy.Schedule, TimeZone: &zone, Suspend: ptr(copy.Suspend || a.Status.State != "Ready" || a.Status.ObservedGeneration != a.Generation), ConcurrencyPolicy: batchv1.ForbidConcurrent, StartingDeadlineSeconds: ptr(int64(60)), SuccessfulJobsHistoryLimit: ptr(int32(3)), FailedJobsHistoryLimit: ptr(int32(3)), JobTemplate: batchv1.JobTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{appLabel: a.Name, "bartl-restic/replication": copy.Name}}, Spec: batchv1.JobSpec{BackoffLimit: ptr(int32(0)), ActiveDeadlineSeconds: &deadline, Template: p}}}
		}); err != nil {
			return err
		}
	}
	crons := new(batchv1.CronJobList)
	if err := r.List(ctx, crons, client.InNamespace(a.Namespace)); err != nil {
		return err
	}
	for i := range crons.Items {
		c := &crons.Items[i]
		if metav1.IsControlledBy(c, a) && !desired[c.Name] {
			if err := r.Delete(ctx, c); err != nil {
				return err
			}
		}
	}
	return nil
}
func nginx(a *api.ResticApplication) string {
	s := `pid /tmp/nginx.pid;
events {}
http {
 access_log off;
 server_tokens off;
 client_body_temp_path /tmp/client-body;
 proxy_temp_path /tmp/proxy;
 map $remote_user $repository_backend {
  default http://127.0.0.1:8003;
  reader http://127.0.0.1:8002;
  writer http://127.0.0.1:8000;
  admin http://127.0.0.1:8001;
 }
 server {
  listen 8443 ssl;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_certificate /tls/tls.crt;
  ssl_certificate_key /tls/tls.key;
  client_max_body_size 0;
  location / { return 404; }
`
	for _, repo := range a.Spec.Repositories {
		s += fmt.Sprintf("  location /%s/ { auth_basic \"Restic %s\"; auth_basic_user_file /auth/%s/htpasswd; proxy_request_buffering off; proxy_read_timeout 600s; proxy_pass $repository_backend; }\n", repo.Name, repo.Name, repo.Name)
	}
	s += ` }
 server {
  listen 127.0.0.1:8002;
  client_max_body_size 0;
`
	for _, repo := range a.Spec.Repositories {
		s += fmt.Sprintf("  location ~ \"^/%s/locks/[a-f0-9]{64}$\" { limit_except GET POST DELETE { deny all; } proxy_request_buffering off; proxy_read_timeout 600s; proxy_pass http://127.0.0.1:8001; }\n", repo.Name)
	}
	return s + `  location / { limit_except GET { deny all; } proxy_read_timeout 600s; proxy_pass http://127.0.0.1:8001; }
 }
 server { listen 127.0.0.1:8003; location / { return 403; } }
}
`
}
