package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/evansolomon/factory/internal/addopts"
	askpkg "github.com/evansolomon/factory/internal/ask"
	"github.com/evansolomon/factory/internal/backlog"
	"github.com/evansolomon/factory/internal/conductor"
	"github.com/evansolomon/factory/internal/config"
	"github.com/evansolomon/factory/internal/evals"
	feedbackpkg "github.com/evansolomon/factory/internal/feedback"
	"github.com/evansolomon/factory/internal/gitutil"
	"github.com/evansolomon/factory/internal/hooks"
	"github.com/evansolomon/factory/internal/lessons"
	"github.com/evansolomon/factory/internal/metrics"
	sessionpkg "github.com/evansolomon/factory/internal/session"
	"github.com/evansolomon/factory/internal/task"
	"github.com/evansolomon/factory/internal/upgrade"
)

var version = "0.1.6-go-dev"

type showArtifact struct {
	Name    string
	Heading string
}

var showArtifacts = []showArtifact{
	{Name: "feedback.md", Heading: "## Completion feedback"},
	{Name: "questions.md", Heading: "## Questions"},
	{Name: "answers.md", Heading: "## Answers"},
	{Name: "human-feedback.md", Heading: "## Feedback"},
	{Name: "human-feedback.analysis.md", Heading: "## Feedback analysis (last pass)"},
	{Name: "plan.md", Heading: "## Plan"},
	{Name: "plan.final.md", Heading: "## Final plan"},
	{Name: "implement.md", Heading: "## Implementation"},
	{Name: "review.md", Heading: "## Review"},
	{Name: "consolidated.md", Heading: "## Consolidated review"},
	{Name: "failures.jsonl", Heading: "## Failures"},
	{Name: "verify.log", Heading: "## Verify log"},
	{Name: "proof.md", Heading: "## Proof"},
	{Name: "correction.md", Heading: "## Correction"},
	{Name: "postmortem.md", Heading: "## Postmortem"},
	{Name: "ship.md", Heading: "## Ship"},
	{Name: "agent-session.md", Heading: "## Agent session handoff"},
	{Name: "agent-session.summary.md", Heading: "## Agent session summary"},
}

const help = `factory - a self-improving coding loop.

COMMANDS
  factory add [--raw] [--trivial | --complexity trivial|complex] [intent...] [--verify <cmd...>]
  factory backlog [add|rm] ...
  factory status
  factory answer [task-id] -m <answer>
  factory feedback [task-id] [-m <feedback> | --edit]
  factory resume [task-id] [-m <note>]
  factory correct [task-id] [-m <note> | --edit]
  factory ask [--print] [task-id] <question...>
  factory session [--agent codex|claude] [task-id]
  factory show [task-id]
  factory report
  factory lessons
  factory config
  factory run [--once|--drain]
  factory upgrade
  factory version | --version

Runtime requirement: the codex and claude CLIs on PATH.`

func main() {
	code := run(os.Args[1:], os.Stdout, os.Stderr)
	os.Exit(code)
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		fmt.Fprintln(stdout, help)
		return 0
	}
	if args[0] == "version" || args[0] == "--version" {
		fmt.Fprintln(stdout, version)
		return 0
	}
	if args[0] == "upgrade" {
		return upgradeCommand(stdout, stderr)
	}
	cwd, err := os.Getwd()
	if err != nil {
		return fail(stderr, err)
	}
	if execPath, execErr := os.Executable(); execErr == nil {
		if code, exit := upgrade.MaybeAutoUpgrade(upgrade.AutoOptions{
			Command:        args[0],
			CurrentVersion: version,
			ExecPath:       execPath,
			Cwd:            cwd,
			Stdin:          os.Stdin,
			StdoutFile:     os.Stdout,
			Stdout:         stdout,
			Stderr:         stderr,
			ParentEnv:      os.Environ(),
		}); exit {
			return code
		}
	}
	switch args[0] {
	case "add":
		return add(cwd, args[1:], stdout, stderr)
	case "backlog":
		return backlogCommand(cwd, args[1:], stdout, stderr)
	case "status":
		return status(cwd, stdout, stderr)
	case "show":
		return show(cwd, args[1:], stdout, stderr)
	case "report":
		return report(cwd, stdout, stderr)
	case "answer":
		return answer(cwd, args[1:], stdout, stderr)
	case "feedback":
		return feedback(cwd, args[1:], stdout, stderr)
	case "resume":
		return resume(cwd, args[1:], stdout, stderr)
	case "correct":
		return correct(cwd, args[1:], stdout, stderr)
	case "ask":
		return askCommand(cwd, args[1:], stdout, stderr)
	case "session":
		return agentSession(cwd, args[1:], "codex", "session", stdout, stderr)
	case "codex", "claude":
		return agentSession(cwd, args[1:], args[0], args[0], stdout, stderr)
	case "config":
		return configCommand(cwd, args[1:], stdout, stderr)
	case "lessons":
		return lessonsCommand(cwd, stdout, stderr)
	case "run":
		return runLoop(cwd, args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown command: %s\n", args[0])
		return 1
	}
}

