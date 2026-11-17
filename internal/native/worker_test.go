package native

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestObservationNeverConvertsPartialStateToAbsence(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "repository")
	if exists, err := observe(path); err != nil || exists {
		t.Fatalf("missing: %v %v", exists, err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if exists, err := observe(path); err != nil || exists {
		t.Fatalf("empty: %v %v", exists, err)
	}
	if err := os.Mkdir(filepath.Join(path, "snapshots"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := observe(path); err == nil {
		t.Fatal("partial native state became absence")
	}
	if err := os.WriteFile(filepath.Join(path, "config"), []byte("native config"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"data", "index", "keys", "locks"} {
		if err := os.Mkdir(filepath.Join(path, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if exists, err := observe(path); err != nil || !exists {
		t.Fatalf("existing: %v %v", exists, err)
	}
	if err := os.Remove(filepath.Join(path, "config")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(path, "config")); err != nil {
		t.Fatal(err)
	}
	if _, err := observe(path); err == nil {
		t.Fatal("foreign symlink accepted")
	}
}

func TestInterruptedTransitionBlocksNewOperation(t *testing.T) {
	root := t.TempDir()
	identity := Result{ApplicationUID: "old-app", PVCUID: "retained-volume", OperationUID: "old-operation"}
	if err := beginTransition(root, identity); err != nil {
		t.Fatal(err)
	}
	config := Config{DataDirectory: root, Repositories: []Repository{{Name: "alpha", PasswordFile: "/unused/password"}}}
	_, err := lifecycle(context.Background(), config, Result{ApplicationUID: "replacement", OperationUID: "new-operation"})
	if err == nil || !strings.Contains(err.Error(), "interrupted") {
		t.Fatalf("interrupted target not refused: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "alpha")); !os.IsNotExist(err) {
		t.Fatalf("refusal mutated target: %v", err)
	}
}

func TestRetainedHistoryCorrespondence(t *testing.T) {
	original := strings.Repeat("a", 64)
	source := []Snapshot{{ID: strings.Repeat("b", 64), Original: original, Tree: strings.Repeat("c", 64), Time: "2026-11-01T12:00:00Z"}}
	copy := Snapshot{ID: strings.Repeat("d", 64), Original: original, Tree: source[0].Tree, Time: source[0].Time}
	if err := verifyCopies(source, []Snapshot{copy}); err != nil {
		t.Fatalf("multi-hop native identity rejected: %v", err)
	}
	for _, change := range []func(*Snapshot){
		func(s *Snapshot) { s.Original = source[0].ID },
		func(s *Snapshot) { s.Tree = strings.Repeat("e", 64) },
		func(s *Snapshot) { s.Time = "2026-11-02T12:00:00Z" },
	} {
		wrong := copy
		change(&wrong)
		if err := verifyCopies(source, []Snapshot{wrong}); err == nil {
			t.Fatal("non-corresponding history accepted")
		}
	}
	if err := verifyCopies(source, nil); err == nil {
		t.Fatal("missing retained history accepted")
	}
}

func TestIdleLifecycleRetainsStorageSafeguards(t *testing.T) {
	root := t.TempDir()
	config := Config{DataDirectory: root, Repositories: []Repository{}}
	identity := Result{ApplicationUID: "application", PVCUID: "volume", OperationUID: "idle"}
	for i := range 2 {
		results, err := lifecycle(context.Background(), config, identity)
		if err != nil || len(results) != 0 {
			t.Fatalf("idle admission %d: %v %v", i, results, err)
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != ".bartl-lock" {
		t.Fatalf("idle lifecycle created repository state: %v", entries)
	}
	lock, err := os.OpenFile(filepath.Join(root, ".bartl-lock"), os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	if _, err := lifecycle(context.Background(), config, identity); err == nil || !strings.Contains(err.Error(), "another lifecycle") {
		t.Fatalf("idle admission ignored storage owner: %v", err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	if err := beginTransition(root, identity); err != nil {
		t.Fatal(err)
	}
	if _, err := lifecycle(context.Background(), config, identity); err == nil || !strings.Contains(err.Error(), "interrupted") {
		t.Fatalf("idle admission bypassed interrupted transition: %v", err)
	}
}

func TestIdleLifecycleRejectsUndeclaredDataWithoutDeletingIt(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "retained")
	data := []byte("undeclared retained data")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	_, err := lifecycle(context.Background(), Config{DataDirectory: root}, Result{})
	if err == nil || !strings.Contains(err.Error(), "undeclared local state") {
		t.Fatalf("idle admission adopted undeclared data: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(data) {
		t.Fatalf("undeclared data was changed: %q %v", got, err)
	}
}

func TestIdleLifecycleAddsFirstNativeRepository(t *testing.T) {
	if _, err := exec.LookPath("restic"); err != nil {
		t.Skip("requires native restic on PATH")
	}
	root := t.TempDir()
	password := filepath.Join(t.TempDir(), "password")
	if err := os.WriteFile(password, []byte("independent-test-key"), 0600); err != nil {
		t.Fatal(err)
	}
	config := Config{DataDirectory: root, Repositories: []Repository{}}
	identity := Result{ApplicationUID: "application", PVCUID: "volume", OperationUID: "idle"}
	if _, err := lifecycle(context.Background(), config, identity); err != nil {
		t.Fatal(err)
	}
	config.Repositories = []Repository{{Name: "alpha", PasswordFile: password}}
	identity.OperationUID = "first-repository"
	results, err := lifecycle(context.Background(), config, identity)
	if err != nil || len(results) != 1 || results[0].Action != "initialized" || !idPattern.MatchString(results[0].RepositoryID) {
		t.Fatalf("first repository: %+v %v", results, err)
	}
	repositoryID := results[0].RepositoryID
	results, err = lifecycle(context.Background(), config, identity)
	if err != nil || len(results) != 1 || results[0].Action != "existing" || results[0].RepositoryID != repositoryID {
		t.Fatalf("existing repository restart: %+v %v", results, err)
	}
	config.Repositories = nil
	if _, err := lifecycle(context.Background(), config, identity); err == nil || !strings.Contains(err.Error(), "undeclared local state") {
		t.Fatalf("removal silently adopted retained repository: %v", err)
	}
	config.Repositories = []Repository{{Name: "alpha", PasswordFile: password}}
	results, err = lifecycle(context.Background(), config, identity)
	if err != nil || len(results) != 1 || results[0].RepositoryID != repositoryID {
		t.Fatalf("removal destroyed retained repository: %+v %v", results, err)
	}
}
