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
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func reconcileDeletion(t *testing.T, r *Reconciler) error {
	t.Helper()
	_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: r.key(r.Name)})
	return err
}

func assertClaimOwner(t *testing.T, r *Reconciler, owner string) *corev1.PersistentVolumeClaim {
	t.Helper()
	pvc := new(corev1.PersistentVolumeClaim)
	if err := r.Get(context.Background(), r.key("data"), pvc); err != nil {
		t.Fatal(err)
	}
	if pvc.Annotations[claimOwner] != owner {
		t.Fatalf("claim owner %q, want %q", pvc.Annotations[claimOwner], owner)
	}
	return pvc
}

func assertDeletionPending(t *testing.T, r *Reconciler) {
	t.Helper()
	a := new(api.ResticApplication)
	if err := r.Get(context.Background(), r.key(r.Name), a); err != nil {
		t.Fatal(err)
	}
	if !contains(a.Finalizers, finalizer) {
		t.Fatal("deletion acknowledged before safe claim release")
	}
}

func assertDeleted(t *testing.T, r *Reconciler) {
	t.Helper()
	if err := r.Get(context.Background(), r.key(r.Name), new(api.ResticApplication)); !apierrors.IsNotFound(err) {
		t.Fatalf("application not finalized: %v", err)
	}
}

func TestStoppedClaimReleasesOnlyOnDeletionAndCanBeReclaimed(t *testing.T) {
	r, a := fixture(t)
	ctx := context.Background()
	pvc := assertClaimOwner(t, r, string(a.UID))
	pvc.Annotations["test/keep"] = "annotation"
	pvc.Labels = map[string]string{"test/keep": "label"}
	pvc.Spec.VolumeName = "retained-volume"
	pvc.Finalizers = []string{"test/retain"}
	if err := r.Update(ctx, pvc); err != nil {
		t.Fatal(err)
	}
	a.Spec.Running = false
	a.Generation++
	// A stopped application missing its finalizer must regain protection.
	a.Finalizers = nil
	if err := r.Update(ctx, a); err != nil {
		t.Fatal(err)
	}
	a = step(t, r)
	a = step(t, r)
	if a.Status.State != "Stopped" || !contains(a.Finalizers, finalizer) || a.Status.Operation != nil {
		t.Fatalf("ordinary stop did not retain deletion protection: %+v", a)
	}
	assertClaimOwner(t, r, string(a.UID))
	if err := r.Delete(ctx, a); err != nil {
		t.Fatal(err)
	}
	if err := reconcileDeletion(t, r); err != nil {
		t.Fatal(err)
	}
	assertDeleted(t, r)
	got := assertClaimOwner(t, r, "")
	if got.UID != pvc.UID || got.Annotations["test/keep"] != "annotation" || got.Labels["test/keep"] != "label" || got.Spec.VolumeName != "retained-volume" || !contains(got.Finalizers, "test/retain") {
		t.Fatalf("release changed retained PVC metadata or storage: %+v", got)
	}
	fresh := &api.ResticApplication{ObjectMeta: metav1.ObjectMeta{Name: a.Name, Namespace: a.Namespace, UID: "replacement-app", Generation: 1}, Spec: a.Spec}
	fresh.Spec.Running = true
	fresh.Spec.TLSSecret = "replacement-tls"
	fresh.Spec.Repositories = []api.Repository{{Name: "independent", AuthSecret: "replacement-auth", PasswordSecret: "replacement-key"}}
	if err := r.Create(ctx, fresh); err != nil {
		t.Fatal(err)
	}
	step(t, r)
	step(t, r)
	assertClaimOwner(t, r, string(fresh.UID))
	noEndpoint(t, r)
}

