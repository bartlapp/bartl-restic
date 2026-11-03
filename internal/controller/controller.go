package controller

import (
	api "codeberg.org/bartlapp/bartl-restic/api/v1alpha1"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/uuid"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"strings"
	"time"
)

const claimOwner = "restic.bartl.sh/application-uid"
const appLabel = "restic.bartl.sh/application"
const operationLabel = "restic.bartl.sh/operation"
const finalizer = "restic.bartl.sh/drain"

type Reconciler struct {
	client.Client
	Scheme                   *runtime.Scheme
	Namespace, Name, Release string
}

func (r *Reconciler) Setup(m ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(m).For(&api.ResticApplication{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).Complete(r)
}
func (r *Reconciler) key(name string) types.NamespacedName {
	return types.NamespacedName{Namespace: r.Namespace, Name: name}
}
func (r *Reconciler) status(ctx context.Context, a *api.ResticApplication, state, reason string) error {
	a.Status.State = state
	a.Status.Reason = reason
	a.Status.ObservedGeneration = a.Generation
	for _, kind := range []string{"Ready", "Stopped", "Failed"} {
		v := metav1.ConditionFalse
		if kind == state {
			v = metav1.ConditionTrue
		}
		meta.SetStatusCondition(&a.Status.Conditions, metav1.Condition{Type: kind, Status: v, Reason: state, Message: reason, ObservedGeneration: a.Generation})
	}
	return r.Status().Update(ctx, a)
}
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	if req.Namespace != r.Namespace || req.Name != r.Name {
		return ctrl.Result{}, nil
	}
	again := ctrl.Result{RequeueAfter: time.Second}
	a := new(api.ResticApplication)
	if err := r.Get(ctx, req.NamespacedName, a); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if a.Spec.Replicas == 1 && !contains(a.Finalizers, finalizer) && a.DeletionTimestamp.IsZero() {
		a.Finalizers = append(a.Finalizers, finalizer)
		return again, r.Update(ctx, a)
	}
	// Closing access and stopping scheduled work precedes every lifecycle decision.
	running := a.Spec.Replicas == 1 && a.DeletionTimestamp.IsZero()
	if !running {
		if a.Status.Operation != nil && a.Status.Operation.Result == "Running" {
			a.Status.Operation.Result = "Failed"
			a.Status.Operation.Reason = "Lifecycle operation was interrupted by stop intent"
			if err := r.status(ctx, a, "Stopping", "Cancelling admitted lifecycle operation"); err != nil {
				return again, err
			}
		}
		drained, err := r.drain(ctx, a)
		if err != nil {
			return again, err
		}
		if !drained {
			return again, r.status(ctx, a, "Stopping", "Waiting for owned workloads and required PVC users to terminate")
		}
		if a.Status.Operation != nil && a.Status.Operation.Result == "Succeeded" {
			// A completed stop ends this admission. Offline changes must pass a
			// fresh native observation before the endpoint can serve again.
			a.Status.Operation = nil
		}
		if !a.DeletionTimestamp.IsZero() {
			a.Finalizers = remove(a.Finalizers, finalizer)
			return ctrl.Result{}, r.Update(ctx, a)
		}
		if err := r.status(ctx, a, "Stopped", "Stop intent is durable; required workload drainage is complete"); err != nil {
			return again, err
		}
		if contains(a.Finalizers, finalizer) {
			a.Finalizers = remove(a.Finalizers, finalizer)
			return again, r.Update(ctx, a)
		}
		return again, nil
	}
	if a.Status.Operation != nil && a.Status.Operation.Result == "Failed" {
		_, err := r.drain(ctx, a)
		if err != nil {
			return again, err
		}
		reason := a.Status.Operation.Reason
		if reason == "" {
			reason = "Lifecycle operation failed or was interrupted; discard the failed target before retrying"
		}
		return again, r.status(ctx, a, "Failed", reason)
	}
	if err := validateReplication(a); err != nil {
		return again, r.fail(ctx, a, err.Error())
	}
	pvc := new(corev1.PersistentVolumeClaim)
	if err := r.Get(ctx, r.key(a.Spec.ExistingClaim), pvc); err != nil {
		return again, r.blocked(ctx, a, "Cannot observe configured PVC: "+err.Error())
	}
	if pvc.DeletionTimestamp != nil {
		return again, r.fail(ctx, a, "Claim is being deleted")
	}
	if owner := pvc.Annotations[claimOwner]; owner != "" && owner != string(a.UID) {
		return again, r.fail(ctx, a, "Claim belongs to another application UID")
	}
	if pvc.Annotations[claimOwner] == "" {
		if pvc.Annotations == nil {
			pvc.Annotations = map[string]string{}
		}
		pvc.Annotations[claimOwner] = string(a.UID)
		if err := r.Update(ctx, pvc); err != nil {
			return again, err
		}
		return again, nil
	}
	hash, err := r.inputHash(ctx, a, pvc)
	if err != nil {
		return again, r.blocked(ctx, a, "Cannot observe configured inputs: "+err.Error())
	}
	op := a.Status.Operation
	if op != nil && op.Result == "Running" && (op.InputHash != hash || op.PVCUID != string(pvc.UID) || op.Generation != a.Generation) {
		return again, r.fail(ctx, a, "Inputs changed during an admitted operation")
	}
	if op != nil && op.Result == "Succeeded" && op.InputHash == hash && op.PVCUID == string(pvc.UID) {
		current := new(appsv1.Deployment)
		readErr := r.Get(ctx, r.key(a.Name), current)
		if a.Status.State == "Ready" && (readErr != nil || a.Status.ObservedGeneration != a.Generation || current.Status.ObservedGeneration < current.Generation || current.Status.ReadyReplicas != 1) {
			if err := r.status(ctx, a, "Starting", "Waiting for current HTTPS endpoint readiness"); err != nil {
				return again, err
			}
		}
		if readErr != nil && !apierrors.IsNotFound(readErr) {
			return again, readErr
		}
		if err := r.serving(ctx, a, pvc); err != nil {
			return again, err
		}
		d := new(appsv1.Deployment)
		if err := r.Get(ctx, r.key(a.Name), d); err != nil {
			return again, err
		}
		if d.Status.ObservedGeneration < d.Generation || d.Status.ReadyReplicas != 1 {
			return again, r.status(ctx, a, "Starting", "Waiting for HTTPS endpoint readiness")
		}
		return again, r.status(ctx, a, "Ready", "Native repository lifecycle succeeded")
	}
	if op == nil || op.Result == "Succeeded" {
		drained, err := r.drain(ctx, a)
		if err != nil {
			return again, err
		}
		if !drained {
			return again, r.status(ctx, a, "Starting", "Draining previous endpoint and copy work")
		}
		if err := r.configuration(ctx, a); err != nil {
			return again, err
		}
		id := string(uuid.NewUUID())
		a.Status.Operation = &api.Operation{ID: id, JobName: a.Name + "-lifecycle-" + id[:8], PVCUID: string(pvc.UID), Generation: a.Generation, InputHash: hash, Result: "Running"}
		// This status write is the durable admission. A missing admitted Job is never replayed.
		if err := r.status(ctx, a, "Starting", "Native lifecycle admitted"); err != nil {
			return again, err
		}
		job := r.lifecycleJob(a)
		if err := r.Create(ctx, job); err != nil {
			return again, err
		}
		a.Status.Operation.JobUID = string(job.UID)
		return again, r.Status().Update(ctx, a)
	}
	job := new(batchv1.Job)
	if err := r.Get(ctx, r.key(op.JobName), job); err != nil {
		if apierrors.IsNotFound(err) {
			return again, r.fail(ctx, a, "Previously admitted lifecycle Job is missing")
		}
		return again, err
	}
	if !metav1.IsControlledBy(job, a) || job.Labels[operationLabel] != op.ID || job.Annotations["restic.bartl.sh/pvc-uid"] != string(pvc.UID) || job.Annotations["restic.bartl.sh/input-hash"] != op.InputHash || (op.JobUID != "" && op.JobUID != string(job.UID)) {
		return again, r.fail(ctx, a, "Lifecycle Job identity mismatch")
	}
	if op.JobUID == "" {
		op.JobUID = string(job.UID)
		return again, r.Status().Update(ctx, a)
	}
	if job.Spec.Suspend != nil && *job.Spec.Suspend {
		job.Spec.Suspend = ptr(false)
		return again, r.Update(ctx, job)
	}
	for _, c := range job.Status.Conditions {
		if c.Status == corev1.ConditionTrue && c.Type == batchv1.JobFailed {
			return again, r.fail(ctx, a, "Native lifecycle Job failed")
		}
		if c.Status == corev1.ConditionTrue && c.Type == batchv1.JobComplete {
			op.Result = "Succeeded"
			return again, r.status(ctx, a, "Starting", "Native lifecycle verified; preparing endpoint")
		}
	}
	return again, nil
}
func (r *Reconciler) blocked(ctx context.Context, a *api.ResticApplication, reason string) error {
	if a.Status.Operation != nil && a.Status.Operation.Result == "Running" {
		return r.fail(ctx, a, reason)
	}
	if err := r.status(ctx, a, "Blocked", reason); err != nil {
		return err
	}
	_, err := r.drain(ctx, a)
	return err
}
func (r *Reconciler) fail(ctx context.Context, a *api.ResticApplication, reason string) error {
	if a.Status.Operation == nil {
		a.Status.Operation = &api.Operation{Result: "Failed"}
	} else {
		a.Status.Operation.Result = "Failed"
	}
	a.Status.Operation.Reason = reason
	if err := r.status(ctx, a, "Failed", reason); err != nil {
		return err
	}
	_, err := r.drain(ctx, a)
	return err
}
func (r *Reconciler) inputHash(ctx context.Context, a *api.ResticApplication, pvc *corev1.PersistentVolumeClaim) (string, error) {
	s := a.Spec
	s.Replicas = 0
	s.Replication = nil
	b, _ := json.Marshal(s)
	h := sha256.New()
	h.Write(b)
	h.Write([]byte(pvc.UID))
	// Recovery is deliberately not fetched: existing valid state must work offline.
	names := []string{a.Spec.TLSSecret}
	for _, repo := range s.Repositories {
		names = append(names, repo.AuthSecret, repo.PasswordSecret)
	}
	for _, name := range names {
		secret := new(corev1.Secret)
		if err := r.Get(ctx, r.key(name), secret); err != nil {
			return "", err
		}
		h.Write([]byte(name + string(secret.UID) + secret.ResourceVersion))
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func (r *Reconciler) adopt(ctx context.Context, a *api.ResticApplication, obj client.Object) error {
	if metav1.IsControlledBy(obj, a) {
		return nil
	}
	if len(obj.GetOwnerReferences()) != 0 {
		return fmt.Errorf("refusing foreign owner on %s", obj.GetName())
	}
	if obj.GetAnnotations()["meta.helm.sh/release-name"] != r.Release || obj.GetAnnotations()["meta.helm.sh/release-namespace"] != a.Namespace {
		return fmt.Errorf("refusing non-baseline object %s", obj.GetName())
	}
	return ctrl.SetControllerReference(a, obj, r.Scheme)
}
func (r *Reconciler) apply(ctx context.Context, a *api.ResticApplication, obj client.Object, mutate func()) error {
	err := r.Get(ctx, r.key(obj.GetName()), obj)
	if err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	if err == nil {
		if err := r.adopt(ctx, a, obj); err != nil {
			return err
		}
	} else {
		if err := ctrl.SetControllerReference(a, obj, r.Scheme); err != nil {
			return err
		}
	}
	mutate()
	if apierrors.IsNotFound(err) {
		return r.Create(ctx, obj)
	}
	return r.Update(ctx, obj)
}
func (r *Reconciler) drain(ctx context.Context, a *api.ResticApplication) (bool, error) {
	svc := new(corev1.Service)
	if err := r.Get(ctx, r.key(a.Name), svc); err == nil {
		if err := r.adopt(ctx, a, svc); err != nil {
			return false, err
		}
		svc.Spec.Selector = map[string]string{appLabel: "stopped-" + string(a.UID)}
		if err := r.Update(ctx, svc); err != nil {
			return false, err
		}
	} else if !apierrors.IsNotFound(err) {
		return false, err
	}
	crons := new(batchv1.CronJobList)
	if err := r.List(ctx, crons, client.InNamespace(a.Namespace)); err != nil {
		return false, err
	}
	for i := range crons.Items {
		c := &crons.Items[i]
		if !metav1.IsControlledBy(c, a) && !(strings.HasPrefix(c.Name, a.Name+"-copy-") && c.Annotations["meta.helm.sh/release-name"] == r.Release) {
			continue
		}
		if err := r.adopt(ctx, a, c); err != nil {
			return false, err
		}
		c.Spec.Suspend = ptr(true)
		if err := r.Update(ctx, c); err != nil {
			return false, err
		}
	}
	settled := true
	d := new(appsv1.Deployment)
	if err := r.Get(ctx, r.key(a.Name), d); err == nil {
		if err := r.adopt(ctx, a, d); err != nil {
			return false, err
		}
		d.Spec.Replicas = ptr(int32(0))
		if err := r.Update(ctx, d); err != nil {
			return false, err
		}
		settled = d.Status.ObservedGeneration >= d.Generation && d.Status.Replicas == 0 && d.Status.ReadyReplicas == 0 && d.Status.AvailableReplicas == 0
	} else if !apierrors.IsNotFound(err) {
		return false, err
	}
	// Delete Jobs with normal foreground propagation: Kubernetes sends SIGTERM and
	// retains unresponsive Pods. No force deletion and no native lock removal.
	jobs := new(batchv1.JobList)
	if err := r.List(ctx, jobs, client.InNamespace(a.Namespace)); err != nil {
		return false, err
	}
	for i := range jobs.Items {
		j := &jobs.Items[i]
		owned := metav1.IsControlledBy(j, a)
		for _, ref := range j.OwnerReferences {
			for _, c := range crons.Items {
				if ref.UID == c.UID && (metav1.IsControlledBy(&c, a) || strings.HasPrefix(c.Name, a.Name+"-copy-") && c.Annotations["meta.helm.sh/release-name"] == r.Release) {
					owned = true
				}
			}
		}
		if owned && j.Status.Succeeded == 0 && j.Status.Failed == 0 && j.DeletionTimestamp == nil {
			if err := r.Delete(ctx, j, client.PropagationPolicy(metav1.DeletePropagationForeground)); err != nil && !apierrors.IsNotFound(err) {
				return false, err
			}
		}
	}
	replicaSets := new(appsv1.ReplicaSetList)
	if err := r.List(ctx, replicaSets, client.InNamespace(a.Namespace)); err != nil {
		return false, err
	}
	for _, rs := range replicaSets.Items {
		owner := metav1.GetControllerOf(&rs)
		// A deleted Deployment can leave an old ReplicaSet briefly able to create
		// Pods. Its name-bound intent must drain too, even without the former UID.
		if owner == nil || owner.Kind != "Deployment" || owner.Name != a.Name {
			continue
		}
		if rs.Spec.Replicas == nil || *rs.Spec.Replicas != 0 || rs.Status.ObservedGeneration < rs.Generation || rs.Status.Replicas != 0 {
			settled = false
		}
	}
	pods := new(corev1.PodList)
	if err := r.List(ctx, pods, client.InNamespace(a.Namespace)); err != nil {
		return false, err
	}
	for _, p := range pods.Items {
		if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
			continue
		}
		for _, v := range p.Spec.Volumes {
			if v.PersistentVolumeClaim != nil && v.PersistentVolumeClaim.ClaimName == a.Spec.ExistingClaim {
				return false, nil
			}
		}
	}
	return settled, nil
}
func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
func remove(s []string, v string) []string {
	out := s[:0]
	for _, x := range s {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}
func ptr[T any](v T) *T { return &v }
func validateReplication(a *api.ResticApplication) error {
	repos := map[string]bool{}
	for _, repo := range a.Spec.Repositories {
		if repos[repo.Name] {
			return fmt.Errorf("duplicate repository name %s", repo.Name)
		}
		repos[repo.Name] = true
	}
	names, routes := map[string]bool{}, map[string]bool{}
	local := map[string]bool{a.Name: true, a.Name + "." + a.Namespace: true, a.Name + "." + a.Namespace + ".svc": true, a.Name + "." + a.Namespace + ".svc.cluster.local": true}
	for _, copy := range a.Spec.Replication {
		if names[copy.Name] {
			return fmt.Errorf("duplicate replication name %s", copy.Name)
		}
		names[copy.Name] = true
		if !repos[copy.Repository] {
			return fmt.Errorf("replication %s names an undeclared source", copy.Name)
		}
		host := strings.ToLower(copy.Destination.Host)
		route := copy.Repository + "|" + host + "|" + copy.Destination.Repository
		if routes[route] {
			return fmt.Errorf("duplicate replication source/destination pair")
		}
		routes[route] = true
		if local[host] && copy.Repository == copy.Destination.Repository {
			return fmt.Errorf("replication destination must not be the local source repository")
		}
	}
	return nil
}