func upgradeCommand(stdout, stderr io.Writer) int {
	execPath, err := os.Executable()
	if err != nil {
		return fail(stderr, err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		return fail(stderr, err)
	}
	return upgrade.Run(upgrade.Options{
		CurrentVersion: version,
		ExecPath:       execPath,
		Cwd:            cwd,
		Stdout:         stdout,
		Stderr:         stderr,
		ParentEnv:      os.Environ(),
	})
}

func add(cwd string, args []string, stdout, stderr io.Writer) int {
	parsed, err := addopts.Parse(args)
	if err != nil {
		return fail(stderr, err)
	}
	intent, verify := parseIntent(parsed.Args)
	if intent == "" {
		return fail(stderr, errors.New("add needs an intent"))
	}
	ctx, err := config.LoadContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	sharpen := "pending"
	if parsed.Raw || parsed.Complexity != "" || !isTerminal(os.Stdin) {
		sharpen = "skipped"
	}
	added, err := task.Add(ctx, intent, verify, task.AddOptions{Sharpen: sharpen, Complexity: parsed.Complexity})
	if err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "queued %s%s\n", added.ID, suffix(verify, parsed.Complexity, sharpen == "pending"))
	return 0
}

func backlogCommand(cwd string, args []string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadRepoContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	if len(args) > 0 && args[0] == "add" {
		intent, verify := parseIntent(drop(args[1:], "--raw"))
		if intent == "" {
			return fail(stderr, errors.New("backlog add needs an intent"))
		}
		entry, err := backlog.Add(ctx, intent, verify)
		if err != nil {
			return fail(stderr, err)
		}
		if verify != nil {
			fmt.Fprintf(stdout, "backlog +%s (verify: %s)\n", entry.ID, *verify)
		} else {
			fmt.Fprintf(stdout, "backlog +%s\n", entry.ID)
		}
		return 0
	}
	if len(args) > 0 && args[0] == "rm" {
		if len(args) < 2 {
			return fail(stderr, errors.New("usage: factory backlog rm <id>"))
		}
		removed, err := backlog.Remove(ctx, args[1])
		if err != nil {
			return fail(stderr, err)
		}
		if removed == nil {
			return fail(stderr, fmt.Errorf("no backlog entry matching %q", args[1]))
		}
		if len(removed.Ambiguous) > 0 {
			ids := make([]string, 0, len(removed.Ambiguous))
			for _, entry := range removed.Ambiguous {
				ids = append(ids, entry.ID)
			}
			return fail(stderr, fmt.Errorf("ambiguous backlog id %q: %s", args[1], strings.Join(ids, ", ")))
		}
		fmt.Fprintf(stdout, "backlog -%s\n", removed.Removed.ID)
		return 0
	}
	entries, err := backlog.Load(ctx)
	if err != nil {
		return fail(stderr, err)
	}
	if len(entries) == 0 {
		fmt.Fprintln(stdout, "backlog empty - add with: factory backlog add \"...\"")
		return 0
	}
	fmt.Fprintf(stdout, "backlog - %d pending\n", len(entries))
	for _, entry := range entries {
		if entry.Verify != nil {
			fmt.Fprintf(stdout, "  %s  (verify: %s)\n", entry.ID, *entry.Verify)
		} else {
			fmt.Fprintf(stdout, "  %s\n", entry.ID)
		}
	}
	return 0
}

func status(cwd string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	tasks, err := task.LoadAll(ctx)
	if err != nil {
		return fail(stderr, err)
	}
	if len(tasks) == 0 {
		fmt.Fprintln(stdout, "no tasks")
		return 0
	}
	counts := map[string]int{}
	for _, item := range tasks {
		counts[item.Meta.Status]++
	}
	order := []string{"ready", "needs-input", "retrying", "blocked", "done", "planning", "implementing", "reviewing", "verifying", "shipping", "sharpening"}
	fmt.Fprintf(stdout, "tasks - %d total\n", len(tasks))
	for _, status := range order {
		if counts[status] > 0 {
			fmt.Fprintf(stdout, "  %s: %d\n", status, counts[status])
		}
	}
	for _, item := range tasks {
		note := ""
		if item.Meta.Note != nil && *item.Meta.Note != "" {
			note = " - " + *item.Meta.Note
		}
		fmt.Fprintf(stdout, "  %s  %s%s\n", item.ID, item.Meta.Status, note)
	}
	return 0
}

