// Package native runs finite Restic operations; it never manages Kubernetes workloads.
package native

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

type Remote struct {
	Host                 string `json:"host"`
	Repository           string `json:"repository"`
	CredentialsDirectory string `json:"credentialsDirectory"`
}
type Repository struct {
	Name         string  `json:"name"`
	PasswordFile string  `json:"passwordFile"`
	Recovery     *Remote `json:"recovery,omitempty"`
}
type Replication struct {
	Repository   string `json:"repository"`
	PasswordFile string `json:"passwordFile"`
	Destination  Remote `json:"destination"`
}
type Config struct {
	DataDirectory string       `json:"dataDirectory"`
	Repositories  []Repository `json:"repositories"`
	Replication   *Replication `json:"replication,omitempty"`
}
type Snapshot struct {
	ID       string `json:"id"`
	Original string `json:"original"`
	Tree     string `json:"tree"`
	Time     string `json:"time"`
}
type RepositoryResult struct {
	Name               string     `json:"name"`
	Action             string     `json:"action"`
	RepositoryID       string     `json:"repositoryID"`
	SourceRepositoryID string     `json:"sourceRepositoryID,omitempty"`
	Snapshots          []Snapshot `json:"snapshots"`
}
type Result struct {
	ApplicationUID string             `json:"applicationUID"`
	PVCUID         string             `json:"pvcUID"`
	OperationUID   string             `json:"operationUID"`
	Repositories   []RepositoryResult `json:"repositories,omitempty"`
}

var namePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,56}[a-z0-9])?$`)
var hostPattern = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$`)
var idPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func Run(ctx context.Context, mode, path string) (Result, error) {
	result := Result{ApplicationUID: os.Getenv("APPLICATION_UID"), PVCUID: os.Getenv("PVC_UID"), OperationUID: os.Getenv("OPERATION_UID")}
	if mode != "lifecycle" && mode != "replicate" {
		return result, fmt.Errorf("unknown operation %q", mode)
	}
	if result.ApplicationUID == "" || result.PVCUID == "" || result.OperationUID == "" {
		return result, errors.New("missing execution identity")
	}
	f, err := os.Open(path)
	if err != nil {
		return result, err
	}
	defer f.Close()
	var config Config
	decoder := json.NewDecoder(f)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return result, err
	}
	if !filepath.IsAbs(config.DataDirectory) {
		return result, errors.New("dataDirectory must be absolute")
	}
	guard, err := newAdmission(mode)
	if err != nil {
		return result, err
	}
	if err := guard.check(ctx); err != nil {
		return result, err
	}
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	go guard.monitor(ctx, cancel)
	if mode == "replicate" {
		err = replicate(ctx, config)
	} else {
		result.Repositories, err = lifecycle(ctx, config, result)
	}
	if context.Cause(ctx) != nil {
		return result, context.Cause(ctx)
	}
	if err != nil {
		return result, err
	}
	// Recheck current intent before announcing success, including very short operations.
	if err := guard.check(ctx); err != nil {
		return result, err
	}
	return result, nil
}

type restic struct{ args, env []string }

func localRestic(path, password string) restic {
	return restic{args: []string{"--no-cache", "-r", path, "--password-file", password}}
}
func remoteRestic(remote Remote, role string) (restic, error) {
	if !hostPattern.MatchString(remote.Host) || !namePattern.MatchString(remote.Repository) || !filepath.IsAbs(remote.CredentialsDirectory) {
		return restic{}, errors.New("invalid credential-free HTTPS recovery/destination configuration")
	}
	username, err := os.ReadFile(filepath.Join(remote.CredentialsDirectory, "username"))
	if err != nil {
		return restic{}, err
	}
	if strings.TrimSpace(string(username)) != role {
		return restic{}, fmt.Errorf("remote operation requires %s credentials", role)
	}
	password, err := os.ReadFile(filepath.Join(remote.CredentialsDirectory, "restPassword"))
	if err != nil {
		return restic{}, err
	}
	return restic{args: []string{"--no-cache", "-r", "rest:https://" + remote.Host + "/" + remote.Repository + "/", "--password-file", filepath.Join(remote.CredentialsDirectory, "password"), "--cacert", filepath.Join(remote.CredentialsDirectory, "ca.crt")}, env: []string{"RESTIC_REST_USERNAME=" + role, "RESTIC_REST_PASSWORD=" + string(password)}}, nil
}

