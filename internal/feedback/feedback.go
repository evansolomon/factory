package feedback

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/evansolomon/factory/internal/task"
)

const terminalFeedbackMaxLines = 40
const terminalFeedbackMaxChars = 6000

type RouteInput struct {
	Status          string
	HasPlan         bool
	HasWorktreeDiff bool
	HasCommit       bool
	PendingFeedback bool
}

type Route struct {
	Kind    string
	Message string
}

func RenderTerminalFeedback(text string, taskID string) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	clipped := false
	if len(text) > terminalFeedbackMaxChars {
		text = strings.TrimRight(text[:terminalFeedbackMaxChars], " \t\r\n")
		clipped = true
	}
	lines := strings.Split(text, "\n")
	if len(lines) > terminalFeedbackMaxLines {
		lines = lines[:terminalFeedbackMaxLines]
		clipped = true
	}
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	if clipped {
		lines = append(lines, fmt.Sprintf("[handoff clipped; run factory show %s for the full artifact]", taskID))
	}
	return append(lines, "", fmt.Sprintf("detail: factory show %s", taskID))
}

func DecideRoute(input RouteInput) Route {
	if input.Status == "needs-input" {
		return Route{Kind: "reject", Message: "task is waiting for answers; use factory answer"}
	}
	if input.Status == "done" || input.HasCommit {
		return Route{Kind: "follow-up"}
	}
	hasProgress := input.HasPlan || input.HasWorktreeDiff || input.PendingFeedback
	if input.Status == "ready" {
		if hasProgress {
			return Route{Kind: "resume"}
		}
		return Route{Kind: "reject", Message: "task has no progress to give feedback on; use factory add for new work"}
	}
	if input.Status == "blocked" || input.Status == "retrying" {
		if hasProgress {
			return Route{Kind: "resume"}
		}
		return Route{Kind: "reject", Message: "task has no resumable progress to give feedback on"}
	}
	if input.Status == "sharpening" || input.Status == "planning" {
		return Route{Kind: "reject", Message: fmt.Sprintf("task is still %s; wait for progress or use factory add for new work", input.Status)}
	}
	if task.IsStranded(input.Status) {
		return Route{Kind: "reject", Message: fmt.Sprintf("task was interrupted during %s; use factory resume first", input.Status)}
	}
	return Route{Kind: "reject", Message: fmt.Sprintf("task status %s cannot receive feedback yet", input.Status)}
}

func IsDefaultTarget(input RouteInput) bool {
	return DecideRoute(input).Kind != "reject"
}

func LatestTarget(tasks []task.Task, facts func(task.Task) RouteInput) *task.Task {
	var latest *task.Task
	for i := range tasks {
		if !IsDefaultTarget(facts(tasks[i])) {
			continue
		}
		if latest == nil || stamp(tasks[i]) > stamp(*latest) {
			latest = &tasks[i]
		}
	}
	return latest
}

func RouteInputFromTask(item task.Task, hasPlan bool, hasWorktreeDiff bool) RouteInput {
	return RouteInput{
		Status:          item.Meta.Status,
		HasPlan:         hasPlan,
		HasWorktreeDiff: hasWorktreeDiff,
		HasCommit:       item.Meta.Commit != nil,
		PendingFeedback: task.PendingFeedbackCount(item) > 0,
	}
}

func FollowUpIntent(source task.Task, text string) string {
	dir, err := filepath.Abs(source.Dir)
	if err != nil {
		dir = source.Dir
	}
	verify := "(none)"
	if source.Meta.Verify != nil {
		verify = *source.Meta.Verify
	}
	commit := "(none)"
	if source.Meta.Commit != nil {
		commit = *source.Meta.Commit
	}
	return strings.Join([]string{
		fmt.Sprintf("Address feedback on %s", source.ID),
		"",
		"## Source task",
		fmt.Sprintf("- id: %s", source.ID),
		fmt.Sprintf("- commit: %s", commit),
		fmt.Sprintf("- task dir: %s", dir),
		fmt.Sprintf("- inspect: factory show %s", source.ID),
		fmt.Sprintf("- verify: %s", verify),
		"",
		"## Human feedback",
		strings.TrimSpace(text),
	}, "\n")
}

func stamp(item task.Task) string {
	if item.Meta.UpdatedAt != nil {
		return *item.Meta.UpdatedAt
	}
	return item.Meta.CreatedAt
}