func show(cwd string, args []string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	var item *task.Task
	var artifactQuery string
	if len(args) > 0 {
		if len(args) == 1 && isShowArtifactQuery(args[0]) {
			artifactQuery = args[0]
			item, err = task.Latest(ctx)
		} else {
			item, err = task.Find(ctx, args[0])
		}
		if item != nil && len(args) > 1 {
			artifactQuery = args[1]
		}
		if item == nil {
			artifactQuery = args[0]
			item, err = task.Latest(ctx)
		}
	} else {
		item, err = task.Latest(ctx)
	}
	if err != nil {
		return fail(stderr, err)
	}
	if item == nil {
		return fail(stderr, errors.New("no task found"))
	}
	intent, _ := task.ReadIntent(*item)
	if artifactQuery != "" {
		name, text, err := findShowArtifact(*item, artifactQuery)
		if err != nil {
			return fail(stderr, err)
		}
		if text == nil {
			return fail(stderr, fmt.Errorf("no artifact %q for %s", artifactQuery, item.ID))
		}
		fmt.Fprintf(stdout, "## %s/%s\n\n%s\n", item.ID, name, *text)
		return 0
	}
	fmt.Fprintf(stdout, "%s  %s\n", item.ID, item.Meta.Status)
	verify := value(item.Meta.Verify)
	if verify == "" {
		verify = "(none)"
	}
	fmt.Fprintf(stdout, "verify: %s  -  sharpen: %s  -  created %s\n", verify, item.Meta.Sharpen, item.Meta.CreatedAt)
	if item.Meta.Commit != nil {
		fmt.Fprintf(stdout, "commit: %s\n", *item.Meta.Commit)
	}
	if item.Meta.Note != nil && *item.Meta.Note != "" {
		fmt.Fprintf(stdout, "note: %s\n", *item.Meta.Note)
	}
	fmt.Fprintf(stdout, "\n## Task\n\n%s\n", intent)
	for _, entry := range showArtifacts {
		text, err := task.ReadArtifact(*item, entry.Name)
		if err != nil {
			return fail(stderr, err)
		}
		if text == nil || strings.TrimSpace(*text) == "" {
			continue
		}
		fmt.Fprintf(stdout, "\n%s\n\n%s\n", entry.Heading, *text)
	}
	return 0
}

func answer(cwd string, args []string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	usage := "usage: factory answer [task-id] [-m <answer> | --edit]"
	parsed, err := parseInputArgs(args, usage)
	if err != nil {
		return fail(stderr, err)
	}
	var item *task.Task
	if parsed.TaskQuery != "" {
		item, err = task.Find(ctx, parsed.TaskQuery)
	} else {
		item, err = task.Latest(ctx, "needs-input")
	}
	if err != nil {
		return fail(stderr, err)
	}
	if item == nil {
		return fail(stderr, errors.New("no needs-input task to answer"))
	}
	message, ok, err := resolveMessage(parsed, "required")
	if err != nil {
		return fail(stderr, err)
	}
	if !ok {
		return fail(stderr, errors.New(usage))
	}
	if err := task.AppendAnswer(*item, message); err != nil {
		return fail(stderr, err)
	}
	if err := task.SetStatus(item, "ready", nil); err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "%s: answered, back in queue\n", item.ID)
	return 0
}

func feedback(cwd string, args []string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	usage := "usage: factory feedback [task-id] [-m <feedback> | --edit]"
	parsed, err := parseInputArgs(args, usage)
	if err != nil {
		return fail(stderr, err)
	}
	hasDiff := gitutil.HasChanges(ctx.Root)
	var item *task.Task
	if parsed.TaskQuery != "" {
		item, err = task.Find(ctx, parsed.TaskQuery)
	} else {
		items, loadErr := task.LoadAll(ctx)
		if loadErr != nil {
			return fail(stderr, loadErr)
		}
		item = feedbackpkg.LatestTarget(items, func(candidate task.Task) feedbackpkg.RouteInput {
			return feedbackpkg.RouteInputFromTask(candidate, hasSavedPlan(candidate), hasDiff)
		})
	}
	if err != nil {
		return fail(stderr, err)
	}
	if item == nil {
		if parsed.TaskQuery != "" {
			return fail(stderr, fmt.Errorf("no task matching %s", parsed.TaskQuery))
		}
		return fail(stderr, errors.New("no feedback target with existing progress"))
	}
	route := feedbackpkg.DecideRoute(feedbackpkg.RouteInputFromTask(*item, hasSavedPlan(*item), hasDiff))
	if route.Kind == "reject" {
		return fail(stderr, errors.New(route.Message))
	}
	message, ok, err := resolveMessage(parsed, "required")
	if err != nil {
		return fail(stderr, err)
	}
	if !ok {
		return fail(stderr, errors.New(usage))
	}
	if route.Kind == "follow-up" {
		if err := task.AppendFeedback(item, message); err != nil {
			return fail(stderr, err)
		}
		task.MarkFeedbackConsumed(item, item.Meta.FeedbackCount)
		if err := task.SaveMeta(*item); err != nil {
			return fail(stderr, err)
		}
		followUp, err := task.Add(ctx, feedbackpkg.FollowUpIntent(*item, message), item.Meta.Verify, task.AddOptions{
			Sharpen:              "skipped",
			FeedbackSourceTaskID: item.ID,
		})
		if err != nil {
			return fail(stderr, err)
		}
		fmt.Fprintf(stdout, "%s: done - queued follow-up %s for feedback\n", item.ID, followUp.ID)
		return 0
	}
	if err := task.AppendFeedback(item, message); err != nil {
		return fail(stderr, err)
	}
	item.Meta.Resume = true
	kind := "manual"
	item.Meta.ResumeKind = &kind
	item.Meta.ResumeNote = nil
	item.Meta.AutoRetries = 0
	item.Meta.RetryAt = nil
	if err := task.SetStatus(item, "ready", nil); err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "%s: feedback recorded - back in queue\n", item.ID)
	return 0
}

