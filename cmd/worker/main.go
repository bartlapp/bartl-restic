package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"

	"github.com/bartlapp/bartl-restic/internal/native"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: bartl-restic-worker lifecycle|replicate --config FILE | serve")
		os.Exit(2)
	}
	flags := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	path := flags.String("config", "/config/config.json", "mounted operation configuration")
	flags.Parse(os.Args[2:])
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	if os.Args[1] == "serve" {
		if err := native.Serve(ctx); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	result, err := native.Run(ctx, os.Args[1], *path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() > 0 {
			os.Exit(exit.ExitCode())
		}
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
