package executil

import (
	"bytes"
	"context"
	"os/exec"
	"time"
)

type Result struct {
	Stdout string
	Stderr string
	Code   int
}

type Options struct {
	Cwd     string
	Stdin   string
	Timeout time.Duration
}

func Run(argv []string, opts Options) Result {
	ctx := context.Background()
	var cancel context.CancelFunc
	if opts.Timeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, opts.Timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = opts.Cwd
	cmd.Stdin = bytes.NewBufferString(opts.Stdin)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		code = 1
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		}
		if ctx.Err() == context.DeadlineExceeded {
			stderr.WriteString("\ncommand timed out")
		}
	}
	return Result{Stdout: stdout.String(), Stderr: stderr.String(), Code: code}
}

func Shell(cwd, command string, timeout time.Duration) Result {
	return Run([]string{"bash", "-lc", command}, Options{Cwd: cwd, Timeout: timeout})
}