func resume(cwd string, args []string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	usage := "usage: factory resume [task-id] [-m <note> | --edit]"
	parsed, err := parseInputArgs(args, usage)
	if err != nil {
		return fail(stderr, err)
	}
	var item *task.Task
	if parsed.TaskQuery != "" {
		item, err = task.Find(ctx, parsed.TaskQuery)
	} else {
		item, err = task.Latest(ctx, "blocked", "retrying", "planning", "implementing", "reviewing", "verifying", "shipping", "sharpening")
	}
	if err != nil {
		return fail(stderr, err)
	}
	if item == nil {
		return fail(stderr, errors.New("no resumable task"))
	}
	item.Meta.Resume = true
	kind := "manual"
	item.Meta.ResumeKind = &kind
	item.Meta.RetryAt = nil
	message, ok, err := resolveMessage(parsed, "optional")
	if err != nil {
		return fail(stderr, err)
	}
	if ok {
		item.Meta.ResumeNote = &message
	}
	if err := task.SetStatus(item, "ready", nil); err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "%s: resumed, back in queue\n", item.ID)
	return 0
}

func correct(cwd string, args []string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	usage := "usage: factory correct [task-id] [-m <note> | --edit]"
	parsed, err := parseInputArgs(args, usage)
	if err != nil {
		return fail(stderr, err)
	}
	var item *task.Task
	if parsed.TaskQuery != "" {
		item, err = task.Find(ctx, parsed.TaskQuery)
	} else {
		item, err = task.Latest(ctx, "blocked")
	}
	if err != nil {
		return fail(stderr, err)
	}
	if item == nil {
		if parsed.TaskQuery != "" {
			return fail(stderr, fmt.Errorf("no task matching %s", parsed.TaskQuery))
		}
		return fail(stderr, errors.New("no blocked task to correct"))
	}
	note, ok, err := resolveMessage(parsed, "optional")
	if err != nil {
		return fail(stderr, err)
	}
	if !ok {
		note = ""
	}
	if err := evals.CaptureCorrection(ctx, *item, note); err != nil {
		return fail(stderr, err)
	}
	if err := task.SetStatus(item, "done", nil); err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "%s: correction recorded, marked done\n", item.ID)
	return 0
}

func configCommand(cwd string, args []string, stdout, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "edit" {
		return editConfig(cwd, args[1:], stdout, stderr)
	}
	if len(args) > 0 {
		return fail(stderr, errors.New("usage: factory config [edit [--global|--worktree|--repo-parent|--dir <dir>]]"))
	}
	return printConfig(cwd, stdout, stderr)
}

func printConfig(cwd string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "root: %s\nstateDir: %s\ntasksDir: %s\nrepoStateDir: %s\nretries: %d\ntriage: %t\nsecurity: %t\nux: %t\n", ctx.Root, ctx.StateDir, ctx.TasksDir, ctx.RepoStateDir, ctx.Config.Retries, ctx.Config.Triage, ctx.Config.Security, ctx.Config.UX)
	return 0
}

func editConfig(cwd string, args []string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	target := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch arg {
		case "--global":
			target = ""
		case "--worktree":
			target = ctx.Root
		case "--repo-parent":
			target = filepath.Dir(ctx.Root)
		case "--dir":
			if i+1 >= len(args) {
				return fail(stderr, errors.New("usage: factory config edit --dir <dir>"))
			}
			target = args[i+1]
			i++
		default:
			if strings.HasPrefix(arg, "--") {
				return fail(stderr, fmt.Errorf("unknown option %s", arg))
			}
			if target == "" {
				target = arg
			} else {
				return fail(stderr, errors.New("usage: factory config edit [--global|--worktree|--repo-parent|--dir <dir>]"))
			}
		}
	}
	path := config.GlobalConfigFile()
	if target != "" {
		path = filepath.Join(expandTilde(target), ".factory.json")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fail(stderr, err)
	}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
			return fail(stderr, err)
		}
	} else if err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "editing %s\n", path)
	if err := openEditor(path); err != nil {
		return fail(stderr, err)
	}
	return 0
}

func lessonsCommand(cwd string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	curated, err := lessons.ReadLessons(ctx)
	if err != nil {
		return fail(stderr, err)
	}
	candidates, err := lessons.ReadCandidates(ctx)
	if err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintln(stdout, "## LESSONS.md (curated - read by the planner each run)")
	if curated == "" {
		fmt.Fprintln(stdout, "(none yet)")
	} else {
		fmt.Fprintln(stdout, curated)
	}
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "## candidates (raw signal - curate the recurring ones into LESSONS.md)")
	if candidates == "" {
		fmt.Fprintln(stdout, "(none yet)")
	} else {
		fmt.Fprintln(stdout, candidates)
	}
	return 0
}

