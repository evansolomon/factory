package agents

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/evansolomon/factory/internal/config"
	"github.com/evansolomon/factory/internal/executil"
)

type Access string

const (
	AccessRead  Access = "read"
	AccessWrite Access = "write"
	AccessFull  Access = "full"
)

func Label(agent config.Agent) string {
	if agent.Model != "" {
		return agent.CLI + ":" + agent.Model
	}
	return agent.CLI
}

func Run(agent config.Agent, root, prompt string, access Access, outFile string) (string, error) {
	switch agent.CLI {
	case "codex":
		return runCodex(agent, root, prompt, access, outFile)
	case "claude":
		return runClaude(agent, root, prompt, access, outFile)
	default:
		return "", fmt.Errorf("unsupported agent cli %q", agent.CLI)
	}
}

func runCodex(agent config.Agent, root, prompt string, access Access, outFile string) (string, error) {
	out := outFile
	if out == "" {
		out = filepath.Join(os.TempDir(), fmt.Sprintf("factory-codex-%d.md", time.Now().UnixNano()))
		defer os.Remove(out)
	}
	sandbox := "read-only"
	if access == AccessWrite {
		sandbox = "workspace-write"
	}
	if access == AccessFull {
		sandbox = "danger-full-access"
	}
	args := []string{"codex", "exec", "-C", root, "-s", sandbox, "-c", `approval_policy="never"`, "-o", out}
	if agent.Provider != "" {
		args = append(args, "-c", fmt.Sprintf(`model_provider="%s"`, agent.Provider))
	}
	if agent.Model != "" {
		args = append(args, "-m", agent.Model)
	}
	args = append(args, "-")
	res := executil.Run(args, executil.Options{Cwd: root, Stdin: prompt})
	if res.Code != 0 {
		return "", fmt.Errorf("codex exec failed (exit %d): %s%s", res.Code, res.Stderr, res.Stdout)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		return strings.TrimSpace(res.Stdout), nil
	}
	return strings.TrimSpace(string(data)), nil
}

func runClaude(agent config.Agent, root, prompt string, access Access, outFile string) (string, error) {
	args := []string{"claude", "-p", "--add-dir", root, "--permission-mode", "bypassPermissions"}
	if agent.Model != "" {
		args = append(args, "--model", agent.Model)
	}
	if access == AccessRead {
		args = append(args, "--disallowedTools", "Edit", "Write", "NotebookEdit")
	}
	res := executil.Run(args, executil.Options{Cwd: root, Stdin: prompt})
	if res.Code != 0 {
		return "", fmt.Errorf("claude failed (exit %d): %s%s", res.Code, res.Stderr, res.Stdout)
	}
	text := strings.TrimSpace(res.Stdout)
	if outFile != "" {
		if err := os.WriteFile(outFile, []byte(text), 0o644); err != nil {
			return "", err
		}
	}
	return text, nil
}
