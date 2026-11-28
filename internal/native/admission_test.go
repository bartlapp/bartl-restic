package native

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	api "github.com/bartlapp/bartl-restic/api/v1alpha2"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestReplicationAdmissionBindsRetainedTarget(t *testing.T) {
	t.Setenv("PVC_UID", "original-pvc")
	original := api.ResticApplication{ObjectMeta: metav1.ObjectMeta{UID: "application", Generation: 4}, Spec: api.Spec{Running: true, ExistingClaim: "data"}, Status: api.Status{State: "Ready", ObservedGeneration: 4, Operation: &api.Operation{Result: "Succeeded", PVCUID: "original-pvc"}}}
	cases := []struct {
		name    string
		change  func(*api.ResticApplication)
		allowed bool
	}{
		{"current target", func(a *api.ResticApplication) {}, true},
		{"replaced PVC with unchanged generation", func(a *api.ResticApplication) { a.Status.Operation.PVCUID = "replacement-pvc" }, false},
		{"stop intent before status catches up", func(a *api.ResticApplication) { a.Spec.Running = false }, false},
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
	app := &api.ResticApplication{ObjectMeta: metav1.ObjectMeta{UID: "application", Generation: 4}, Spec: api.Spec{Running: true, ExistingClaim: "data"}, Status: api.Status{State: "Ready", ObservedGeneration: 4, Operation: &api.Operation{Result: "Succeeded", PVCUID: "original-pvc", Generation: 4, JobUID: "operation"}}}
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
		{"stop intent", func(a *api.ResticApplication) { a.Spec.Running = false }, false},
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

func TestAdmissionDistinguishesRevocationFromUnavailableObservation(t *testing.T) {
	t.Setenv("PVC_UID", "original-pvc")
	t.Setenv("OPERATION_UID", "operation")
	for _, object := range []string{"application", "PVC"} {
		for _, tc := range []struct {
			name    string
			code    int
			body    string
			revoked bool
		}{
			{"Kubernetes NotFound", 404, `{"kind":"Status","apiVersion":"v1","reason":"NotFound","code":404}`, true},
			{"proxy 404", 404, `not found`, false},
			{"unconfirmed 404", 404, `{"reason":"NotFound"}`, false},
			{"unauthorized", 401, ``, false},
			{"forbidden", 403, ``, false},
			{"API unavailable", 503, ``, false},
			{"malformed", 200, `{`, false},
			{"trailing malformed data", 200, `{"metadata":{"uid":"replacement","generation":4}}{`, false},
			{"empty identity", 200, `{"metadata":{}}`, false},
			{"replacement identity", 200, `{"metadata":{"uid":"replacement","generation":4}}`, true},
		} {
			t.Run(object+"/"+tc.name, func(t *testing.T) {
				guard := fixtureAdmission(t, admittedApplication("serve"), "serve", func(w http.ResponseWriter, r *http.Request) {
					w.WriteHeader(tc.code)
					w.Write([]byte(tc.body))
				})
				if object == "application" {
					guard.url = guard.pvcURL + "data"
				}
				err := guard.check(context.Background())
				if err == nil || errors.Is(err, errAdmissionRevoked) != tc.revoked {
					t.Fatalf("observation error = %v, want revoked=%v", err, tc.revoked)
				}
			})
		}
	}
}

func TestAdmissionNegativeDominatesUnavailableObservation(t *testing.T) {
	t.Setenv("PVC_UID", "original-pvc")
	for _, negative := range []string{"application", "PVC"} {
		t.Run(negative, func(t *testing.T) {
			app := admittedApplication("serve")
			if negative == "application" {
				app.Spec.Running = false
			}
			guard := fixtureAdmission(t, app, "serve", func(w http.ResponseWriter, r *http.Request) {
				if negative == "application" {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				pvc := admittedPVC()
				delete(pvc["metadata"].(map[string]any), "annotations")
				json.NewEncoder(w).Encode(pvc)
			})
			guard.boundClaim = "data"
			if negative == "PVC" {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.WriteHeader(http.StatusServiceUnavailable)
				}))
				defer server.Close()
				guard.url = server.URL
			}
			if err := guard.check(context.Background()); !errors.Is(err, errAdmissionRevoked) {
				t.Fatalf("confirmed negative lost to unavailable observation: %v", err)
			}
		})
	}
}

func TestWorkerMonitorsRemainFailClosedOnUnavailableObservation(t *testing.T) {
	t.Setenv("PVC_UID", "original-pvc")
	t.Setenv("OPERATION_UID", "operation")
	for _, mode := range []string{"lifecycle", "replicate"} {
		t.Run(mode, func(t *testing.T) {
			guard := fixtureAdmission(t, admittedApplication(mode), mode, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusServiceUnavailable)
			})
			ctx, cancel := context.WithCancelCause(context.Background())
			defer cancel(nil)
			done := make(chan struct{})
			go func() {
				guard.monitor(ctx, cancel)
				close(done)
			}()
			select {
			case <-done:
				if context.Cause(ctx) == nil {
					t.Fatal("worker monitor did not cancel on unavailable observation")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("worker kept running without current admission")
			}
		})
	}
}

func TestRuntimeIntentIsRequiredAndStopRevokesEveryWorker(t *testing.T) {
	t.Setenv("PVC_UID", "original-pvc")
	t.Setenv("OPERATION_UID", "operation")
	for _, mode := range []string{"lifecycle", "replicate", "serve"} {
		for _, intent := range []string{"true", "false", "missing"} {
			t.Run(mode+"/"+intent, func(t *testing.T) {
				app := admittedApplication(mode)
				data, err := json.Marshal(app)
				if err != nil {
					t.Fatal(err)
				}
				var body map[string]any
				if err := json.Unmarshal(data, &body); err != nil {
					t.Fatal(err)
				}
				spec := body["spec"].(map[string]any)
				switch intent {
				case "false":
					spec["running"] = false
				case "missing":
					delete(spec, "running")
				}
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					json.NewEncoder(w).Encode(body)
				}))
				defer server.Close()
				guard := &admission{client: server.Client(), url: server.URL, uid: "application", generation: 4, mode: mode}
				_, err = guard.checkApplication(context.Background(), "token")
				if intent == "true" && err != nil {
					t.Fatalf("current intent rejected: %v", err)
				}
				if intent == "false" && !errors.Is(err, errAdmissionRevoked) {
					t.Fatalf("stop did not revoke worker: %v", err)
				}
				if intent == "missing" && (err == nil || errors.Is(err, errAdmissionRevoked)) {
					t.Fatalf("missing intent was not an observation error: %v", err)
				}
			})
		}
	}
}

func TestLifecycleAdmissionRejectsStaleNativeOwnership(t *testing.T) {
	t.Setenv("PVC_UID", "original-pvc")
	t.Setenv("OPERATION_UID", "operation")
	for _, fault := range []string{"job UID", "PVC UID", "operation generation", "failed operation", "application UID"} {
		t.Run(fault, func(t *testing.T) {
			app := admittedApplication("lifecycle")
			switch fault {
			case "job UID":
				app.Status.Operation.JobUID = "other"
			case "PVC UID":
				app.Status.Operation.PVCUID = "other"
			case "operation generation":
				app.Status.Operation.Generation++
			case "failed operation":
				app.Status.Operation.Result = "Failed"
			case "application UID":
				app.UID = "other"
			}
			guard := fixtureAdmission(t, app, "lifecycle", func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode(admittedPVC())
			})
			if err := guard.check(context.Background()); !errors.Is(err, errAdmissionRevoked) {
				t.Fatalf("stale lifecycle ownership accepted: %v", err)
			}
		})
	}
}
