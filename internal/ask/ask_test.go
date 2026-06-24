package ask

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/evansolomon/factory/internal/agents"
	"github.com/evansolomon/factory/internal/config"
	"github.com/evansolomon/factory/internal/task"
)

func TestParseRequest(t *testing.T) {
	ctx := testContext(t)
	item, err := task.Add(ctx, "Ship the thing", nil, task.AddOptions{})
	if err != nil {
		t.Fatal(err)
	}
	request := ParseRequest([]string{"--print", "ship", "has ship ran?"}, []task.Task{item})
	if request.Mode != "print" || request.TaskID != item.ID || request.Question != "has ship ran?" {
		t.Fatalf("unexpected request: %+v", request)
	}
	request = ParseRequest([]string{"what", "--print", "means"}, []task.Task{item})
	if request.Mode != "session" || request.TaskID != "" || request.Question != "what --print means" {
		t.Fatalf("unexpected request: %+v", request)
	}
}

func TestBuildPrompt(t *testing.T) {
	ctx := testContext(t)
	item, err := task.Add(ctx, "Explain status", nil, task.AddOptions{})
	if err != nil {
		t.Fatal(err)
	}
	prompt := BuildPrompt("what happened?", ctx, []task.Task{item}, nil, nil)
	if !strings.Contains(prompt, "You are answering a question about factory's saved task state.") {
		t.Fatalf("missing intro:\n%s", prompt)
	}
	if !strings.Contains(prompt, "User question:\nwhat happened?") {
		t.Fatalf("missing question:\n%s", prompt)
	}
	if strings.Contains(prompt, "Conversation history") {
		t.Fatalf("unexpected transcript:\n%s", prompt)
	}
	prompt = BuildPrompt("why?", ctx, []task.Task{item}, nil, []TranscriptTurn{{Question: "what failed?", Answer: "verify failed"}})
	if !strings.Contains(prompt, "Conversation history (live session memory, not saved evidence):") {
		t.Fatalf("missing transcript:\n%s", prompt)
	}
	if !strings.Contains(prompt, "current saved state wins") {
		t.Fatalf("missing transcript rule:\n%s", prompt)
	}
}

func TestAnswerUsesReadOnlyRunner(t *testing.T) {
	ctx := testContext(t)
	item, err := task.Add(ctx, "Check ship", nil, task.AddOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var called bool
	result, err := Answer(Options{
		Context:  ctx,
		Question: "has ship ran?",
		Runner: func(agent config.Agent, root string, prompt string, access agents.Access) (string, error) {
			called = true
			if agent.CLI != "claude" {
				t.Fatalf("unexpected agent: %+v", agent)
			}
			if root != ctx.Root {
				t.Fatalf("unexpected root: %s", root)
			}
			if access != agents.AccessRead {
				t.Fatalf("unexpected access: %s", access)
			}
			if !strings.Contains(prompt, "User question:\nhas ship ran?") {
				t.Fatalf("missing question:\n%s", prompt)
			}
			return "  no ship artifact  ", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("runner was not called")
	}
	if result.Answer != "no ship artifact" {
		t.Fatalf("unexpected answer: %q", result.Answer)
	}
	if len(result.SelectedTaskIDs) != 1 || result.SelectedTaskIDs[0] != item.ID {
		t.Fatalf("unexpected selected tasks: %#v", result.SelectedTaskIDs)
	}
}

func TestScopedTaskMissing(t *testing.T) {
	ctx := testContext(t)
	item, err := task.Add(ctx, "Scoped task", nil, task.AddOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(item.Dir); err != nil {
		t.Fatal(err)
	}
	if _, err := task.Add(ctx, "Other task", nil, task.AddOptions{}); err != nil {
		t.Fatal(err)
	}
	_, err = Answer(Options{Context: ctx, Question: "what happened?", TaskID: item.ID})
	if err == nil || !strings.Contains(err.Error(), "is no longer in this worktree") {
		t.Fatalf("unexpected error: %v", err)
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
		Config: config.Config{
			OnComplete: nil,
		},
		AskAgent: config.Agent{CLI: "claude"},
	}
}
