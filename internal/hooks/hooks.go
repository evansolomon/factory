package hooks

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"time"
)

const timeout = 5 * time.Second

func Emit(root string, configured map[string][]string, event string, payload map[string]string) {
	commands := configured[event]
	if len(commands) == 0 {
		return
	}
	body := map[string]string{"event": event, "root": root}
	for key, value := range payload {
		body[key] = value
	}
	data, err := json.Marshal(body)
	if err != nil {
		warn(event, fmt.Sprintf("marshal payload failed: %s", err))
		return
	}
	for _, command := range commands {
		run(root, event, command, data)
	}
}

func run(root, event, command string, data []byte) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bash", "-lc", command)
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(data)
	cmd.Env = append(os.Environ(), "FACTORY_EVENT="+event, "FACTORY_ROOT="+root)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := stderr.String()
		if detail == "" {
			detail = err.Error()
		}
		warn(event, detail)
	}
}

func warn(event, detail string) {
	fmt.Fprintf(os.Stderr, "hook %s failed: %s\n", event, detail)
}