func TestDeletionWaitsForPVCUsersAndWorkloadControllers(t *testing.T) {
	for _, blocker := range []string{"foreign PVC Pod", "unobserved ReplicaSet", "active Job", "deleting Job"} {
		t.Run(blocker, func(t *testing.T) {
			r, a := fixture(t)
			ctx := context.Background()
			var obj client.Object
			switch blocker {
			case "foreign PVC Pod":
				obj = activeClaimPod("foreign", "other")
			case "unobserved ReplicaSet":
				obj = &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "old-rs", Namespace: a.Namespace, UID: "old-rs", Generation: 2, OwnerReferences: []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "Deployment", Name: a.Name, UID: "old-deployment", Controller: ptr(true)}}}, Spec: appsv1.ReplicaSetSpec{Replicas: ptr(int32(0))}, Status: appsv1.ReplicaSetStatus{ObservedGeneration: 1}}
			default:
				job := r.lifecycleJob(a)
				job.UID = "unsettled-job"
				job.Finalizers = []string{"test/retain"}
				// Counts alone are not a terminal Job condition.
				job.Status.Succeeded = 1
				obj = job
			}
			if err := r.Create(ctx, obj); err != nil {
				t.Fatal(err)
			}
			if blocker == "deleting Job" {
				if err := r.Delete(ctx, obj); err != nil {
					t.Fatal(err)
				}
			}
			if err := r.Delete(ctx, a); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				if err := reconcileDeletion(t, r); err != nil {
					t.Fatal(err)
				}
				assertDeletionPending(t, r)
				assertClaimOwner(t, r, string(a.UID))
			}
		})
	}
}

// Intercept only the final release read/write, not the preceding drainage read.
type releaseFaultClient struct {
	client.Client
	pvcReads         int
	readFailure      bool
	conflict         bool
	finalizerFailure bool
	staleApplication bool
	appReads         int
}

func (c *releaseFaultClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if _, ok := obj.(*corev1.PersistentVolumeClaim); ok {
		c.pvcReads++
		if c.readFailure && c.pvcReads == 2 {
			return errors.New("release PVC read interrupted")
		}
	}
	if _, ok := obj.(*api.ResticApplication); ok {
		c.appReads++
		if c.staleApplication && c.appReads == 2 {
			current := new(api.ResticApplication)
			if err := c.Client.Get(ctx, key, current); err != nil {
				return err
			}
			current.Generation++
			if err := c.Client.Update(ctx, current); err != nil {
				return err
			}
		}
	}
	return c.Client.Get(ctx, key, obj, opts...)
}

func (c *releaseFaultClient) Update(ctx context.Context, obj client.Object, opts ...client.UpdateOption) error {
	if pvc, ok := obj.(*corev1.PersistentVolumeClaim); ok && c.conflict {
		if pvc.ResourceVersion == "" {
			return errors.New("release omitted resourceVersion")
		}
		current := new(corev1.PersistentVolumeClaim)
		if err := c.Client.Get(ctx, client.ObjectKeyFromObject(pvc), current); err != nil {
			return err
		}
		current.Annotations[claimOwner] = "concurrent-owner"
		if err := c.Client.Update(ctx, current); err != nil {
			return err
		}
		return c.Client.Update(ctx, obj, opts...)
	}
	if a, ok := obj.(*api.ResticApplication); ok && c.finalizerFailure && !contains(a.Finalizers, finalizer) {
		return errors.New("finalizer update interrupted")
	}
	return c.Client.Update(ctx, obj, opts...)
}

func TestReleaseFailuresKeepDeletionProtected(t *testing.T) {
	for _, fault := range []string{"unreadable during drain", "unreadable during release", "conflicting release", "changed application", "changed PVC UID"} {
		t.Run(fault, func(t *testing.T) {
			r, a := fixture(t)
			ctx := context.Background()
			if err := r.Delete(ctx, a); err != nil {
				t.Fatal(err)
			}
			base := r.Client
			switch fault {
			case "unreadable during drain":
				r.Client = unavailableClaimClient{base}
			case "unreadable during release":
				r.Client = &releaseFaultClient{Client: base, readFailure: true}
			case "conflicting release":
				r.Client = &releaseFaultClient{Client: base, conflict: true}
			case "changed application":
				r.Client = &releaseFaultClient{Client: base, staleApplication: true}
			case "changed PVC UID":
				if err := r.Get(ctx, r.key(a.Name), a); err != nil {
					t.Fatal(err)
				}
				a.Status.Operation.PVCUID = "previous-pvc"
				if err := r.Status().Update(ctx, a); err != nil {
					t.Fatal(err)
				}
			}
			if err := reconcileDeletion(t, r); err == nil {
				t.Fatal("uncertain release acknowledged")
			}
			r.Client = base
			assertDeletionPending(t, r)
			owner := string(a.UID)
			if fault == "conflicting release" {
				owner = "concurrent-owner"
			}
			assertClaimOwner(t, r, owner)
		})
	}
}

