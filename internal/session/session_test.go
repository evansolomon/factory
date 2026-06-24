package session

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/evansolomon/factory/internal/config"
	"github.com/evansolomon/factory/internal/task"
)

func TestParseArgs(t *testing.T) {
	request, err := ParseArgs([]string{"fix-button"}, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if request.Agent != "codex" || request.TaskQuery != "fix-button" {
		t.Fatalf("unexpected request: %+v", request)
	}
	request, err = ParseArgs([]string{"--agent", "claude"}, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if request.Agent != "claude" || request.TaskQuery != "" {
		t.Fatalf("unexpected request: %+v", request)
	}
}

func TestBuildHandoff(t *testing.T) {
	ctx := testContext(t)
	verify := "go test ./..."
	item, err := task.Add(ctx, "Tweak the completed UI", &verify, task.AddOptions{})
	if err != nil {
		t.Fatal(err)
	}
	item.Meta.Status = "done"
	commit := "abc1234"
	item.Meta.Commit = &commit
	if err := task.SaveMeta(item); err != nil {
		t.Fatal(err)
	}
	if err := task.WriteArtifact(item, "plan.md", "Use the existing component."); err != nil {
		t.Fatal(err)
	}
	if err := task.WriteArtifact(item, "verify.log", "$ go test ./...\npassed"); err != nil {
		t.Fatal(err)
	}
	if err := task.WriteArtifact(item, "implement.activity.jsonl", `{"type":"turn.completed"}`); err != nil {
		t.Fatal(err)
	}
	if err := task.WriteArtifact(item, SummaryArtifact, "Prior summary"); err != nil {
		t.Fatal(err)
	}

	handoff, err := BuildHandoff(ctx, item, "claude", time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if handoff.Artifact != filepath.Join(item.Dir, HandoffArtifact) {
		t.Fatalf("unexpected artifact: %s", handoff.Artifact)
	}
	if handoff.SummaryPath != filepath.Join(item.Dir, SummaryArtifact) {
		t.Fatalf("unexpected summary path: %s", handoff.SummaryPath)
	}
	for _, want := range []string{
		"Generated: 2026-06-22T12:00:00Z",
		"- status: done",
		"- agent: claude",
		"- commit: abc1234",
		"- task.md: " + filepath.Join(item.Dir, "task.md"),
		"- plan.md: " + filepath.Join(item.Dir, "plan.md"),
		"- verify.log: " + filepath.Join(item.Dir, "verify.log"),
		"- implement.activity.jsonl: " + filepath.Join(item.Dir, "implement.activity.jsonl"),
	} {
		if !strings.Contains(handoff.Content, want) {
			t.Fatalf("missing %q in handoff:\n%s", want, handoff.Content)
		}
	}
	if strings.Contains(handoff.Content, SummaryArtifact+":") {
		t.Fatalf("summary artifact should not be listed:\n%s", handoff.Content)
	}
}

func TestCommand(t *testing.T) {
	codex := Command("codex", "/repo", "fix-button", "/state/handoff.md", "/state/summary.md")
	wantPrefix := []string{"codex", "-C", "/repo", "-s", "workspace-write", "-a", "on-request"}
	for i, want := range wantPrefix {
		if codex[i] != want {
			t.Fatalf("codex[%d]=%q want %q", i, codex[i], want)
		}
	}
	if codex[7] != Prompt("fix-button", "/state/handoff.md", "/state/summary.md") {
		t.Fatalf("unexpected codex prompt: %q", codex[7])
	}
	claude := Command("claude", "/repo", "fix-button", "/state/handoff.md", "/state/summary.md")
	wantPrefix = []string{"claude", "--add-dir", "/repo", "--permission-mode", "default"}
	for i, want := range wantPrefix {
		if claude[i] != want {
			t.Fatalf("claude[%d]=%q want %q", i, claude[i], want)
		}
	}
	if claude[5] != Prompt("fix-button", "/state/handoff.md", "/state/summary.md") {
		t.Fatalf("unexpected claude prompt: %q", claude[5])
	}
}

func testContext(t *testing.T) config.WorkContext {
	t.Helper()
	root := t.TempDir()
	state := filepath.Join(root, "state")
	return config.WorkContext{
		Root:     root,
		StateDir: state,
		TasksDir: filepath.Join(state, "tasks"),
	}
}
