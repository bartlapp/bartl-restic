package native

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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