func report(cwd string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadRepoContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	report, err := metrics.ReadReport(ctx.MetricsPath)
	if err != nil {
		fmt.Fprintf(stderr, "telemetry: could not read metrics - %s\n", err)
		fmt.Fprintln(stdout, "the db rebuilds itself on the next task run")
		return 0
	}
	if report == nil {
		fmt.Fprintln(stdout, "no telemetry yet - run some tasks first")
		return 0
	}
	for _, line := range formatReport(report) {
		fmt.Fprintln(stdout, line)
	}
	return 0
}

func askCommand(cwd string, args []string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	tasks, err := task.LoadAll(ctx)
	if err != nil {
		return fail(stderr, err)
	}
	tasks = askpkg.SortForAsk(tasks)
	request := askpkg.ParseRequest(args, tasks)
	if len(tasks) == 0 {
		return fail(stderr, errors.New("no tasks in this worktree"))
	}
	if request.Mode == "print" {
		if request.Question == "" {
			return fail(stderr, errors.New("usage: factory ask --print [task-id] <question...>"))
		}
		result, err := askpkg.Answer(askpkg.Options{
			Context:  ctx,
			Question: request.Question,
			TaskID:   request.TaskID,
		})
		if err != nil {
			return fail(stderr, err)
		}
		fmt.Fprintln(stdout, result.Answer)
		return 0
	}
	if !isTerminal(os.Stdin) || !isTerminal(os.Stdout) {
		return fail(stderr, errors.New(askpkg.NonTTYMessage))
	}
	return askSession(ctx, request, stdout, stderr)
}

func askSession(ctx config.WorkContext, request askpkg.Request, stdout, stderr io.Writer) int {
	fmt.Fprintf(stdout, "ask - %s", ctx.AskAgent.CLI)
	if request.TaskID != "" {
		fmt.Fprintf(stdout, " - task %s", request.TaskID)
	}
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "ask a question - Enter or /done to exit - /edit long reply - /cancel abort")
	reader := bufio.NewReader(os.Stdin)
	var transcript []askpkg.TranscriptTurn
	var carried []string
	submit := func(question string) (bool, int) {
		fmt.Fprintln(stdout, "  ...thinking")
		result, err := askpkg.Answer(askpkg.Options{
			Context:        ctx,
			Question:       question,
			TaskID:         request.TaskID,
			Transcript:     transcript,
			CarriedTaskIDs: carried,
		})
		if err != nil {
			fmt.Fprintf(stderr, "ask failed: %s\n", err)
			return false, 0
		}
		fmt.Fprintln(stdout, result.Answer)
		transcript = append(transcript, askpkg.TranscriptTurn{Question: question, Answer: result.Answer})
		carried = mergeIDs(carried, result.SelectedTaskIDs)
		return false, 0
	}
	if strings.TrimSpace(request.Question) != "" {
		done, code := submit(request.Question)
		if done {
			return code
		}
	}
	for {
		fmt.Fprint(stdout, "you> ")
		line, err := reader.ReadString('\n')
		if err != nil && strings.TrimSpace(line) == "" {
			return 0
		}
		input := strings.TrimSpace(line)
		switch input {
		case "", "/done":
			return 0
		case "/cancel":
			return 1
		case "/edit":
			edited, err := composeInEditor("")
			if err != nil {
				fmt.Fprintf(stderr, "ask failed: %s\n", err)
				continue
			}
			if strings.TrimSpace(edited) == "" {
				fmt.Fprintln(stdout, "  (nothing entered)")
				continue
			}
			submit(edited)
		default:
			submit(input)
		}
	}
}

func agentSession(cwd string, args []string, defaultAgent string, commandName string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	request, err := sessionpkg.ParseArgs(args, defaultAgent)
	if err != nil {
		return fail(stderr, err)
	}
	if !isTerminal(os.Stdin) || !isTerminal(os.Stdout) {
		return fail(stderr, fmt.Errorf("factory %s needs an interactive terminal", commandName))
	}
	item, err := sessionpkg.TargetTask(ctx, request.TaskQuery)
	if err != nil {
		return fail(stderr, err)
	}
	if item == nil {
		if request.TaskQuery != "" {
			return fail(stderr, fmt.Errorf("no task matching %s", request.TaskQuery))
		}
		return fail(stderr, errors.New("no done task in this worktree"))
	}
	handoff, err := sessionpkg.BuildHandoff(ctx, *item, request.Agent, time.Now().UTC())
	if err != nil {
		return fail(stderr, err)
	}
	fmt.Fprintf(stdout, "wrote %s\n", handoff.Artifact)
	fmt.Fprintf(stdout, "summary target: %s\n", handoff.SummaryPath)
	argv := sessionpkg.Command(request.Agent, ctx.Root, item.ID, handoff.Artifact, handoff.SummaryPath)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = ctx.Root
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	err = cmd.Run()
	code := 0
	if err != nil {
		code = 1
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		} else {
			fmt.Fprintf(stderr, "%s\n", err)
		}
	}
	if data, err := os.ReadFile(handoff.SummaryPath); err != nil || strings.TrimSpace(string(data)) == "" {
		fmt.Fprintf(stderr, "no summary written at %s\n", handoff.SummaryPath)
	}
	return code
}

