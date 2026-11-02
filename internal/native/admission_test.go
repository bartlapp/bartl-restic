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
	original := api.ResticApplication{ObjectMeta: metav1.ObjectMeta{UID: "application", Generation: 4}, Spec: api.Spec{Replicas: 1}, Status: api.Status{State: "Ready", ObservedGeneration: 4, Operation: &api.Operation{Result: "Succeeded", PVCUID: "original-pvc"}}}
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
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(app) }))
			defer server.Close()
			guard := admission{client: server.Client(), url: server.URL, uid: "application", mode: "replicate", generation: 4, tokenFile: token}
			err := guard.check(context.Background())
			if (err == nil) != tc.allowed {
				t.Fatalf("admission allowed=%v, want %v: %v", err == nil, tc.allowed, err)
			}
		})
	}
}
