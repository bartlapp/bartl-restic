package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type serveFixture struct {
	guard   *admission
	phase   atomic.Int32
	started string
	quit    string
	exit    string
}

// The child records actual OS signals, not nginx or Kubernetes behavior.
func newServeFixture(t *testing.T, respond func(int32, http.ResponseWriter, *http.Request)) *serveFixture {
	t.Helper()
	dir := t.TempDir()
	f := &serveFixture{started: filepath.Join(dir, "started"), quit: filepath.Join(dir, "quit"), exit: filepath.Join(dir, "exit")}
	script := fmt.Sprintf("#!/bin/sh\ntrap 'echo SIGQUIT > %q; exit 0' QUIT\necho $$ >> %q\nwhile :; do if [ -f %q ]; then exit 0; fi; sleep 0.1; done\n", f.quit, f.started, f.exit)
	if err := os.WriteFile(filepath.Join(dir, "nginx"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	t.Setenv("PVC_UID", "original-pvc")
	token := filepath.Join(dir, "token")
	if err := os.WriteFile(token, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		respond(f.phase.Load(), w, r)
	}))
	t.Cleanup(server.Close)
	f.guard = &admission{client: server.Client(), url: server.URL + "/app", pvcURL: server.URL + "/pvc/", uid: "application", mode: "serve", generation: 4, tokenFile: token}
	return f
}

func startServeFixture(t *testing.T, f *serveFixture) <-chan error {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	finished := make(chan struct{})
	go func() {
		done <- serve(ctx, f.guard)
		close(finished)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Error("endpoint child did not stop during cleanup")
		}
	})
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.After(5 * time.Second)
	for {
		if _, err := os.Stat(f.started); err == nil {
			return done
		}
		select {
		case err := <-done:
			t.Fatalf("endpoint exited before startup: %v", err)
		case <-deadline:
			t.Fatal("endpoint did not start")
		case <-ticker.C:
		}
	}
}

