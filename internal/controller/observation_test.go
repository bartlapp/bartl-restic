package controller

import (
	"context"
	"errors"
	"reflect"
	"testing"

	api "github.com/bartlapp/bartl-restic/api/v1alpha1"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type unavailableObservationClient struct {
	client.Client
	kind string
	err  error
}

func (c *unavailableObservationClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	unavailable := false
	switch obj.(type) {
	case *corev1.PersistentVolumeClaim:
		unavailable = c.kind == "PVC"
	case *corev1.Secret:
		unavailable = c.kind == "Secret"
	case *appsv1.Deployment:
		unavailable = c.kind == "Deployment"
	}
	if unavailable {
		return c.err
	}
	return c.Client.Get(ctx, key, obj, opts...)
}

func readyObservationFixture(t *testing.T) (*Reconciler, *api.ResticApplication) {
	t.Helper()
	r, _ := fixture(t)
	a := step(t, r)
	d := new(appsv1.Deployment)
	if err := r.Get(context.Background(), r.key(a.Name), d); err != nil {
		t.Fatal(err)
	}
	d.Status.ObservedGeneration = d.Generation
	d.Status.Replicas = 1
	d.Status.ReadyReplicas = 1
	d.Status.AvailableReplicas = 1
	if err := r.Status().Update(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	a = step(t, r)
	if a.Status.State != "Ready" {
		t.Fatalf("fixture not ready: %+v", a.Status)
	}
	return r, a
}

func observationObjects(t *testing.T, c client.Client) []client.ObjectList {
	t.Helper()
	lists := []client.ObjectList{new(corev1.ServiceList), new(appsv1.DeploymentList), new(corev1.ConfigMapList), new(networkingv1.NetworkPolicyList), new(batchv1.CronJobList), new(batchv1.JobList)}
	for _, list := range lists {
		if err := c.List(context.Background(), list, client.InNamespace("test")); err != nil {
			t.Fatal(err)
		}
	}
	return lists
}

func TestEstablishedEndpointObservationFailurePreservesAdmission(t *testing.T) {
	for _, kind := range []string{"PVC", "Secret", "Deployment", "missing Secret", "PVC proxy404", "Deployment proxy404"} {
		for _, changed := range []bool{false, true} {
			name := kind
			if changed {
				name += "/changed intent"
			}
			t.Run(name, func(t *testing.T) {
				r, a := readyObservationFixture(t)
				ctx := context.Background()
				if changed {
					a.Spec.Image = "worker:changed"
					a.Generation++
					if err := r.Update(ctx, a); err != nil {
						t.Fatal(err)
					}
				}
				beforeStatus := a.DeepCopyObject().(*api.ResticApplication).Status
				base := r.Client
				beforeObjects := observationObjects(t, base)
				fault := &unavailableObservationClient{Client: base, kind: kind, err: errors.New("observation unavailable")}
				if kind == "missing Secret" {
					fault.kind = "Secret"
					fault.err = apierrors.NewNotFound(schema.GroupResource{Resource: "secrets"}, "tls")
				}
				switch kind {
				case "PVC proxy404":
					fault.kind = "PVC"
					fault.err = apierrors.NewGenericServerResponse(404, "get", schema.GroupResource{Resource: "persistentvolumeclaims"}, "data", "proxy route unavailable", 0, true)
				case "Deployment proxy404":
					fault.kind = "Deployment"
					fault.err = apierrors.NewGenericServerResponse(404, "get", schema.GroupResource{Resource: "deployments"}, a.Name, "proxy route unavailable", 0, true)
				}
				r.Client = fault
				for range 2 {
					result, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: r.key(r.Name)})
					if err == nil || result.RequeueAfter == 0 {
						t.Fatalf("unavailable observation did not retry: %+v, %v", result, err)
					}
					current := new(api.ResticApplication)
					if err := base.Get(ctx, r.key(r.Name), current); err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(beforeStatus, current.Status) {
						t.Fatalf("unavailable observation changed admitted status: before=%+v after=%+v", beforeStatus, current.Status)
					}
					if !reflect.DeepEqual(beforeObjects, observationObjects(t, base)) {
						t.Fatal("unavailable observation changed generated objects or admitted new work")
					}
				}
			})
		}
	}
}