// Restic handles SIGINT by cancelling transfers and releasing its native locks.
// WaitDelay bounds a broken child only after the supported graceful path.
func (r restic) run(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "restic", append(append([]string{}, r.args...), args...)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGINT) }
	cmd.WaitDelay = 20 * time.Second
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "RESTIC_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, r.env...)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = os.Stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		return nil, context.Cause(ctx)
	}
	if err != nil {
		return nil, fmt.Errorf("restic %s: %w", args[0], err)
	}
	return stdout.Bytes(), nil
}
func (r restic) repositoryID(ctx context.Context) (string, error) {
	data, err := r.run(ctx, "cat", "config")
	if err != nil {
		return "", err
	}
	var config struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return "", err
	}
	if !idPattern.MatchString(config.ID) {
		return "", errors.New("invalid native repository identity")
	}
	return config.ID, nil
}
func (r restic) snapshots(ctx context.Context) ([]Snapshot, error) {
	// The presentation command `snapshots` can warn and skip unreadable objects
	// while exiting zero. Inventory raw IDs, then require every native object.
	data, err := r.run(ctx, "list", "snapshots")
	if err != nil {
		return nil, err
	}
	ids := strings.Fields(string(data))
	snapshots := make([]Snapshot, 0, len(ids))
	for _, id := range ids {
		if !idPattern.MatchString(id) {
			return nil, errors.New("invalid native snapshot ID in repository listing")
		}
		data, err := r.run(ctx, "cat", "snapshot", id)
		if err != nil {
			return nil, err
		}
		var s Snapshot
		if err := json.Unmarshal(data, &s); err != nil {
			return nil, err
		}
		s.ID = id
		if !idPattern.MatchString(s.Tree) || (s.Original != "" && !idPattern.MatchString(s.Original)) {
			return nil, errors.New("invalid native snapshot identity")
		}
		if _, err := time.Parse(time.RFC3339Nano, s.Time); err != nil {
			return nil, err
		}
		snapshots = append(snapshots, s)
	}
	return snapshots, nil
}

