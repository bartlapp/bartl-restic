package controller

import (
	"context"
	"testing"

	api "github.com/bartlapp/bartl-restic/api/v1alpha1"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func fixture(t *testing.T) (*Reconciler, *api.ResticApplication) {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := api.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	a := &api.ResticApplication{ObjectMeta: metav1.ObjectMeta{Name: "backup", Namespace: "test", UID: "app-uid", Generation: 1, Finalizers: []string{finalizer}}, Spec: api.Spec{Replicas: 1, ExistingClaim: "data", TLSSecret: "tls", Image: "worker:qualified", Repositories: []api.Repository{{Name: "alpha", AuthSecret: "auth", PasswordSecret: "key"}}}}
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "data", Namespace: a.Namespace, UID: "pvc-uid", Annotations: map[string]string{claimOwner: string(a.UID)}}}
	objects := []client.Object{a, pvc}
	for _, name := range []string{"tls", "auth", "key"} {
		objects = append(objects, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: a.Namespace}})
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&api.ResticApplication{}, &appsv1.Deployment{}, &batchv1.Job{}).WithObjects(objects...).Build()
	r := &Reconciler{Client: c, Scheme: scheme, Namespace: a.Namespace, Name: a.Name, Release: "backup"}
	hash, err := r.inputHash(context.Background(), a, pvc)
	if err != nil {
		t.Fatal(err)
	}
	a.Status = api.Status{State: "Ready", ObservedGeneration: 1, Operation: &api.Operation{ID: "old-operation", JobName: "old-job", JobUID: "old-job-uid", PVCUID: string(pvc.UID), Generation: 1, InputHash: hash, Result: "Succeeded"}}
	if err := c.Status().Update(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	return r, a
}
func step(t *testing.T, r *Reconciler) *api.ResticApplication {
	t.Helper()
	ctx := context.Background()
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: r.key(r.Name)}); err != nil {
		t.Fatal(err)
	}
	a := new(api.ResticApplication)
	if err := r.Get(ctx, r.key(r.Name), a); err != nil {
		t.Fatal(err)
	}
	return a
}
func noEndpoint(t *testing.T, r *Reconciler) {
	t.Helper()
	err := r.Get(context.Background(), r.key(r.Name), new(appsv1.Deployment))
	if !apierrors.IsNotFound(err) {
		t.Fatalf("unsafe endpoint admitted: %v", err)
	}
}
func TestCompletedStopRequiresFreshNativeAdmission(t *testing.T) {
	r, a := fixture(t)
	ctx := context.Background()
	a.Spec.Replicas = 0
	a.Generation = 2
	if err := r.Update(ctx, a); err != nil {
		t.Fatal(err)
	}
	a = step(t, r)
	if a.Status.State != "Stopped" {
		t.Fatalf("stop not completed: %s", a.Status.State)
	}
	// A restarted controller must not use the old success to serve an offline-modified PVC.
	r = &Reconciler{Client: r.Client, Scheme: r.Scheme, Namespace: r.Namespace, Name: r.Name, Release: r.Release}
	a.Spec.Replicas = 1
	a.Generation = 3
	if err := r.Update(ctx, a); err != nil {
		t.Fatal(err)
	}
	a = step(t, r)
	a = step(t, r)
	noEndpoint(t, r)
	if a.Status.Operation == nil || a.Status.Operation.ID == "old-operation" || a.Status.Operation.Result != "Running" {
		t.Fatalf("fresh observation not admitted: %+v", a.Status.Operation)
	}
}
func TestStaleCompletionAndForeignClaimCannotServe(t *testing.T) {
	for _, fault := range []string{"job UID", "operation generation", "PVC owner", "missing job"} {
		t.Run(fault, func(t *testing.T) {
			r, a := fixture(t)
			ctx := context.Background()
			a.Status.State = "Starting"
			a.Status.Operation.Result = "Running"
			job := r.lifecycleJob(a)
			job.UID = types.UID(a.Status.Operation.JobUID)
			job.Spec.Suspend = ptr(false)
			job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
			switch fault {
			case "job UID":
				job.UID = "replacement-job"
			case "operation generation":
				a.Generation = 2
				if err := r.Update(ctx, a); err != nil {
					t.Fatal(err)
				}
			case "PVC owner":
				pvc := new(corev1.PersistentVolumeClaim)
				if err := r.Get(ctx, r.key("data"), pvc); err != nil {
					t.Fatal(err)
				}
				pvc.Annotations[claimOwner] = "other-app"
				if err := r.Update(ctx, pvc); err != nil {
					t.Fatal(err)
				}
			}
			// Spec Update restores the persisted status in the fake client; explicitly
			// persist the old-generation running admission after changing the spec.
			a.Status.State = "Starting"
			a.Status.Operation.Result = "Running"
			if err := r.Status().Update(ctx, a); err != nil {
				t.Fatal(err)
			}
			if fault != "missing job" {
				if err := r.Create(ctx, job); err != nil {
					t.Fatal(err)
				}
			}
			a = step(t, r)
			noEndpoint(t, r)
			if a.Status.State != "Failed" {
				t.Fatalf("unsafe result not rejected: %+v", a.Status)
			}
		})
	}
}

func TestControllerRestartReusesSuccessfulAdmission(t *testing.T) {
	r, a := fixture(t)
	ctx := context.Background()
	r = &Reconciler{Client: r.Client, Scheme: r.Scheme, Namespace: r.Namespace, Name: r.Name, Release: r.Release}
	a = step(t, r)
	if a.Status.Operation == nil || a.Status.Operation.ID != "old-operation" || a.Status.Operation.Result != "Succeeded" {
		t.Fatalf("successful running admission discarded: %+v", a.Status.Operation)
	}
	d := new(appsv1.Deployment)
	if err := r.Get(ctx, r.key(a.Name), d); err != nil {
		t.Fatal(err)
	}
	if d.Spec.Replicas == nil || *d.Spec.Replicas != 1 {
		t.Fatal("endpoint not resumed")
	}
	jobs := new(batchv1.JobList)
	if err := r.List(ctx, jobs); err != nil {
		t.Fatal(err)
	}
	if len(jobs.Items) != 0 {
		t.Fatal("restart admitted fresh lifecycle work")
	}
}

func TestFailedAdmissionSurvivesStopAndRun(t *testing.T) {
	for _, result := range []string{"Failed", "Running"} {
		t.Run(result, func(t *testing.T) {
			r, a := fixture(t)
			ctx := context.Background()
			a.Status.Operation.Result = result
			a.Status.Operation.Reason = "native failure"
			if err := r.Status().Update(ctx, a); err != nil {
				t.Fatal(err)
			}
			a.Spec.Replicas = 0
			a.Generation = 2
			if err := r.Update(ctx, a); err != nil {
				t.Fatal(err)
			}
			a = step(t, r)
			if a.Status.State != "Stopped" || a.Status.Operation == nil || a.Status.Operation.Result != "Failed" {
				t.Fatalf("stop cleared failure: %+v", a.Status)
			}
			reason := a.Status.Operation.Reason
			a.Spec.Replicas = 1
			a.Generation = 3
			if err := r.Update(ctx, a); err != nil {
				t.Fatal(err)
			}
			a = step(t, r)
			a = step(t, r)
			noEndpoint(t, r)
			if a.Status.State != "Failed" || a.Status.Operation == nil || a.Status.Operation.ID != "old-operation" || a.Status.Operation.Reason != reason {
				t.Fatalf("run cleared failed admission: %+v", a.Status)
			}
		})
	}
}
