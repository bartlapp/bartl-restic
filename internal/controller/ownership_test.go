package controller

import (
	"context"
	"errors"
	"testing"

	api "github.com/bartlapp/bartl-restic/api/v1alpha2"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func activeClaimPod(name, app string) *corev1.Pod {
	return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "test", Labels: map[string]string{appLabel: app}}, Spec: corev1.PodSpec{Volumes: []corev1.Volume{{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "data"}}}}}, Status: corev1.PodStatus{Phase: corev1.PodRunning}}
}

func TestRejectedClaimantCanStopAndFinalizeWithOwnerRunning(t *testing.T) {
	for _, deleting := range []bool{false, true} {
		name := "stop"
		if deleting {
			name = "finalize"
		}
		t.Run(name, func(t *testing.T) {
			r, a := fixture(t)
			ctx := context.Background()
			a.Status.Operation = nil
			if err := r.Status().Update(ctx, a); err != nil {
				t.Fatal(err)
			}
			pvc := new(corev1.PersistentVolumeClaim)
			if err := r.Get(ctx, r.key("data"), pvc); err != nil {
				t.Fatal(err)
			}
			pvc.Annotations[claimOwner] = "rightful-owner"
			if err := r.Update(ctx, pvc); err != nil {
				t.Fatal(err)
			}
			pod := activeClaimPod("owner-endpoint", "rightful-owner")
			if err := r.Create(ctx, pod); err != nil {
				t.Fatal(err)
			}
			a = step(t, r)
			if a.Status.State != "Failed" || a.Status.Operation == nil || a.Status.Operation.JobName != "" {
				t.Fatalf("claimant was not rejected before admission: %+v", a.Status)
			}
			if deleting {
				if err := r.Delete(ctx, a); err != nil {
					t.Fatal(err)
				}
			} else {
				a.Spec.Running = false
				if err := r.Update(ctx, a); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: r.key(r.Name)}); err != nil {
				t.Fatal(err)
			}
			got := new(api.ResticApplication)
			err := r.Get(ctx, r.key(a.Name), got)
			if deleting {
				if err == nil && contains(got.Finalizers, finalizer) {
					t.Fatal("rejected claimant finalizer blocked by rightful owner")
				}
				if err != nil && !apierrors.IsNotFound(err) {
					t.Fatal(err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if got.Status.State != "Stopped" || got.Status.Operation == nil || got.Status.Operation.Result != "Failed" {
					t.Fatalf("rejected claimant did not stop durably: %+v", got)
				}
			}
			if err := r.Get(ctx, r.key(pod.Name), new(corev1.Pod)); err != nil {
				t.Fatalf("rightful owner disturbed: %v", err)
			}
		})
	}
}

func TestClaimOwnerWaitsForForeignPVCUser(t *testing.T) {
	r, a := fixture(t)
	ctx := context.Background()
	pod := activeClaimPod("foreign", "other")
	if err := r.Create(ctx, pod); err != nil {
		t.Fatal(err)
	}
	a.Spec.Running = false
	if err := r.Update(ctx, a); err != nil {
		t.Fatal(err)
	}
	a = step(t, r)
	if a.Status.State != "Stopping" || a.Status.Operation == nil || a.Status.Operation.Result != "Succeeded" || !contains(a.Finalizers, finalizer) {
		t.Fatalf("owner declared drained with active PVC user: %+v", a)
	}
	if err := r.Delete(ctx, pod); err != nil {
		t.Fatal(err)
	}
	a = step(t, r)
	if a.Status.State != "Stopped" || a.Status.Operation != nil {
		t.Fatalf("completed stop retained success: %+v", a.Status)
	}
}

func TestChangedClaimOwnerStillWaitsForOwnPodChains(t *testing.T) {
	for _, chain := range []string{"app label", "endpoint label", "operation label", "job label", "job owner", "replicaset owner"} {
		t.Run(chain, func(t *testing.T) {
			r, a := fixture(t)
			ctx := context.Background()
			pvc := new(corev1.PersistentVolumeClaim)
			if err := r.Get(ctx, r.key("data"), pvc); err != nil {
				t.Fatal(err)
			}
			pvc.Annotations[claimOwner] = "other"
			if err := r.Update(ctx, pvc); err != nil {
				t.Fatal(err)
			}
			pod := activeClaimPod("own-worker", a.Name)
			pod.Spec.Volumes = nil
			pod.Labels = nil
			switch chain {
			case "app label":
				pod.Labels = map[string]string{appLabel: a.Name}
			case "endpoint label":
				pod.Labels = map[string]string{"app.kubernetes.io/name": a.Name}
			case "operation label":
				pod.Labels = map[string]string{operationLabel: a.Status.Operation.ID}
			case "job label":
				pod.Labels = map[string]string{"batch.kubernetes.io/job-name": a.Status.Operation.JobName}
			case "job owner":
				job := r.lifecycleJob(a)
				job.UID = "own-job"
				if err := r.Create(ctx, job); err != nil {
					t.Fatal(err)
				}
				pod.OwnerReferences = []metav1.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: job.Name, UID: job.UID, Controller: ptr(true)}}
			case "replicaset owner":
				rs := &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "old-endpoint", Namespace: a.Namespace, UID: "old-rs", OwnerReferences: []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "Deployment", Name: a.Name, UID: "old-deployment", Controller: ptr(true)}}}, Spec: appsv1.ReplicaSetSpec{Replicas: ptr(int32(0))}}
				if err := r.Create(ctx, rs); err != nil {
					t.Fatal(err)
				}
				pod.OwnerReferences = []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: rs.Name, UID: rs.UID, Controller: ptr(true)}}
			}
			if err := r.Create(ctx, pod); err != nil {
				t.Fatal(err)
			}
			a.Spec.Running = false
			if err := r.Update(ctx, a); err != nil {
				t.Fatal(err)
			}
			a = step(t, r)
			if a.Status.State != "Stopping" || !contains(a.Finalizers, finalizer) {
				t.Fatalf("own active Pod overlooked after claim transfer: %+v", a)
			}
			if chain == "job owner" {
				job := new(batchv1.Job)
				err := r.Get(ctx, r.key(a.Status.Operation.JobName), job)
				if err != nil && !apierrors.IsNotFound(err) {
					t.Fatal(err)
				}
				if err == nil && job.DeletionTimestamp.IsZero() {
					t.Fatal("own worker Job not cancelled")
				}
			}
		})
	}
}

