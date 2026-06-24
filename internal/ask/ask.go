package ask

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/evansolomon/factory/internal/agents"
	"github.com/evansolomon/factory/internal/config"
	"github.com/evansolomon/factory/internal/task"
)

const ArtifactLimit = 8000
const LogTailLimit = 8000
const FailureTailLines = 8
const DetailedTaskLimit = 4

const NonTTYMessage = "factory ask is interactive and needs a terminal. For a scriptable one-shot answer use: factory ask --print [task-id] <question...>"

type Request struct {
	Mode     string
	TaskID   string
	Question string
}

type TranscriptTurn struct {
	Question string
	Answer   string
}

type AnswerResult struct {
	Answer          string
	SelectedTaskIDs []string
}

type Runner func(agent config.Agent, root string, prompt string, access agents.Access) (string, error)

type Options struct {
	Context        config.WorkContext
	Question       string
	TaskID         string
	Transcript     []TranscriptTurn
	CarriedTaskIDs []string
	Runner         Runner
}

func ParseRequest(args []string, tasks []task.Task) Request {
	mode := "session"
	rest := args
	if len(args) > 0 && args[0] == "--print" {
		mode = "print"
		rest = args[1:]
	}
	if len(rest) == 0 {
		return Request{Mode: mode}
	}
	first := rest[0]
	for _, candidate := range tasks {
		if candidate.ID == first || strings.Contains(candidate.ID, first) {
			return Request{Mode: mode, TaskID: candidate.ID, Question: strings.TrimSpace(strings.Join(rest[1:], " "))}
		}
	}
	return Request{Mode: mode, Question: strings.TrimSpace(strings.Join(rest, " "))}
}

func Answer(opts Options) (AnswerResult, error) {
	tasks, err := task.LoadAll(opts.Context)
	if err != nil {
		return AnswerResult{}, err
	}
	tasks = SortForAsk(tasks)
	if len(tasks) == 0 {
		return AnswerResult{}, errors.New("no tasks in this worktree")
	}
	var scoped *task.Task
	if opts.TaskID != "" {
		for i := range tasks {
			if tasks[i].ID == opts.TaskID {
				scoped = &tasks[i]
				break
			}
		}
		if scoped == nil {
			return AnswerResult{}, fmt.Errorf("task %s is no longer in this worktree", opts.TaskID)
		}
	}
	selectionQuestion := strings.TrimSpace(opts.Question + "\n" + priorQuestions(opts.Transcript))
	selected := selectDetailedTasks(selectionQuestion, tasks, scoped, opts.CarriedTaskIDs)
	var detailed []string
	for _, item := range selected {
		parts, err := taskArtifacts(item)
		if err != nil {
			return AnswerResult{}, err
		}
		detailed = append(detailed, parts...)
	}
	runner := opts.Runner
	if runner == nil {
		runner = func(agent config.Agent, root string, prompt string, access agents.Access) (string, error) {
			return agents.Run(agent, root, prompt, access, "")
		}
	}
	text, err := runner(
		opts.Context.AskAgent,
		opts.Context.Root,
		BuildPrompt(opts.Question, opts.Context, tasks, detailed, opts.Transcript),
		agents.AccessRead,
	)
	if err != nil {
		return AnswerResult{}, err
	}
	answer := strings.TrimSpace(text)
	if answer == "" {
		answer = "(no answer)"
	}
	ids := make([]string, 0, len(selected))
	for _, item := range selected {
		ids = append(ids, item.ID)
	}
	return AnswerResult{Answer: answer, SelectedTaskIDs: ids}, nil
}

func SortForAsk(tasks []task.Task) []task.Task {
	out := append([]task.Task(nil), tasks...)
	sort.Slice(out, func(i, j int) bool {
		ri := rank(out[i].Meta.Status)
		rj := rank(out[j].Meta.Status)
		if ri != rj {
			return ri < rj
		}
		return stamp(out[i]) > stamp(out[j])
	})
	return out
}