func runLoop(cwd string, args []string, stdout, stderr io.Writer) int {
	ctx, err := config.LoadContext(cwd)
	if err != nil {
		return fail(stderr, err)
	}
	once := contains(args, "--once")
	drain := contains(args, "--drain")
	for {
		next, err := task.NextRunnable(ctx, time.Now().UTC())
		if err != nil {
			return fail(stderr, err)
		}
		if next == nil {
			if once || drain {
				hooks.Emit(ctx.Root, ctx.Config.Hooks, "stage.change", map[string]string{"stage": "", "active": "false"})
				return 0
			}
			hooks.Emit(ctx.Root, ctx.Config.Hooks, "loop.idle", map[string]string{"state": "idle"})
			time.Sleep(5 * time.Second)
			continue
		}
		hooks.Emit(ctx.Root, ctx.Config.Hooks, "task.start", map[string]string{"task": next.ID})
		started := time.Now().UTC()
		outcome := conductor.Run(ctx, next, stdout)
		outcomeName := "blocked"
		if outcome.OK {
			if err := task.SetStatus(next, "done", nil); err != nil {
				return fail(stderr, err)
			}
			outcomeName = "done"
			hooks.Emit(ctx.Root, ctx.Config.Hooks, "task.done", map[string]string{"task": next.ID, "commit": value(next.Meta.Commit)})
			fmt.Fprintf(stdout, "%s: done\n", next.ID)
		} else if outcome.Kind == "needs-input" {
			if err := task.SetStatus(next, "needs-input", &outcome.Reason); err != nil {
				return fail(stderr, err)
			}
			outcomeName = "needs-input"
			hooks.Emit(ctx.Root, ctx.Config.Hooks, "task.needs_input", map[string]string{"task": next.ID})
			fmt.Fprintf(stdout, "%s: needs input - %s\n", next.ID, outcome.Reason)
			if strings.TrimSpace(outcome.Detail) != "" {
				fmt.Fprintln(stdout, firstLines(outcome.Detail, 8))
			}
		} else {
			if err := task.SetStatus(next, "blocked", &outcome.Reason); err != nil {
				return fail(stderr, err)
			}
			if err := conductor.WritePostmortem(ctx, *next, outcome.Reason, outcome.Detail); err != nil {
				fmt.Fprintf(stderr, "postmortem: %s\n", err)
			}
			hooks.Emit(ctx.Root, ctx.Config.Hooks, "task.blocked", map[string]string{"task": next.ID, "reason": outcome.Reason})
			fmt.Fprintf(stdout, "%s: blocked - %s\n", next.ID, outcome.Reason)
			if strings.TrimSpace(outcome.Detail) != "" {
				fmt.Fprintln(stdout, firstLines(outcome.Detail, 8))
			}
		}
		recordTaskMetrics(ctx, next, outcomeName, started, stderr)
		if once {
			return 0
		}
	}
}

func recordTaskMetrics(ctx config.WorkContext, item *task.Task, outcome string, started time.Time, stderr io.Writer) {
	retries := 0
	if failures, err := task.ReadFailures(*item); err == nil {
		retries = len(failures)
	} else {
		fmt.Fprintf(stderr, "telemetry: could not read retry count - %s\n", err)
	}
	now := time.Now().UTC()
	elapsed := now.Sub(started).Milliseconds()
	if elapsed < 0 {
		elapsed = 0
	}
	createdAt := item.Meta.CreatedAt
	metrics.RecordRun(ctx.MetricsPath, metrics.RunRecord{
		Task:      item.ID,
		TS:        now.Format(time.RFC3339Nano),
		CreatedAt: &createdAt,
		Outcome:   outcome,
		Triage:    item.Meta.Complexity,
		Retries:   retries,
		MS:        elapsed,
		Stages: []metrics.StageStat{
			{Stage: "run", Agent: "factory", MS: elapsed},
		},
	}, func(message string) {
		fmt.Fprintln(stderr, message)
	})
}

func parseIntent(args []string) (string, *string) {
	verifyIndex := -1
	for i, arg := range args {
		if arg == "--verify" {
			verifyIndex = i
			break
		}
	}
	if verifyIndex < 0 {
		intent := strings.TrimSpace(strings.Join(args, " "))
		if intent == "" && !isTerminal(os.Stdin) {
			intent = readStdin()
		}
		return intent, nil
	}
	intent := strings.TrimSpace(strings.Join(args[:verifyIndex], " "))
	verify := strings.TrimSpace(strings.Join(args[verifyIndex+1:], " "))
	if intent == "" && !isTerminal(os.Stdin) {
		intent = readStdin()
	}
	if verify == "" {
		return intent, nil
	}
	return intent, &verify
}

type parsedInput struct {
	TaskQuery  string
	Message    string
	HasMessage bool
	Edit       bool
}