func requireServeRevoked(t *testing.T, f *serveFixture, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if !errors.Is(err, errAdmissionRevoked) {
			t.Fatalf("endpoint exit did not report observed revocation: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("endpoint kept running after revocation")
	}
	signal, err := os.ReadFile(f.quit)
	if err != nil || string(signal) != "SIGQUIT\n" {
		t.Fatalf("graceful quit not observed: %q %v", signal, err)
	}
}

func TestServeRevocationStopsRunningProcess(t *testing.T) {
	for _, reason := range []string{"stop", "claim ownership", "failed application with revoked PVC", "revoked application with failed PVC", "Kubernetes NotFound"} {
		t.Run(reason, func(t *testing.T) {
			f := newServeFixture(t, func(phase int32, w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/app" {
					if phase > 0 && reason == "failed application with revoked PVC" {
						w.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					app := admittedApplication("serve")
					app.Status.State = "Starting"
					if phase > 0 && (reason == "stop" || reason == "revoked application with failed PVC") {
						app.Spec.Running = false
					}
					json.NewEncoder(w).Encode(app)
					return
				}
				if phase > 0 && reason == "revoked application with failed PVC" {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				if phase > 0 && reason == "Kubernetes NotFound" {
					w.WriteHeader(http.StatusNotFound)
					w.Write([]byte(`{"kind":"Status","apiVersion":"v1","reason":"NotFound","code":404}`))
					return
				}
				pvc := admittedPVC()
				if phase > 0 && (reason == "claim ownership" || reason == "failed application with revoked PVC") {
					delete(pvc["metadata"].(map[string]any), "annotations")
				}
				json.NewEncoder(w).Encode(pvc)
			})
			done := startServeFixture(t, f)
			f.phase.Store(1)
			requireServeRevoked(t, f, done)
		})
	}
}

func TestServeRetainsSameProcessDuringUnavailableObservation(t *testing.T) {
	for _, failure := range []string{"503", "timeout", "malformed", "incomplete identity", "proxy 404"} {
		t.Run(failure, func(t *testing.T) {
			var outageChecks atomic.Int32
			twoCompleted := make(chan struct{})
			f := newServeFixture(t, func(phase int32, w http.ResponseWriter, r *http.Request) {
				if phase == 1 {
					// Reaching the third application poll proves two full prior checks
					// finished without cancelling or replacing the child process.
					if r.URL.Path == "/app" && outageChecks.Add(1) == 3 {
						close(twoCompleted)
					}
					switch failure {
					case "503":
						w.WriteHeader(http.StatusServiceUnavailable)
					case "timeout":
						<-r.Context().Done()
					case "malformed":
						w.Write([]byte("{"))
					case "incomplete identity":
						w.Write([]byte(`{"metadata":{}}`))
					case "proxy 404":
						http.NotFound(w, r)
					}
					return
				}
				if r.URL.Path == "/app" {
					app := admittedApplication("serve")
					if phase == 2 {
						app.Spec.Running = false
					}
					json.NewEncoder(w).Encode(app)
					return
				}
				json.NewEncoder(w).Encode(admittedPVC())
			})
			f.guard.client.Timeout = 100 * time.Millisecond
			done := startServeFixture(t, f)
			pid, err := os.ReadFile(f.started)
			if err != nil {
				t.Fatal(err)
			}
			f.phase.Store(1)
			select {
			case <-twoCompleted:
			case err := <-done:
				t.Fatalf("endpoint stopped during unavailable observation: %v", err)
			case <-time.After(6 * time.Second):
				t.Fatal("endpoint did not retry unavailable observations")
			}
			if current, err := os.ReadFile(f.started); err != nil || string(current) != string(pid) {
				t.Fatalf("endpoint child replaced during outage: %q, was %q: %v", current, pid, err)
			}
			if _, err := os.Stat(f.quit); !os.IsNotExist(err) {
				t.Fatalf("endpoint received SIGQUIT during outage: %v", err)
			}
			f.phase.Store(2)
			requireServeRevoked(t, f, done)
		})
	}
}

func TestServeRefusesUnavailableObservationBeforeStartingProcess(t *testing.T) {
	for _, object := range []string{"application", "PVC"} {
		t.Run(object, func(t *testing.T) {
			f := newServeFixture(t, func(_ int32, w http.ResponseWriter, r *http.Request) {
				if (r.URL.Path == "/app") == (object == "application") {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				if r.URL.Path == "/app" {
					json.NewEncoder(w).Encode(admittedApplication("serve"))
				} else {
					json.NewEncoder(w).Encode(admittedPVC())
				}
			})
			if err := serve(context.Background(), f.guard); err == nil {
				t.Fatal("new endpoint admitted without fresh positive observations")
			}
			if _, err := os.Stat(f.started); !os.IsNotExist(err) {
				t.Fatalf("endpoint started without verified admission: %v", err)
			}
		})
	}
}

func TestServeDoesNotReuseAdmissionAfterProcessEndsDuringOutage(t *testing.T) {
	f := newServeFixture(t, func(phase int32, w http.ResponseWriter, r *http.Request) {
		if phase > 0 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if r.URL.Path == "/app" {
			json.NewEncoder(w).Encode(admittedApplication("serve"))
		} else {
			json.NewEncoder(w).Encode(admittedPVC())
		}
	})
	done := startServeFixture(t, f)
	pid, err := os.ReadFile(f.started)
	if err != nil {
		t.Fatal(err)
	}
	f.phase.Store(1)
	if err := os.WriteFile(f.exit, nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("normal child exit failed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("endpoint did not return after child exited")
	}
	if err := serve(context.Background(), f.guard); err == nil {
		t.Fatal("new child reused admission from the ended process")
	}
	if current, err := os.ReadFile(f.started); err != nil || string(current) != string(pid) {
		t.Fatalf("endpoint restarted during outage: %q, was %q: %v", current, pid, err)
	}
}

func TestServeRefusesReplacedClaimBeforeStartingProcess(t *testing.T) {
	f := newServeFixture(t, func(_ int32, w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app" {
			json.NewEncoder(w).Encode(admittedApplication("serve"))
			return
		}
		pvc := admittedPVC()
		pvc["metadata"].(map[string]any)["uid"] = "replacement"
		json.NewEncoder(w).Encode(pvc)
	})
	if err := serve(context.Background(), f.guard); err == nil {
		t.Fatal("replacement claim admitted")
	}
	if _, err := os.Stat(f.started); !os.IsNotExist(err) {
		t.Fatalf("endpoint process started on unverified target: %v", err)
	}
}
