package native

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	api "codeberg.org/bartlapp/bartl-restic/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestReplicationAdmissionBindsRetainedTarget(t *testing.T) {
	t.Setenv("PVC_UID", "original-pvc")
	original := api.ResticApplication{ObjectMeta: metav1.ObjectMeta{UID: "application", Generation: 4}, Spec: api.Spec{Replicas: 1, ExistingClaim: "data"}, Status: api.Status{State: "Ready", ObservedGeneration: 4, Operation: &api.Operation{Result: "Succeeded", PVCUID: "original-pvc"}}}
	cases := []struct {
		name    string
		change  func(*api.ResticApplication)
		allowed bool
	}{
		{"current target", func(a *api.ResticApplication) {}, true},
		{"replaced PVC with unchanged generation", func(a *api.ResticApplication) { a.Status.Operation.PVCUID = "replacement-pvc" }, false},
		{"stop intent before status catches up", func(a *api.ResticApplication) { a.Spec.Replicas = 0 }, false},
		{"old generation after stop and start", func(a *api.ResticApplication) { a.Generation = 5; a.Status.ObservedGeneration = 5 }, false},
		{"missing verified operation", func(a *api.ResticApplication) { a.Status.Operation = nil }, false},
		{"failed target with stale Ready", func(a *api.ResticApplication) { a.Status.Operation.Result = "Failed" }, false},
	}
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte("fixture-token"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := original.DeepCopyObject().(*api.ResticApplication)
			tc.change(app)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/namespaces/work/persistentvolumeclaims/data" {
					json.NewEncoder(w).Encode(admittedPVC())
					return
				}
				json.NewEncoder(w).Encode(app)
			}))
			defer server.Close()
			guard := admission{client: server.Client(), url: server.URL, pvcURL: server.URL + "/api/v1/namespaces/work/persistentvolumeclaims/", uid: "application", mode: "replicate", generation: 4, tokenFile: token}
			err := guard.check(context.Background())
			if (err == nil) != tc.allowed {
				t.Fatalf("admission allowed=%v, want %v: %v", err == nil, tc.allowed, err)
			}
		})
	}
}

func admittedPVC() map[string]any {
	return map[string]any{"metadata": map[string]any{
		"uid":         "original-pvc",
		"annotations": map[string]string{"restic.bartl.sh/application-uid": "application"},
	}}
}

func TestAdmissionRequiresLiveClaimOwnership(t *testing.T) {
	t.Setenv("PVC_UID", "original-pvc")
	t.Setenv("OPERATION_UID", "operation")
	for _, mode := range []string{"lifecycle", "replicate", "serve"} {
		t.Run(mode, func(t *testing.T) {
			for _, scenario := range []string{"owned", "replaced", "foreign", "unclaimed", "deleting", "missing", "unavailable", "malformed"} {
				t.Run(scenario, func(t *testing.T) {
					app := admittedApplication(mode)
					pvc := admittedPVC()
					meta := pvc["metadata"].(map[string]any)
					switch scenario {
					case "replaced":
						meta["uid"] = "replacement"
					case "foreign":
						meta["annotations"] = map[string]string{"restic.bartl.sh/application-uid": "other"}
					case "unclaimed":
						delete(meta, "annotations")
					case "deleting":
						meta["deletionTimestamp"] = "2026-11-03T12:00:00Z"
					}
					guard := fixtureAdmission(t, app, mode, func(w http.ResponseWriter, r *http.Request) {
						switch scenario {
						case "missing":
							http.NotFound(w, r)
						case "unavailable":
							w.WriteHeader(http.StatusForbidden)
						case "malformed":
							w.Write([]byte("{"))
						default:
							json.NewEncoder(w).Encode(pvc)
						}
					})
					err := guard.check(context.Background())
					if (err == nil) != (scenario == "owned") {
						t.Fatalf("admission error: %v", err)
					}
				})
			}
		})
	}
}

func admittedApplication(mode string) *api.ResticApplication {
	app := &api.ResticApplication{ObjectMeta: metav1.ObjectMeta{UID: "application", Generation: 4}, Spec: api.Spec{Replicas: 1, ExistingClaim: "data"}, Status: api.Status{State: "Ready", ObservedGeneration: 4, Operation: &api.Operation{Result: "Succeeded", PVCUID: "original-pvc", Generation: 4, JobUID: "operation"}}}
	if mode == "lifecycle" {
		app.Status.Operation.Result = "Running"
	}
	return app
}

func fixtureAdmission(t *testing.T, app *api.ResticApplication, mode string, pvc http.HandlerFunc) *admission {
	t.Helper()
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte("fixture-token"), 0600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Error("missing API authorization")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/app":
			json.NewEncoder(w).Encode(app)
		case "/api/v1/namespaces/work/persistentvolumeclaims/data":
			pvc(w, r)
		default:
			t.Errorf("unexpected API path %q", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return &admission{client: server.Client(), url: server.URL + "/app", pvcURL: server.URL + "/api/v1/namespaces/work/persistentvolumeclaims/", uid: "application", mode: mode, generation: 4, tokenFile: token}
}

func TestServeAdmissionUsesVerifiedTargetNotReadinessOrLatestGeneration(t *testing.T) {
	t.Setenv("PVC_UID", "original-pvc")
	cases := []struct {
		name    string
		change  func(*api.ResticApplication)
		allowed bool
	}{
		{"verified before readiness", func(a *api.ResticApplication) { a.Status.State = "Starting"; a.Status.ObservedGeneration = 0 }, true},
		{"schedule edit", func(a *api.ResticApplication) { a.Generation = 5 }, true},
		{"stop intent", func(a *api.ResticApplication) { a.Spec.Replicas = 0 }, false},
		{"replaced application", func(a *api.ResticApplication) { a.UID = "replacement" }, false},
		{"deleting application", func(a *api.ResticApplication) { now := metav1.Now(); a.DeletionTimestamp = &now }, false},
		{"missing operation", func(a *api.ResticApplication) { a.Status.Operation = nil }, false},
		{"running operation", func(a *api.ResticApplication) { a.Status.Operation.Result = "Running" }, false},
		{"different verified target", func(a *api.ResticApplication) { a.Status.Operation.PVCUID = "different" }, false},
		{"missing claim", func(a *api.ResticApplication) { a.Spec.ExistingClaim = "" }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := admittedApplication("serve")
			tc.change(app)
			guard := fixtureAdmission(t, app, "serve", func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(admittedPVC()) })
			err := guard.check(context.Background())
			if (err == nil) != tc.allowed {
				t.Fatalf("admission allowed=%v, want %v: %v", err == nil, tc.allowed, err)
			}
		})
	}
}
