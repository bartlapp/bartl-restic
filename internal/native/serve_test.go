package native

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// The child records actual OS signals, not nginx or Kubernetes behavior.
func TestServeRevocationStopsRunningProcess(t *testing.T) {
	for _, reason := range []string{"stop", "claim ownership", "API unavailable"} {
		t.Run(reason, func(t *testing.T) {
			dir := t.TempDir()
			started, quit := filepath.Join(dir, "started"), filepath.Join(dir, "quit")
			script := fmt.Sprintf("#!/bin/sh\ntrap 'echo SIGQUIT > %q; exit 0' QUIT\necho running > %q\nwhile :; do sleep 0.1; done\n", quit, started)
			if err := os.WriteFile(filepath.Join(dir, "nginx"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
			t.Setenv("PVC_UID", "original-pvc")
			token := filepath.Join(dir, "token")
			if err := os.WriteFile(token, []byte("fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			var revoked atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/app" {
					app := admittedApplication("serve")
					app.Status.State = "Starting"
					if revoked.Load() && reason == "stop" {
						app.Spec.Replicas = 0
					}
					json.NewEncoder(w).Encode(app)
					return
				}
				if revoked.Load() && reason == "API unavailable" {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				pvc := admittedPVC()
				if revoked.Load() && reason == "claim ownership" {
					pvc["metadata"].(map[string]any)["annotations"] = map[string]string{"restic.bartl.sh/application-uid": "other"}
				}
				json.NewEncoder(w).Encode(pvc)
			}))
			defer server.Close()
			guard := &admission{client: server.Client(), url: server.URL + "/app", pvcURL: server.URL + "/pvc/", uid: "application", mode: "serve", generation: 4, tokenFile: token}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- serve(ctx, guard) }()
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
			deadline := time.After(5 * time.Second)
			for {
				if _, err := os.Stat(started); err == nil {
					break
				}
				select {
				case err := <-done:
					t.Fatalf("server exited before startup: %v", err)
				case <-deadline:
					t.Fatal("server did not start")
				case <-ticker.C:
				}
			}
			revoked.Store(true)
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("revocation not reported")
				}
				t.Logf("%s stopped running endpoint: %v", reason, err)
			case <-time.After(5 * time.Second):
				t.Fatal("endpoint kept running after revocation")
			}
			signal, err := os.ReadFile(quit)
			if err != nil || string(signal) != "SIGQUIT\n" {
				t.Fatalf("graceful quit not observed: %q %v", signal, err)
			}
		})
	}
}

func TestServeRefusesReplacedClaimBeforeStartingProcess(t *testing.T) {
	t.Setenv("PVC_UID", "original-pvc")
	dir := t.TempDir()
	started := filepath.Join(dir, "started")
	if err := os.WriteFile(filepath.Join(dir, "nginx"), []byte(fmt.Sprintf("#!/bin/sh\necho unsafe > %q\n", started)), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	guard := fixtureAdmission(t, admittedApplication("serve"), "serve", func(w http.ResponseWriter, r *http.Request) {
		pvc := admittedPVC()
		pvc["metadata"].(map[string]any)["uid"] = "replacement"
		json.NewEncoder(w).Encode(pvc)
	})
	if err := serve(context.Background(), guard); err == nil {
		t.Fatal("replacement claim admitted")
	}
	if _, err := os.Stat(started); !os.IsNotExist(err) {
		t.Fatalf("endpoint process started on unverified target: %v", err)
	}
}
