package session

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/evansolomon/factory/internal/config"
	"github.com/evansolomon/factory/internal/task"
)

const SummaryArtifact = "agent-session.summary.md"
const HandoffArtifact = "agent-session.md"

var artifactOrder = []string{
	"task.md",
	"meta.json",
	"feedback.md",
	"human-feedback.md",
	"plan.md",
	"plan.final.md",
	"risk.plan.md",
	"implement.log.md",
	"diff.patch",
	"review.md",
	"security.md",
	"risk.md",
	"deploy.md",
	"ux.md",
	"consolidated.md",
	"failures.jsonl",
	"verify.log",
	"proof.md",
	"postmortem.md",
	"ship.md",
}

type Request struct {
	Agent     string
	TaskQuery string
}

type Handoff struct {
	Artifact    string
	SummaryPath string
	Content     string
}

func ParseArgs(args []string, defaultAgent string) (Request, error) {
	agent := defaultAgent
	var positional []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--agent":
			if i+1 >= len(args) {
				return Request{}, fmt.Errorf("usage: factory session [--agent codex|claude] [task-id]")
			}
			parsed := parseAgent(args[i+1])
			if parsed == "" {
				return Request{}, fmt.Errorf("unknown agent %q (expected codex or claude)", args[i+1])
			}
			agent = parsed
			i++
		case strings.HasPrefix(arg, "--agent="):
			value := strings.TrimPrefix(arg, "--agent=")
			parsed := parseAgent(value)
			if parsed == "" {
				return Request{}, fmt.Errorf("unknown agent %q", value)
			}
			agent = parsed
		case strings.HasPrefix(arg, "--"):
			return Request{}, fmt.Errorf("unknown option %s", arg)
		default:
			positional = append(positional, arg)
		}
	}
	if len(positional) > 1 {
		return Request{}, fmt.Errorf("usage: factory session [--agent codex|claude] [task-id]")
	}
	parsed := parseAgent(agent)
	if parsed == "" {
		return Request{}, fmt.Errorf("unknown agent %q (expected codex or claude)", agent)
	}
	query := ""
	if len(positional) == 1 {
		query = positional[0]
	}
	return Request{Agent: parsed, TaskQuery: query}, nil
}

func BuildHandoff(ctx config.WorkContext, item task.Task, agent string, now time.Time) (Handoff, error) {
	summaryPath, err := filepath.Abs(filepath.Join(item.Dir, SummaryArtifact))
	if err != nil {
		return Handoff{}, err
	}
	artifactPath, err := filepath.Abs(filepath.Join(item.Dir, HandoffArtifact))
	if err != nil {
		return Handoff{}, err
	}
	taskDir, err := filepath.Abs(item.Dir)
	if err != nil {
		return Handoff{}, err
	}
	names, err := existingArtifactNames(item)
	if err != nil {
		return Handoff{}, err
	}
	references := "(no task artifacts found)"
	if len(names) > 0 {
		lines := make([]string, 0, len(names))
		for _, name := range names {
			lines = append(lines, fmt.Sprintf("- %s: %s", name, filepath.Join(taskDir, name)))
		}
		references = strings.Join(lines, "\n")
	}
	verify := "(none)"
	if item.Meta.Verify != nil {
		verify = *item.Meta.Verify
	}
	commit := "(none)"
	if item.Meta.Commit != nil {
		commit = *item.Meta.Commit
	}
	content := fmt.Sprintf(`# Agent Session Handoff

Generated: %s

## Task
- id: %s
- status: %s
- agent: %s
- commit: %s
- verify: %s
- task dir: %s
- worktree: %s

## References
%s

## Factory Commands
- show task: factory show %s
- ask saved state: factory ask %s
- record follow-up feedback: factory feedback %s --edit

## Session Instructions
- Start by reading this handoff and the referenced artifacts that are relevant.
- Work with the human interactively on small follow-up tweaks.
- Do not commit unless the human explicitly asks.
- Before ending, append a concise summary to %s.

Suggested summary sections:
- What changed
- Files touched
- Checks run and results
- Remaining follow-up
- Anything factory should consume later
`, now.UTC().Format(time.RFC3339Nano), item.ID, item.Meta.Status, agent, commit, verify, taskDir, ctx.Root, references, item.ID, item.ID, item.ID, summaryPath)
	if err := task.WriteArtifact(item, HandoffArtifact, content); err != nil {
		return Handoff{}, err
	}
	return Handoff{Artifact: artifactPath, SummaryPath: summaryPath, Content: content}, nil
}

func Prompt(taskID string, handoffPath string, summaryPath string) string {
	return fmt.Sprintf(`You are taking over after factory task %s.

Read this handoff first:
%s

Use the referenced factory artifacts as context.
Work interactively with the human on follow-up tweaks.
Keep the scope narrow. Do not commit unless the human explicitly asks.

Before ending the session, append a concise summary to:
%s
`, taskID, handoffPath, summaryPath)
}

func Command(agent string, root string, taskID string, handoffPath string, summaryPath string) []string {
	prompt := Prompt(taskID, handoffPath, summaryPath)
	if agent == "codex" {
		return []string{"codex", "-C", root, "-s", "workspace-write", "-a", "on-request", prompt}
	}
	return []string{"claude", "--add-dir", root, "--permission-mode", "default", prompt}
}

func TargetTask(ctx config.WorkContext, query string) (*task.Task, error) {
	if query != "" {
		return task.Find(ctx, query)
	}
	return task.Latest(ctx, "done")
}

func existingArtifactNames(item task.Task) ([]string, error) {
	entries, err := os.ReadDir(item.Dir)
	if err != nil {
		return nil, err
	}
	existing := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") || strings.HasSuffix(name, ".tmp") || name == HandoffArtifact || name == SummaryArtifact {
			continue
		}
		existing[name] = true
	}
	var ordered []string
	for _, name := range artifactOrder {
		if existing[name] {
			ordered = append(ordered, name)
			delete(existing, name)
		}
	}
	var extra []string
	for name := range existing {
		if strings.HasSuffix(name, ".md") || strings.HasSuffix(name, ".activity.jsonl") {
			extra = append(extra, name)
		}
	}
	sort.Strings(extra)
	return append(ordered, extra...), nil
}

func parseAgent(value string) string {
	if value == "codex" || value == "claude" {
		return value
	}
	return ""
}