// A missing config is absence only in an empty directory, never in partial state.
func observe(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return false, fmt.Errorf("repository is not a directory: %s", path)
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return false, err
	}
	if len(entries) == 0 {
		return false, nil
	}
	for _, name := range []string{"config", "data", "index", "keys", "locks", "snapshots"} {
		info, err := os.Lstat(filepath.Join(path, name))
		if err != nil {
			return false, fmt.Errorf("damaged repository %s: %w", path, err)
		}
		if name == "config" {
			if !info.Mode().IsRegular() || info.Size() == 0 {
				return false, fmt.Errorf("damaged repository config: %s", path)
			}
		} else if !info.IsDir() {
			return false, fmt.Errorf("damaged repository directory %s/%s", path, name)
		}
	}
	return true, nil
}
func syncDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func beginTransition(directory string, identity Result) error {
	f, err := os.OpenFile(filepath.Join(directory, ".bartl-transition"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("failed/interrupted transition must be inspected, not replayed: %w", err)
	}
	err = json.NewEncoder(f).Encode(identity)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return syncDirectory(directory)
}
func verifyCopies(source, destination []Snapshot) error {
	// Native copy preserves a pre-existing original; it need not equal the immediate source ID.
	copies := make(map[string]bool, len(destination))
	for _, s := range destination {
		copies[s.Original+"/"+s.Tree+"/"+s.Time] = true
	}
	for _, s := range source {
		origin := s.Original
		if origin == "" {
			origin = s.ID
		}
		if !copies[origin+"/"+s.Tree+"/"+s.Time] {
			return fmt.Errorf("retained recovery point %s was not reconstructed", s.ID)
		}
	}
	return nil
}

type plan struct {
	repository Repository
	exists     bool
	source     restic
	sourceID   string
	snapshots  []Snapshot
}

func lifecycle(ctx context.Context, config Config, identity Result) ([]RepositoryResult, error) {
	if len(config.Repositories) == 0 {
		return nil, errors.New("no repositories declared")
	}
	lock, err := os.OpenFile(filepath.Join(config.DataDirectory, ".bartl-lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, fmt.Errorf("another lifecycle owns storage: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	if _, err := os.Lstat(filepath.Join(config.DataDirectory, ".bartl-transition")); !errors.Is(err, os.ErrNotExist) {
		if err != nil {
			return nil, err
		}
		return nil, errors.New("failed/interrupted reconstruction remains stopped; retain diagnostics and replace the failed target")
	}
	seen := make(map[string]bool, len(config.Repositories))
	plans := make([]plan, 0, len(config.Repositories))
	changing := false
	for _, repository := range config.Repositories {
		if !namePattern.MatchString(repository.Name) || seen[repository.Name] || !filepath.IsAbs(repository.PasswordFile) {
			return nil, errors.New("invalid or duplicate repository declaration")
		}
		seen[repository.Name] = true
		exists, err := observe(filepath.Join(config.DataDirectory, repository.Name))
		if err != nil {
			return nil, err
		}
		p := plan{repository: repository, exists: exists}
		if !exists {
			changing = true
			if repository.Recovery != nil {
				p.source, err = remoteRestic(*repository.Recovery, "reader")
				if err == nil {
					p.sourceID, err = p.source.repositoryID(ctx)
				}
				if err == nil {
					p.snapshots, err = p.source.snapshots(ctx)
				}
				if err != nil {
					return nil, fmt.Errorf("recovery observation for %s failed, not absent: %w", repository.Name, err)
				}
			}
		}
		plans = append(plans, p)
	}
	// Reject undeclared local state instead of silently adopting a different installation.
	entries, err := os.ReadDir(config.DataDirectory)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if seen[entry.Name()] || entry.Name() == ".bartl-lock" {
			continue
		}
		if entry.Name() == "lost+found" && entry.IsDir() {
			contents, err := os.ReadDir(filepath.Join(config.DataDirectory, entry.Name()))
			if err == nil && len(contents) == 0 {
				continue
			}
		}
		return nil, fmt.Errorf("undeclared local state %q", entry.Name())
	}
	if changing {
		if err := beginTransition(config.DataDirectory, identity); err != nil {
			return nil, err
		}
	}
	results := make([]RepositoryResult, 0, len(plans))
	for _, p := range plans {
		r := localRestic(filepath.Join(config.DataDirectory, p.repository.Name), p.repository.PasswordFile)
		result := RepositoryResult{Name: p.repository.Name, Action: "existing", SourceRepositoryID: p.sourceID}
		if !p.exists {
			result.Action = "initialized"
			args := []string{"init"}
			if p.repository.Recovery != nil {
				remote := p.repository.Recovery
				r.args = append(r.args, "--cacert", filepath.Join(remote.CredentialsDirectory, "ca.crt"))
				r.env = p.source.env
				args = append(args, "--from-repo", "rest:https://"+remote.Host+"/"+remote.Repository+"/", "--from-password-file", filepath.Join(remote.CredentialsDirectory, "password"), "--copy-chunker-params")
			}
			if _, err := r.run(ctx, args...); err != nil {
				return nil, err
			}
			if len(p.snapshots) > 0 {
				result.Action = "reconstructed"
				remote := p.repository.Recovery
				// Native copy scans history once under its source read lock. Verification
				// below refuses loss of any point observed before initialization.
				if _, err := r.run(ctx, "copy", "--from-repo", "rest:https://"+remote.Host+"/"+remote.Repository+"/", "--from-password-file", filepath.Join(remote.CredentialsDirectory, "password")); err != nil {
					return nil, err
				}
			}
		}
		args := []string{"check"}
		if !p.exists {
			args = append(args, "--read-data")
		}
		if _, err := r.run(ctx, args...); err != nil {
			return nil, err
		}
		result.RepositoryID, err = r.repositoryID(ctx)
		if err != nil {
			return nil, err
		}
		result.Snapshots, err = r.snapshots(ctx)
		if err != nil {
			return nil, err
		}
		if err := verifyCopies(p.snapshots, result.Snapshots); err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	if ctx.Err() != nil {
		return nil, context.Cause(ctx)
	}
	if changing {
		if err := os.Remove(filepath.Join(config.DataDirectory, ".bartl-transition")); err != nil {
			return nil, err
		}
		if err := syncDirectory(config.DataDirectory); err != nil {
			return nil, err
		}
	}
	return results, nil
}
func replicate(ctx context.Context, config Config) error {
	if config.Replication == nil || !namePattern.MatchString(config.Replication.Repository) {
		return errors.New("invalid replication declaration")
	}
	p := config.Replication
	exists, err := observe(filepath.Join(config.DataDirectory, p.Repository))
	if err != nil {
		return err
	}
	if !exists {
		return errors.New("replication source absent; refusing initialization")
	}
	r, err := remoteRestic(p.Destination, "writer")
	if err != nil {
		return err
	}
	output, err := r.run(ctx, "copy", "--from-repo", filepath.Join(config.DataDirectory, p.Repository), "--from-password-file", p.PasswordFile)
	if len(output) > 0 {
		_, _ = io.Copy(os.Stderr, bytes.NewReader(output))
	}
	return err
}
