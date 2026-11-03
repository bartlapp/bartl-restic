package native

import (
	"context"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// Serve runs nginx only while the live application owns its verified PVC.
func Serve(ctx context.Context) error {
	guard, err := newAdmission("serve")
	if err != nil {
		return err
	}
	return serve(ctx, guard)
}

func serve(ctx context.Context, guard *admission) error {
	if err := guard.check(ctx); err != nil {
		return err
	}
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	go guard.monitor(ctx, cancel)
	cmd := exec.CommandContext(ctx, "nginx", "-g", "daemon off;")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// nginx's master drains its workers on SIGQUIT; bound an unresponsive child.
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGQUIT) }
	cmd.WaitDelay = 20 * time.Second
	err := cmd.Run()
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	return err
}