func BuildPrompt(question string, ctx config.WorkContext, tasks []task.Task, detailed []string, transcript []TranscriptTurn) string {
	taskIndex := "(no tasks)"
	if len(tasks) > 0 {
		lines := make([]string, 0, len(tasks))
		for _, item := range tasks {
			lines = append(lines, taskLine(item))
		}
		taskIndex = strings.Join(lines, "\n")
	}
	artifacts := "(no artifacts selected)"
	if len(detailed) > 0 {
		artifacts = strings.Join(detailed, "\n\n")
	}
	conversation := ""
	transcriptRules := ""
	if len(transcript) > 0 {
		conversation = "\nConversation history (live session memory, not saved evidence):\n" + formatTranscript(transcript) + "\n"
		transcriptRules = `
- Use the conversation history only to resolve references like "why?", "that one", or "the second issue".
- Answer factual questions only from the current task index and selected artifact excerpts.
- If the conversation history conflicts with current saved state, current saved state wins.`
	}
	return fmt.Sprintf(`You are answering a question about factory's saved task state.
%s
User question:
%s

Rules:
- Answer only from the provided context.
- Do not run commands, inspect extra files, edit files, use git, run tests, or access the network.
- If the context does not prove the answer, say what is missing.%s
- Prefer direct facts over speculation.
- Include task ids and artifact names when relevant.
- Keep the answer concise.
- End with the next useful factory command if one exists.

Factory context:
- worktree: %s
- stateDir: %s
- tasksDir: %s
- onComplete: %s

Task index, ordered by likely relevance:
%s

Selected artifact excerpts:
%s
`, conversation, question, transcriptRules, ctx.Root, ctx.StateDir, ctx.TasksDir, onCompleteLabel(ctx), taskIndex, artifacts)
}

func selectDetailedTasks(question string, tasks []task.Task, explicit *task.Task, carriedTaskIDs []string) []task.Task {
	if explicit != nil {
		return []task.Task{*explicit}
	}
	var selected []task.Task
	addOnce := func(item task.Task) {
		for _, existing := range selected {
			if existing.ID == item.ID {
				return
			}
		}
		selected = append(selected, item)
	}
	for _, id := range carriedTaskIDs {
		for _, item := range tasks {
			if item.ID == id {
				addOnce(item)
				break
			}
		}
	}
	for _, item := range tasks {
		if len(selected) >= DetailedTaskLimit {
			break
		}
		addOnce(item)
	}
	deliveryQuestion := regexp.MustCompile(`(?i)\b(ship|shipped|shipping|deliver|delivered|push|pushed|pr|mr)\b`).MatchString(question)
	if deliveryQuestion {
		for _, item := range tasks {
			if len(selected) >= DetailedTaskLimit {
				break
			}
			if item.Meta.Status == "shipping" || item.Meta.Status == "retrying" || item.Meta.Status == "done" || hasArtifact(item, "ship.md") || hasArtifact(item, "proof.md") {
				addOnce(item)
			}
		}
	}
	if len(selected) > DetailedTaskLimit {
		return selected[:DetailedTaskLimit]
	}
	return selected
}

func taskArtifacts(item task.Task) ([]string, error) {
	data, err := json.MarshalIndent(item.Meta, "", "  ")
	if err != nil {
		return nil, err
	}
	out := []string{fmt.Sprintf("### %s/meta.json\n%s", item.ID, string(data))}
	names := []string{
		"task.md",
		"questions.md",
		"answers.md",
		"feedback.md",
		"agent-session.summary.md",
		"human-feedback.md",
		"human-feedback.analysis.md",
		"plan.final.md",
		"consolidated.md",
		"postmortem.md",
		"proof.md",
		"ship.md",
		"verify.log",
	}
	for _, name := range names {
		text, err := artifact(item, name)
		if err != nil {
			return nil, err
		}
		if text != "" {
			out = append(out, text)
		}
	}
	failureText, err := failures(item)
	if err != nil {
		return nil, err
	}
	if failureText != "" {
		out = append(out, failureText)
	}
	return out, nil
}