type unavailableClaimClient struct{ client.Client }

func (c unavailableClaimClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if _, ok := obj.(*corev1.PersistentVolumeClaim); ok {
		return errors.New("PVC observation unavailable")
	}
	return c.Client.Get(ctx, key, obj, opts...)
}
func TestDrainFailsClosedWhenClaimCannotBeRead(t *testing.T) {
	r, a := fixture(t)
	ctx := context.Background()
	a.Spec.Running = false
	if err := r.Update(ctx, a); err != nil {
		t.Fatal(err)
	}
	r.Client = unavailableClaimClient{r.Client}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: r.key(r.Name)}); err == nil {
		t.Fatal("unreadable PVC did not block drain")
	}
	if err := r.Get(ctx, r.key(a.Name), a); err != nil {
		t.Fatal(err)
	}
	if !contains(a.Finalizers, finalizer) || a.Status.Operation == nil {
		t.Fatal("unobserved drainage acknowledged")
	}
}
func TestAbsentClaimDoesNotPreventStop(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(map[bool]string{false: "no own work", true: "own pending work"}[active], func(t *testing.T) {
			r, a := fixture(t)
			ctx := context.Background()
			pvc := new(corev1.PersistentVolumeClaim)
			if err := r.Get(ctx, r.key("data"), pvc); err != nil {
				t.Fatal(err)
			}
			if err := r.Delete(ctx, pvc); err != nil {
				t.Fatal(err)
			}
			if active {
				if err := r.Create(ctx, activeClaimPod("pending", a.Name)); err != nil {
					t.Fatal(err)
				}
			}
			a.Spec.Running = false
			if err := r.Update(ctx, a); err != nil {
				t.Fatal(err)
			}
			a = step(t, r)
			want := "Stopped"
			if active {
				want = "Stopping"
			}
			if a.Status.State != want {
				t.Fatalf("state %s, want %s", a.Status.State, want)
			}
		})
	}
}

func TestHelmMetadataDoesNotAuthorizeWorkloadAdoption(t *testing.T) {
	for _, kind := range []string{"Service", "Deployment", "CronJob"} {
		t.Run(kind, func(t *testing.T) {
			r, a := fixture(t)
			ctx := context.Background()
			meta := metav1.ObjectMeta{Name: a.Name, Namespace: a.Namespace, Annotations: map[string]string{"meta.helm.sh/release-name": "backup", "meta.helm.sh/release-namespace": a.Namespace}}
			switch kind {
			case "Service":
				service := &corev1.Service{ObjectMeta: meta, Spec: corev1.ServiceSpec{Selector: map[string]string{"foreign": "endpoint"}}}
				if err := r.Create(ctx, service); err != nil {
					t.Fatal(err)
				}
				if _, err := r.drain(ctx, a); err == nil {
					t.Fatal("drain adopted a Helm-owned Service")
				}
				if err := r.Get(ctx, r.key(service.Name), service); err != nil {
					t.Fatal(err)
				}
				if service.Spec.Selector["foreign"] != "endpoint" || len(service.OwnerReferences) != 0 {
					t.Fatal("foreign Service was changed")
				}
			case "Deployment":
				deployment := &appsv1.Deployment{ObjectMeta: meta, Spec: appsv1.DeploymentSpec{Replicas: ptr(int32(1))}}
				if err := r.Create(ctx, deployment); err != nil {
					t.Fatal(err)
				}
				if _, err := r.drain(ctx, a); err == nil {
					t.Fatal("drain adopted a Helm-owned Deployment")
				}
				if err := r.Get(ctx, r.key(deployment.Name), deployment); err != nil {
					t.Fatal(err)
				}
				if *deployment.Spec.Replicas != 1 || len(deployment.OwnerReferences) != 0 {
					t.Fatal("foreign Deployment was changed")
				}
			case "CronJob":
				meta.Name = a.Name + "-copy-foreign"
				cron := &batchv1.CronJob{ObjectMeta: meta, Spec: batchv1.CronJobSpec{Suspend: ptr(false)}}
				if err := r.Create(ctx, cron); err != nil {
					t.Fatal(err)
				}
				if _, err := r.drain(ctx, a); err != nil {
					t.Fatal(err)
				}
				if err := r.Get(ctx, r.key(cron.Name), cron); err != nil {
					t.Fatal(err)
				}
				if *cron.Spec.Suspend || len(cron.OwnerReferences) != 0 {
					t.Fatal("foreign CronJob was adopted or suspended")
				}
			}
		})
	}
}