func parseInputArgs(args []string, usage string) (parsedInput, error) {
	var parsed parsedInput
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-m" || arg == "--message":
			if i+1 >= len(args) {
				return parsedInput{}, errors.New(usage)
			}
			parsed.Message = args[i+1]
			parsed.HasMessage = true
			i++
		case arg == "--edit":
			parsed.Edit = true
		case strings.HasPrefix(arg, "--message="):
			parsed.Message = strings.TrimPrefix(arg, "--message=")
			parsed.HasMessage = true
		case strings.HasPrefix(arg, "--") || (strings.HasPrefix(arg, "-") && arg != "-"):
			return parsedInput{}, fmt.Errorf("unknown option %s\n%s", arg, usage)
		default:
			if parsed.TaskQuery != "" {
				return parsedInput{}, fmt.Errorf("%s\nthe message is set with -m/--message or composed in $EDITOR", usage)
			}
			parsed.TaskQuery = arg
		}
	}
	return parsed, nil
}

func resolveMessage(parsed parsedInput, mode string) (string, bool, error) {
	if parsed.HasMessage {
		text := strings.TrimSpace(parsed.Message)
		return text, text != "", nil
	}
	if parsed.Edit {
		text, err := composeInEditor("")
		if err != nil {
			return "", false, err
		}
		text = strings.TrimSpace(text)
		return text, text != "", nil
	}
	if mode == "required" {
		if isTerminal(os.Stdin) {
			text, err := composeInEditor("")
			if err != nil {
				return "", false, err
			}
			text = strings.TrimSpace(text)
			return text, text != "", nil
		}
		text := strings.TrimSpace(readStdin())
		return text, text != "", nil
	}
	return "", false, nil
}

func composeInEditor(seed string) (string, error) {
	file, err := os.CreateTemp("", "factory-edit-*.md")
	if err != nil {
		return "", err
	}
	path := file.Name()
	defer os.Remove(path)
	if strings.TrimSpace(seed) != "" {
		if _, err := file.WriteString(seed + "\n"); err != nil {
			file.Close()
			return "", err
		}
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	if err := openEditor(path); err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func openEditor(path string) error {
	editor := os.Getenv("AGENT_WORK_EDITOR")
	if editor == "" {
		editor = os.Getenv("EDITOR")
	}
	if editor == "" {
		editor = os.Getenv("VISUAL")
	}
	if editor == "" {
		editor = "vi"
	}
	cmd := exec.Command("sh", "-c", editor+` "$1"`, "sh", path)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("editor exited: %w", err)
	}
	return nil
}

func hasSavedPlan(item task.Task) bool {
	plan, err := task.ReadArtifact(item, "plan.md")
	return err == nil && plan != nil
}

func findShowArtifact(item task.Task, query string) (string, *string, error) {
	candidates := []string{query}
	if !strings.Contains(query, ".") {
		candidates = append(candidates, query+".md", query+".log", query+".jsonl")
	}
	aliases := map[string]string{
		"feedback":        "feedback.md",
		"questions":       "questions.md",
		"answers":         "answers.md",
		"plan":            "plan.md",
		"final-plan":      "plan.final.md",
		"implement":       "implement.md",
		"review":          "review.md",
		"failures":        "failures.jsonl",
		"verify":          "verify.log",
		"proof":           "proof.md",
		"correction":      "correction.md",
		"postmortem":      "postmortem.md",
		"ship":            "ship.md",
		"session":         "agent-session.md",
		"session-summary": "agent-session.summary.md",
	}
	if alias, ok := aliases[query]; ok {
		candidates = append([]string{alias}, candidates...)
	}
	for _, name := range candidates {
		text, err := task.ReadArtifact(item, name)
		if err != nil {
			return "", nil, err
		}
		if text != nil {
			return name, text, nil
		}
	}
	return "", nil, nil
}

func isShowArtifactQuery(query string) bool {
	if strings.Contains(query, ".") {
		return true
	}
	aliases := map[string]bool{
		"feedback": true, "questions": true, "answers": true, "plan": true,
		"final-plan": true, "implement": true, "review": true, "failures": true,
		"verify": true, "proof": true, "correction": true, "postmortem": true,
		"ship": true, "session": true, "session-summary": true,
	}
	return aliases[query]
}

func suffix(verify *string, complexity string, sharpenPending bool) string {
	var parts []string
	if complexity != "" {
		parts = append(parts, complexity)
	}
	if verify != nil {
		parts = append(parts, "verify: "+*verify)
	}
	if sharpenPending {
		parts = append(parts, "sharpen pending")
	}
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, ", ") + ")"
}

func readStdin() string {
	var builder strings.Builder
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		builder.WriteString(scanner.Text())
		builder.WriteByte('\n')
	}
	return strings.TrimSpace(builder.String())
}

func isTerminal(file *os.File) bool {
	info, err := file.Stat()
	return err == nil && (info.Mode()&os.ModeCharDevice) != 0
}