func artifact(item task.Task, name string) (string, error) {
	text, err := fileText(item, name)
	if err != nil || text == "" {
		return "", err
	}
	clipped := head(text, ArtifactLimit)
	if strings.HasSuffix(name, ".log") || strings.HasSuffix(name, ".jsonl") {
		clipped = tail(text, LogTailLimit)
	}
	return fmt.Sprintf("### %s/%s\n%s", item.ID, name, clipped), nil
}

func failures(item task.Task) (string, error) {
	text, err := fileText(item, "failures.jsonl")
	if err != nil || text == "" {
		return "", err
	}
	lines := strings.Split(text, "\n")
	var nonempty []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			nonempty = append(nonempty, line)
		}
	}
	if len(nonempty) == 0 {
		return "", nil
	}
	if len(nonempty) > FailureTailLines {
		nonempty = nonempty[len(nonempty)-FailureTailLines:]
	}
	return fmt.Sprintf("### %s/failures.jsonl (last %d)\n%s", item.ID, len(nonempty), strings.Join(nonempty, "\n")), nil
}

func fileText(item task.Task, name string) (string, error) {
	data, err := os.ReadFile(filepath.Join(item.Dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func hasArtifact(item task.Task, name string) bool {
	info, err := os.Stat(filepath.Join(item.Dir, name))
	return err == nil && !info.IsDir()
}

func head(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return fmt.Sprintf("%s\n[truncated after %d chars]", text[:limit], limit)
}

func tail(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return fmt.Sprintf("[truncated to last %d chars]\n%s", limit, text[len(text)-limit:])
}

func priorQuestions(transcript []TranscriptTurn) string {
	questions := make([]string, 0, len(transcript))
	for _, turn := range transcript {
		questions = append(questions, turn.Question)
	}
	return strings.Join(questions, "\n")
}

func formatTranscript(transcript []TranscriptTurn) string {
	lines := make([]string, 0, len(transcript))
	for _, turn := range transcript {
		lines = append(lines, fmt.Sprintf("Human: %s\nAssistant: %s", turn.Question, turn.Answer))
	}
	return strings.Join(lines, "\n\n")
}

func taskLine(item task.Task) string {
	meta := item.Meta
	parts := []string{
		"id=" + meta.ID,
		"status=" + meta.Status,
		"updatedAt=" + value(meta.UpdatedAt, "(unset)"),
		"verify=" + value(meta.Verify, "(none)"),
	}
	if meta.Note != nil && *meta.Note != "" {
		parts = append(parts, "note="+*meta.Note)
	}
	if meta.Commit != nil && *meta.Commit != "" {
		parts = append(parts, "commit="+*meta.Commit)
	}
	if meta.RetryAt != nil && *meta.RetryAt != "" {
		parts = append(parts, "retryAt="+*meta.RetryAt)
	}
	if meta.AutoRetries > 0 {
		parts = append(parts, fmt.Sprintf("autoRetries=%d", meta.AutoRetries))
	}
	return "- " + strings.Join(parts, " - ")
}

func onCompleteLabel(ctx config.WorkContext) string {
	if ctx.Config.OnComplete == nil {
		return "disabled"
	}
	if ctx.Config.OnComplete.Skill != "" {
		return "skill:" + ctx.Config.OnComplete.Skill
	}
	return "policy:" + ctx.Config.OnComplete.Policy
}

func stamp(item task.Task) string {
	if item.Meta.UpdatedAt != nil {
		return *item.Meta.UpdatedAt
	}
	return item.Meta.CreatedAt
}

func rank(status string) int {
	switch status {
	case "blocked":
		return 0
	case "needs-input":
		return 1
	case "planning", "implementing", "reviewing", "verifying", "shipping":
		return 2
	case "retrying":
		return 3
	case "ready":
		return 4
	case "done":
		return 5
	case "sharpening", "grilling":
		return 6
	default:
		return 7
	}
}

func value(ptr *string, fallback string) string {
	if ptr == nil || *ptr == "" {
		return fallback
	}
	return *ptr
}