func TestReleaseRetryNeverErasesReplacementOwner(t *testing.T) {
	for _, newOwner := range []string{"", "replacement-owner"} {
		t.Run("owner="+newOwner, func(t *testing.T) {
			r, a := fixture(t)
			ctx := context.Background()
			if err := r.Delete(ctx, a); err != nil {
				t.Fatal(err)
			}
			base := r.Client
			r.Client = &releaseFaultClient{Client: base, finalizerFailure: true}
			if err := reconcileDeletion(t, r); err == nil {
				t.Fatal("finalizer update failure not returned")
			}
			r.Client = base
			assertDeletionPending(t, r)
			pvc := assertClaimOwner(t, r, "")
			if newOwner != "" {
				if pvc.Annotations == nil {
					pvc.Annotations = map[string]string{}
				}
				pvc.Annotations[claimOwner] = newOwner
				if err := r.Update(ctx, pvc); err != nil {
					t.Fatal(err)
				}
				if err := r.Create(ctx, activeClaimPod("replacement-endpoint", "replacement")); err != nil {
					t.Fatal(err)
				}
			}
			if err := reconcileDeletion(t, r); err != nil {
				t.Fatal(err)
			}
			assertDeleted(t, r)
			assertClaimOwner(t, r, newOwner)
		})
	}
}

func TestFailedOrInterruptedOperationDeletionRetainsClaimFence(t *testing.T) {
	for _, result := range []string{"Failed", "Running"} {
		t.Run(result, func(t *testing.T) {
			r, a := fixture(t)
			ctx := context.Background()
			a.Status.Operation.Result = result
			if err := r.Status().Update(ctx, a); err != nil {
				t.Fatal(err)
			}
			if err := r.Delete(ctx, a); err != nil {
				t.Fatal(err)
			}
			if err := reconcileDeletion(t, r); err != nil {
				t.Fatal(err)
			}
			assertDeleted(t, r)
			assertClaimOwner(t, r, string(a.UID))
		})
	}
}

func TestMissingClaimCanFinalizeAfterDrain(t *testing.T) {
	r, a := fixture(t)
	ctx := context.Background()
	pvc := assertClaimOwner(t, r, string(a.UID))
	if err := r.Delete(ctx, pvc); err != nil {
		t.Fatal(err)
	}
	if err := r.Delete(ctx, a); err != nil {
		t.Fatal(err)
	}
	if err := reconcileDeletion(t, r); err != nil {
		t.Fatal(err)
	}
	assertDeleted(t, r)
}

func TestTerminalJobDoesNotPreventClaimRelease(t *testing.T) {
	r, a := fixture(t)
	ctx := context.Background()
	job := r.lifecycleJob(a)
	job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
	if err := r.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	if err := r.Delete(ctx, a); err != nil {
		t.Fatal(err)
	}
	if err := reconcileDeletion(t, r); err != nil {
		t.Fatal(err)
	}
	assertDeleted(t, r)
	assertClaimOwner(t, r, "")
}

func TestDeletionConsumesBoundCompleteResultBeforeReleasingClaim(t *testing.T) {
	r, a := fixture(t)
	ctx := context.Background()
	a.Status.Operation.Result = "Running"
	job := r.lifecycleJob(a)
	job.UID = types.UID(a.Status.Operation.JobUID)
	job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
	if err := r.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	if err := r.Status().Update(ctx, a); err != nil {
		t.Fatal(err)
	}
	if err := r.Delete(ctx, a); err != nil {
		t.Fatal(err)
	}
	if err := reconcileDeletion(t, r); err != nil {
		t.Fatal(err)
	}
	assertDeleted(t, r)
	assertClaimOwner(t, r, "")
}
