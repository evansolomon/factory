package config

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func withFactoryHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("FACTORY_HOME", home)
	return home
}

func TestConfigCascade(t *testing.T) {
	home := withFactoryHome(t)
	base := t.TempDir()
	root := filepath.Join(base, "repo")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(home, "config.json"), map[string]any{
		"retries": 1,
		"hooks": map[string]any{
			"stage.change": []string{"global-stage"},
			"attention":    []string{"global-attention"},
		},
	})
	writeJSON(t, filepath.Join(base, ".factory.json"), map[string]any{
		"retries":  2,
		"security": false,
		"hooks": map[string]any{
			"stage.change": []string{"ancestor-stage"},
		},
	})
	writeJSON(t, filepath.Join(root, ".factory.json"), map[string]any{
		"retries": 3,
		"hooks": map[string]any{
			"stage.change": []string{"worktree-stage", "ancestor-stage"},
			"task.done":    []string{"worktree-done"},
		},
	})

	cfg, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Retries != 3 {
		t.Fatalf("retries = %d", cfg.Retries)
	}
	if cfg.Security {
		t.Fatal("security should be false")
	}
	if got, want := cfg.Hooks["stage.change"], []string{"global-stage", "ancestor-stage", "worktree-stage"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("stage hooks = %#v, want %#v", got, want)
	}
	if got := cfg.Hooks["attention"]; !reflect.DeepEqual(got, []string{"global-attention"}) {
		t.Fatalf("attention hooks = %#v", got)
	}
	if got := cfg.Hooks["task.done"]; !reflect.DeepEqual(got, []string{"worktree-done"}) {
		t.Fatalf("task.done hooks = %#v", got)
	}
}

func TestInvalidJSONConfig(t *testing.T) {
	withFactoryHome(t)
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".factory.json"), []byte("{ bad json"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Load(root)
	if err == nil || !strings.Contains(err.Error(), "invalid JSON config") {
		t.Fatalf("err = %v", err)
	}
}

func TestInvalidHookShape(t *testing.T) {
	withFactoryHome(t)
	root := t.TempDir()
	writeJSON(t, filepath.Join(root, ".factory.json"), map[string]any{
		"hooks": map[string]any{"stage.change": "not an array"},
	})
	_, err := Load(root)
	if err == nil || !strings.Contains(err.Error(), "cannot unmarshal string") {
		t.Fatalf("err = %v", err)
	}
}

func TestAskAgentSeparateFromPipelineAgents(t *testing.T) {
	withFactoryHome(t)
	root := t.TempDir()
	cfg, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Ask.Agent.CLI != "claude" {
		t.Fatalf("ask agent = %s", cfg.Ask.Agent.CLI)
	}
	writeJSON(t, filepath.Join(root, ".factory.json"), map[string]any{
		"agents": map[string]any{"reviewer": "codex"},
		"ask":    map[string]any{"agent": map[string]any{"cli": "codex", "model": "gpt-5"}},
	})
	cfg, err = Load(root)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Agents.Reviewer.CLI != "codex" {
		t.Fatalf("reviewer = %s", cfg.Agents.Reviewer.CLI)
	}
	if cfg.Ask.Agent.CLI != "codex" || cfg.Ask.Agent.Model != "gpt-5" {
		t.Fatalf("ask agent = %#v", cfg.Ask.Agent)
	}
}

func TestDefaultStateDirUnderFactoryHomeSessions(t *testing.T) {
	home := withFactoryHome(t)
	base := t.TempDir()
	root := filepath.Join(base, "repo")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "-C", root, "init").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	ctx, err := LoadContext(root)
	if err != nil {
		t.Fatal(err)
	}
	key := strings.TrimLeft(strings.ReplaceAll(ctx.Root, "/", "-"), "-")
	if got, want := ctx.StateDir, filepath.Join(home, "sessions", key); got != want {
		t.Fatalf("state dir = %q, want %q", got, want)
	}
	if got, want := ctx.TasksDir, filepath.Join(home, "sessions", key, "tasks"); got != want {
		t.Fatalf("tasks dir = %q, want %q", got, want)
	}
}