func TestConfirmedPVCRevocationWinsOverUnavailableSecrets(t *testing.T) {
	for _, revocation := range []string{"UID", "owner", "missing owner", "deleting", "not found"} {
		t.Run(revocation, func(t *testing.T) {
			r, a := readyObservationFixture(t)
			ctx := context.Background()
			pvc := new(corev1.PersistentVolumeClaim)
			if err := r.Get(ctx, r.key(a.Spec.ExistingClaim), pvc); err != nil {
				t.Fatal(err)
			}
			switch revocation {
			case "UID":
				pvc.UID = "replacement-pvc"
			case "owner":
				pvc.Annotations[claimOwner] = "another-application"
			case "missing owner":
				delete(pvc.Annotations, claimOwner)
			case "deleting":
				pvc.Finalizers = []string{"test/retain"}
			}
			if revocation != "not found" {
				if err := r.Update(ctx, pvc); err != nil {
					t.Fatal(err)
				}
			}
			if revocation == "not found" || revocation == "deleting" {
				if err := r.Delete(ctx, pvc); err != nil {
					t.Fatal(err)
				}
			}
			r.Client = &unavailableObservationClient{Client: r.Client, kind: "Secret", err: errors.New("Secret observation unavailable")}
			a = step(t, r)
			if a.Status.State != "Failed" || a.Status.Operation.Result != "Failed" {
				t.Fatalf("confirmed PVC revocation masked: %+v", a.Status)
			}
			assertObservationDrained(t, r.Client, r)
			if revocation == "missing owner" {
				if err := r.Get(ctx, r.key(a.Spec.ExistingClaim), pvc); err != nil {
					t.Fatal(err)
				}
				if pvc.Annotations[claimOwner] != "" {
					t.Fatal("revoked ownership silently re-adopted")
				}
			}
		})
	}
}

func assertObservationDrained(t *testing.T, c client.Client, r *Reconciler) {
	t.Helper()
	ctx := context.Background()
	svc := new(corev1.Service)
	if err := c.Get(ctx, r.key(r.Name), svc); err != nil {
		t.Fatal(err)
	}
	if svc.Spec.Selector[appLabel] != "stopped-app-uid" {
		t.Fatal("endpoint access was not drained")
	}
	d := new(appsv1.Deployment)
	if err := c.Get(ctx, r.key(r.Name), d); err != nil {
		t.Fatal(err)
	}
	if d.Spec.Replicas == nil || *d.Spec.Replicas != 0 {
		t.Fatal("endpoint workload was not stopped")
	}
	jobs := new(batchv1.JobList)
	if err := c.List(ctx, jobs); err != nil {
		t.Fatal(err)
	}
	if len(jobs.Items) != 0 {
		t.Fatal("observation failure admitted lifecycle work")
	}
}

func TestStopDrainsDespiteUnavailablePVCObservation(t *testing.T) {
	r, a := readyObservationFixture(t)
	ctx := context.Background()
	a.Spec.Replicas = 0
	a.Generation++
	if err := r.Update(ctx, a); err != nil {
		t.Fatal(err)
	}
	base := r.Client
	r.Client = &unavailableObservationClient{Client: base, kind: "PVC", err: errors.New("PVC observation unavailable")}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: r.key(r.Name)}); err == nil {
		t.Fatal("unobserved PVC drainage claimed complete")
	}
	assertObservationDrained(t, base, r)
	if err := base.Get(ctx, r.key(r.Name), a); err != nil {
		t.Fatal(err)
	}
	if a.Status.State == "Stopped" {
		t.Fatal("unobserved PVC drainage reported Stopped")
	}
}

func TestUnverifiedAndRunningObservationFailuresRemainFailClosed(t *testing.T) {
	for _, admission := range []string{"new", "Running"} {
		for _, kind := range []string{"PVC", "Secret"} {
			t.Run(admission+"/"+kind, func(t *testing.T) {
				r, a := readyObservationFixture(t)
				ctx := context.Background()
				if admission == "new" {
					a.Status.Operation = nil
				} else {
					a.Status.Operation.Result = "Running"
				}
				a.Status.State = "Starting"
				if err := r.Status().Update(ctx, a); err != nil {
					t.Fatal(err)
				}
				base := r.Client
				r.Client = &unavailableObservationClient{Client: base, kind: kind, err: errors.New("observation unavailable")}
				_, _ = r.Reconcile(ctx, ctrl.Request{NamespacedName: r.key(r.Name)})
				assertObservationDrained(t, base, r)
				if err := base.Get(ctx, r.key(r.Name), a); err != nil {
					t.Fatal(err)
				}
				if admission == "Running" && (a.Status.Operation.Result != "Failed" || a.Status.State != "Failed") {
					t.Fatalf("Running admission failed open: %+v", a.Status)
				}
				if admission == "new" && a.Status.State != "Blocked" {
					t.Fatalf("unverified admission not blocked: %+v", a.Status)
				}
			})
		}
	}
}