func fail(stderr io.Writer, err error) int {
	if errors.Is(err, gitutil.ErrNotRepo) {
		fmt.Fprintln(stderr, gitutil.ErrNotRepo.Error())
		return 1
	}
	fmt.Fprintln(stderr, err.Error())
	return 1
}

func drop(args []string, value string) []string {
	out := make([]string, 0, len(args))
	for _, arg := range args {
		if arg != value {
			out = append(out, arg)
		}
	}
	return out
}

func contains(args []string, value string) bool {
	for _, arg := range args {
		if arg == value {
			return true
		}
	}
	return false
}

func firstLines(text string, limit int) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) > limit {
		lines = append(lines[:limit], "...")
	}
	return strings.Join(lines, "\n")
}

func value(ptr *string) string {
	if ptr == nil {
		return ""
	}
	return *ptr
}

func formatReport(report *metrics.Report) []string {
	lines := []string{fmt.Sprintf("factory report - %s | %s", plural(report.Tasks, "task"), plural(report.Runs, "run")), ""}
	lines = append(lines,
		fmt.Sprintf("  %-16s %s   done with no retries, of implement attempts", "first-pass yield", pctOf(report.FirstPassYield)),
		fmt.Sprintf("  %-16s %s   %s", "escalation rate", pctOf(report.EscalationRate), plural(report.Escalations, "pause")),
		fmt.Sprintf("  %-16s %s", "blocked rate", pctOf(report.BlockedRate)),
		fmt.Sprintf("  %-16s %s   of %s", "retry success", pctOf(report.RetrySuccess), plural(report.RetryRuns, "retried run")),
		"",
		fmt.Sprintf("  %-16s input %s tok | output %s tok | total %s tok | median %s tok/task",
			"cost",
			tokensInt(report.InputTokensTotal),
			tokensInt(report.OutputTokensTotal),
			tokensInt(report.InputTokensTotal+report.OutputTokensTotal),
			tokensFloat(report.TokensMedianPerTask),
		),
		fmt.Sprintf("  %-16s median %s", "cycle time", durMS(report.CycleMedianMS)),
		"",
		fmt.Sprintf("  outcomes:  %s", formatOutcomes(report.Outcomes)),
	)
	if len(report.Stages) == 0 {
		return lines
	}
	var stageTokens int64
	var stageMS int64
	for _, stage := range report.Stages {
		stageTokens += stage.TotalTokens
		stageMS += stage.MS
	}
	lines = append(lines, "", "  stage cost and time:")
	lines = append(lines, fmt.Sprintf("    %-14s %7s %7s %7s %7s %7s %7s", "stage", "input", "output", "total", "tok %", "time", "time %"))
	for _, stage := range report.Stages {
		lines = append(lines, fmt.Sprintf(
			"    %-14s %7s %7s %7s %7s %7s %7s",
			stage.Stage,
			tokensInt(stage.InputTokens),
			tokensInt(stage.OutputTokens),
			tokensInt(stage.TotalTokens),
			pctOf(intRatio(stage.TotalTokens, stageTokens)),
			durMS(floatPtr(float64(stage.MS))),
			pctOf(intRatio(stage.MS, stageMS)),
		))
	}
	return lines
}

func plural(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func pctOf(value *float64) string {
	if value == nil {
		return "-"
	}
	return fmt.Sprintf("%.0f%%", *value*100)
}

func tokensInt(n int64) string {
	return fmt.Sprintf("%d", n)
}

func tokensFloat(value *float64) string {
	if value == nil {
		return "-"
	}
	return fmt.Sprintf("%.0f", *value)
}

func durMS(value *float64) string {
	if value == nil {
		return "-"
	}
	seconds := int64((*value + 500) / 1000)
	if seconds < 60 {
		return fmt.Sprintf("%ds", seconds)
	}
	minutes := seconds / 60
	if minutes < 60 {
		return fmt.Sprintf("%dm", minutes)
	}
	hours := minutes / 60
	if hours < 24 {
		return fmt.Sprintf("%dh%dm", hours, minutes%60)
	}
	return fmt.Sprintf("%dd", hours/24)
}

func formatOutcomes(outcomes []metrics.OutcomeCount) string {
	if len(outcomes) == 0 {
		return "-"
	}
	parts := make([]string, 0, len(outcomes))
	for _, outcome := range outcomes {
		parts = append(parts, fmt.Sprintf("%s %d", outcome.Outcome, outcome.Count))
	}
	return strings.Join(parts, " | ")
}

func intRatio(num int64, denom int64) *float64 {
	if denom <= 0 {
		return nil
	}
	value := float64(num) / float64(denom)
	return &value
}

func floatPtr(value float64) *float64 {
	return &value
}

func mergeIDs(existing []string, incoming []string) []string {
	ids := append([]string(nil), existing...)
	for _, id := range incoming {
		found := false
		for _, existingID := range ids {
			if existingID == id {
				found = true
				break
			}
		}
		if !found {
			ids = append(ids, id)
		}
	}
	return ids
}

func expandTilde(path string) string {
	if path == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			return home
		}
	}
	if strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(path, "~/"))
		}
	}
	return path
}
