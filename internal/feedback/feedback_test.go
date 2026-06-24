package feedback

import (
	"strings"
	"testing"

	"github.com/evansolomon/factory/internal/task"
)

func TestRenderTerminalFeedback(t *testing.T) {
	lines := RenderTerminalFeedback(strings.Join([]string{
		"## Summary",
		"",
		"Changed the completion path.",
		"",
		"## What to verify next",
		"",
		"- `go test ./...` already passed.",
	}, "\n"), "task-1")
	want := []string{
		"## Summary",
		"",
		"Changed the completion path.",
		"",
		"## What to verify next",
		"",
		"- `go test ./...` already passed.",
		"",
		"detail: factory show task-1",
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Fatalf("unexpected lines:\n%s", strings.Join(lines, "\n"))
	}
}

func TestRenderTerminalFeedbackClipsLongOutput(t *testing.T) {
	var lines []string
	for i := 0; i < 45; i++ {
		lines = append(lines, "line")
	}
	rendered := RenderTerminalFeedback(strings.Join(lines, "\n"), "long-task")
	if !contains(rendered, "[handoff clipped; run factory show long-task for the full artifact]") {
		t.Fatalf("expected clipped marker, got %#v", rendered)
	}
	if rendered[len(rendered)-1] != "detail: factory show long-task" {
		t.Fatalf("unexpected final line: %q", rendered[len(rendered)-1])
	}
	if len(rendered) > 43 {
		t.Fatalf("expected clipped line count, got %d", len(rendered))
	}
}

func TestDecideRoute(t *testing.T) {
	tests := []struct {
		name string
		in   RouteInput
		want Route
	}{
		{name: "done", in: routeInput("done"), want: Route{Kind: "follow-up"}},
		{name: "committed", in: RouteInput{Status: "retrying", HasCommit: true, HasWorktreeDiff: true}, want: Route{Kind: "follow-up"}},
		{name: "needs input", in: routeInput("needs-input"), want: Route{Kind: "reject", Message: "task is waiting for answers; use factory answer"}},
		{name: "fresh ready", in: routeInput("ready"), want: Route{Kind: "reject", Message: "task has no progress to give feedback on; use factory add for new work"}},
		{name: "ready with diff", in: RouteInput{Status: "ready", HasWorktreeDiff: true}, want: Route{Kind: "resume"}},
		{name: "blocked with plan", in: RouteInput{Status: "blocked", HasPlan: true}, want: Route{Kind: "resume"}},
		{name: "retrying with diff", in: RouteInput{Status: "retrying", HasWorktreeDiff: true}, want: Route{Kind: "resume"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := DecideRoute(tt.in)
			if got != tt.want {
				t.Fatalf("got %+v want %+v", got, tt.want)
			}
		})
	}
}

func TestLatestTarget(t *testing.T) {
	fresh := testTask("fresh", "2026-01-03T00:00:00Z", "ready")
	eligible := testTask("eligible", "2026-01-02T00:00:00Z", "ready")
	needsInput := testTask("needs-input", "2026-01-04T00:00:00Z", "needs-input")

	target := LatestTarget([]task.Task{eligible, fresh, needsInput}, func(candidate task.Task) RouteInput {
		return RouteInput{
			Status:  candidate.Meta.Status,
			HasPlan: candidate.ID == eligible.ID,
		}
	})
	if target == nil || target.ID != "eligible" {
		t.Fatalf("unexpected target: %+v", target)
	}
}

func TestFollowUpIntent(t *testing.T) {
	verify := "go test ./..."
	commit := "abc1234"
	source := testTask("fix-layout", "2026-01-01T00:00:00Z", "done")
	source.Dir = "/tmp/factory/tasks/fix-layout"
	source.Meta.Commit = &commit
	source.Meta.Verify = &verify

	intent := FollowUpIntent(source, "The mobile button wraps badly.")
	for _, want := range []string{
		"Address feedback on fix-layout",
		"- id: fix-layout",
		"- commit: abc1234",
		"- task dir: /tmp/factory/tasks/fix-layout",
		"- inspect: factory show fix-layout",
		"- verify: go test ./...",
		"The mobile button wraps badly.",
	} {
		if !strings.Contains(intent, want) {
			t.Fatalf("expected %q in intent:\n%s", want, intent)
		}
	}
}

func routeInput(status string) RouteInput {
	return RouteInput{Status: status}
}

func testTask(id string, updatedAt string, status string) task.Task {
	return task.Task{
		ID:  id,
		Dir: "/tmp/factory/tasks/" + id,
		Meta: task.Meta{
			ID:        id,
			Slug:      id,
			Status:    status,
			CreatedAt: "2026-01-01T00:00:00Z",
			UpdatedAt: &updatedAt,
			Sharpen:   "done",
		},
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
