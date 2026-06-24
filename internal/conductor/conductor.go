package conductor

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/evansolomon/factory/internal/agents"
	"github.com/evansolomon/factory/internal/config"
	"github.com/evansolomon/factory/internal/executil"
	"github.com/evansolomon/factory/internal/gitutil"
	"github.com/evansolomon/factory/internal/hooks"
	"github.com/evansolomon/factory/internal/lessons"
	"github.com/evansolomon/factory/internal/markers"
	"github.com/evansolomon/factory/internal/task"
)

type Outcome struct {
	OK     bool
	Kind   string
	Reason string
	Detail string
}

func Run(ctx config.WorkContext, item *task.Task, stdout io.Writer) Outcome {
	intent, err := task.ReadIntent(*item)
	if err != nil {
		return blocked("read intent failed", err.Error())
	}

	if item.Meta.Commit == nil {
		finalPlan, outcome := preparePlan(ctx, item, stdout, &intent)
		if !outcome.OK {
			return outcome
		}
		failures, err := task.ReadFailures(*item)
		if err != nil {
			return blocked("read failure history failed", err.Error())
		}
		pendingFeedback, err := task.ReadPendingFeedback(*item)
		if err != nil {
			return blocked("read pending feedback failed", err.Error())
		}
		feedbackCount := item.Meta.FeedbackCount
		if outcome := runImplementation(ctx, item, stdout, intent, implementPrompt(intent, finalPlan, item.Meta.Verify, item.Meta.Resume, item.Meta.ResumeNote, pendingFeedback), filepath.Join(item.Dir, "implement.md")); !outcome.OK {
			return outcome
		}
		for {
			if !gitutil.HasChanges(ctx.Root) {
				return blocked("no worktree changes after implementation", "implementation completed but git status is clean")
			}

			review, outcome := runReview(ctx, item, stdout, intent, finalPlan)
			if !outcome.OK {
				if fixed, fixOutcome := fixGate(ctx, item, stdout, intent, finalPlan, pendingFeedback, "review", outcome.Detail, &failures); !fixed {
					if !fixOutcome.OK {
						return fixOutcome
					}
				} else {
					continue
				}
			}
			_ = review

			if item.Meta.Verify != nil && strings.TrimSpace(*item.Meta.Verify) != "" {
				if outcome := runVerify(ctx, item, stdout); !outcome.OK {
					if fixed, fixOutcome := fixGate(ctx, item, stdout, intent, finalPlan, pendingFeedback, "verify", outcome.Detail, &failures); !fixed {
						if !fixOutcome.OK {
							return fixOutcome
						}
					} else {
						continue
					}
				}
			} else {
				_ = task.WriteArtifact(*item, "verify.log", "no verify command\n")
			}

			proof := proofArtifact(item.ID, intent, finalPlan, item.Meta.Verify)
			_ = task.WriteArtifact(*item, "proof.md", proof)
			if err := gitutil.CommitAll(ctx.Root, commitMessage(intent)); err != nil {
				return blocked("commit failed", err.Error())
			}
			sha, err := gitutil.HeadSHA(ctx.Root)
			if err != nil {
				return blocked("read committed head failed", err.Error())
			}
			item.Meta.Commit = &sha
			if pendingFeedback != nil {
				task.MarkFeedbackConsumed(item, feedbackCount)
			}
			if err := task.SaveMeta(*item); err != nil {
				return blocked("save committed metadata failed", err.Error())
			}
			break
		}
	}

	if ctx.Config.OnComplete != nil {
		if outcome := runShip(ctx, item, stdout, intent); !outcome.OK {
			return outcome
		}
	}
	if err := writeCompletionFeedback(ctx, *item, intent); err != nil {
		return blocked("write feedback failed", err.Error())
	}
	hooks.Emit(ctx.Root, ctx.Config.Hooks, "stage.change", map[string]string{"stage": "", "active": "false"})
	return Outcome{OK: true}
}

func preparePlan(ctx config.WorkContext, item *task.Task, stdout io.Writer, intent *string) (string, Outcome) {
	if existing, err := task.ReadArtifact(*item, "plan.md"); err != nil {
		return "", blocked("read plan artifact failed", err.Error())
	} else if existing != nil && strings.TrimSpace(*existing) != "" {
		return *existing, Outcome{OK: true}
	}
	answers, err := task.ReadAnswers(*item)
	if err != nil {
		return "", blocked("read answers failed", err.Error())
	}

	trivial := false
	if item.Meta.Complexity != nil {
		trivial = *item.Meta.Complexity == "trivial"
		fmt.Fprintf(stdout, "%s: %s — using declared complexity\n", item.ID, *item.Meta.Complexity)
	} else if ctx.Config.Triage {
		if err := task.SetStatus(item, "planning", nil); err != nil {
			return "", blocked("status update failed", err.Error())
		}
		hooks.Emit(ctx.Root, ctx.Config.Hooks, "stage.change", map[string]string{
			"task":   item.ID,
			"stage":  "triage",
			"active": "true",
		})
		fmt.Fprintf(stdout, "%s: triaging with %s\n", item.ID, agents.Label(ctx.Agents.Implementer))
		out, err := agents.Run(
			ctx.Agents.Implementer,
			ctx.Root,
			triagePrompt(*intent, item.Meta.Verify, answers),
			agents.AccessRead,
			filepath.Join(item.Dir, "triage.md"),
		)
		if err != nil {
			return "", blocked("triage agent failed", err.Error())
		}
		trivial = markers.ParseTriage(out).Trivial
	}

	if trivial && item.Meta.Sharpen == "pending" {
		item.Meta.Sharpen = "skipped"
		if err := task.SaveMeta(*item); err != nil {
			return "", blocked("save sharpen state failed", err.Error())
		}
	}
	if trivial {
		fmt.Fprintf(stdout, "%s: trivial — skipping plan ensemble\n", item.ID)
		if err := task.WriteArtifact(*item, "plan.md", *intent+"\n"); err != nil {
			return "", blocked("write plan artifact failed", err.Error())
		}
		return *intent, Outcome{OK: true}
	}

	if item.Meta.Sharpen == "pending" {
		sharpened, outcome := runSharpenStage(ctx, item, stdout, *intent, answers)
		if !outcome.OK {
			return "", outcome
		}
		*intent = sharpened
	}

	if err := task.SetStatus(item, "planning", nil); err != nil {
		return "", blocked("status update failed", err.Error())
	}
	hooks.Emit(ctx.Root, ctx.Config.Hooks, "stage.change", map[string]string{
		"task":   item.ID,
		"stage":  "planning",
		"active": "true",
	})
	var plans []labeledText
	planners := ctx.Agents.Planners
	if len(planners) == 0 {
		planners = []config.Agent{ctx.Agents.Implementer}
	}
	labels := plannerLabels(planners)
	for i, planner := range planners {
		label := labels[i]
		fmt.Fprintf(stdout, "%s: planning with %s\n", item.ID, agents.Label(planner))
		plan, err := agents.Run(
			planner,
			ctx.Root,
			planPrompt(*intent, item.Meta.Verify, answers),
			agents.AccessRead,
			filepath.Join(item.Dir, fmt.Sprintf("plan.%s.md", label)),
		)
		if err != nil {
			return "", blocked("planner failed", err.Error())
		}
		plans = append(plans, labeledText{Label: label, Text: plan})
	}

	finalPlan := plans[0].Text
	if len(plans) > 1 {
		fmt.Fprintf(stdout, "%s: selecting final plan with %s\n", item.ID, agents.Label(ctx.Agents.Implementer))
		selected, err := agents.Run(
			ctx.Agents.Implementer,
			ctx.Root,
			selectPrompt(*intent, plans, answers),
			agents.AccessRead,
			filepath.Join(item.Dir, "plan.md"),
		)
		if err != nil {
			return "", blocked("select plan failed", err.Error())
		}
		finalPlan = selected
	}
	if strings.TrimSpace(finalPlan) == "" {
		return "", blocked("planning produced empty plan", "")
	}
	if outcome := reconcilePlan(ctx, item, stdout, *intent, finalPlan, answers); !outcome.OK {
		return "", outcome
	}
	if err := task.WriteArtifact(*item, "plan.md", strings.TrimSpace(finalPlan)+"\n"); err != nil {
		return "", blocked("write plan artifact failed", err.Error())
	}
	if ctx.PlansDir != "" {
		if err := os.MkdirAll(ctx.PlansDir, 0o755); err != nil {
			return "", blocked("create plans dir failed", err.Error())
		}
		if err := os.WriteFile(filepath.Join(ctx.PlansDir, item.ID+".md"), []byte("# "+firstLine(*intent)+"\n\n"+strings.TrimSpace(finalPlan)+"\n"), 0o644); err != nil {
			return "", blocked("write committed plan failed", err.Error())
		}
	}
	return strings.TrimSpace(finalPlan), Outcome{OK: true}
}

func runSharpenStage(ctx config.WorkContext, item *task.Task, stdout io.Writer, intent string, answers *string) (string, Outcome) {
	if err := task.SetStatus(item, "sharpening", nil); err != nil {
		return "", blocked("status update failed", err.Error())
	}
	hooks.Emit(ctx.Root, ctx.Config.Hooks, "stage.change", map[string]string{
		"task":   item.ID,
		"stage":  "sharpen",
		"active": "true",
	})
	fmt.Fprintf(stdout, "%s: sharpening with %s\n", item.ID, agents.Label(ctx.Agents.Implementer))
	out, err := agents.Run(
		ctx.Agents.Implementer,
		ctx.Root,
		sharpenPrompt(sharpenTranscript(intent, answers), false),
		agents.AccessRead,
		filepath.Join(item.Dir, "sharpen.md"),
	)
	if err != nil {
		return "", blocked("sharpen agent failed", err.Error())
	}
	parsed := parseSharpen(out)
	if !parsed.Ready || strings.TrimSpace(parsed.Spec) == "" {
		questions := formatSharpenQuestions(out)
		if questions != "" {
			if err := task.WriteArtifact(*item, "questions.md", questions+"\n"); err != nil {
				return "", blocked("write questions failed", err.Error())
			}
			return "", Outcome{OK: false, Kind: "needs-input", Reason: "awaiting answer — see questions.md", Detail: questions}
		}
		final, err := agents.Run(
			ctx.Agents.Implementer,
			ctx.Root,
			sharpenPrompt(sharpenTranscript(intent+"\n\nAgent draft:\n"+out, answers), true),
			agents.AccessRead,
			filepath.Join(item.Dir, "sharpen.final.md"),
		)
		if err != nil {
			return "", blocked("finalize sharpen failed", err.Error())
		}
		parsed = parseSharpen(final)
		if !parsed.Ready || strings.TrimSpace(parsed.Spec) == "" {
			parsed = sharpenResult{Ready: true, Verify: item.Meta.Verify, Spec: intent}
		}
	}
	verify := item.Meta.Verify
	if parsed.Verify != nil {
		verify = parsed.Verify
	}
	if err := task.ReadySharpened(item, parsed.Spec, verify); err != nil {
		return "", blocked("save sharpened task failed", err.Error())
	}
	return strings.TrimSpace(parsed.Spec), Outcome{OK: true}
}

func reconcilePlan(ctx config.WorkContext, item *task.Task, stdout io.Writer, intent string, finalPlan string, answers *string) Outcome {
	if err := task.SetStatus(item, "planning", nil); err != nil {
		return blocked("status update failed", err.Error())
	}
	hooks.Emit(ctx.Root, ctx.Config.Hooks, "stage.change", map[string]string{
		"task":   item.ID,
		"stage":  "reconcile",
		"active": "true",
	})
	fmt.Fprintf(stdout, "%s: reconciling plan with %s\n", item.ID, agents.Label(ctx.Agents.Implementer))
	out, err := agents.Run(
		ctx.Agents.Implementer,
		ctx.Root,
		reconcilePrompt(intent, finalPlan, answers),
		agents.AccessRead,
		filepath.Join(item.Dir, "reconcile.md"),
	)
	if err != nil {
		return blocked("reconcile agent failed", err.Error())
	}
	switch markers.ParseReconcileDecision(out) {
	case "PROCEED":
		return Outcome{OK: true}
	case "ASK":
		questions := strings.TrimSpace(strings.TrimPrefix(out, firstLine(out)))
		if questions == "" {
			questions = strings.TrimSpace(out)
		}
		if err := task.WriteArtifact(*item, "questions.md", questions+"\n"); err != nil {
			return blocked("write questions failed", err.Error())
		}
		return Outcome{OK: false, Kind: "needs-input", Reason: "awaiting answer — see questions.md", Detail: questions}
	default:
		return blocked("reconcile did not report DECISION: PROCEED or DECISION: ASK", out)
	}
}

func runImplementation(ctx config.WorkContext, item *task.Task, stdout io.Writer, intent string, prompt string, outFile string) Outcome {
	if err := task.SetStatus(item, "implementing", nil); err != nil {
		return blocked("status update failed", err.Error())
	}
	hooks.Emit(ctx.Root, ctx.Config.Hooks, "stage.change", map[string]string{
		"task":   item.ID,
		"stage":  "implementing",
		"active": "true",
	})
	fmt.Fprintf(stdout, "%s: implementing with %s\n", item.ID, agents.Label(ctx.Agents.Implementer))
	implementation, err := agents.Run(
		ctx.Agents.Implementer,
		ctx.Root,
		prompt,
		agents.AccessWrite,
		outFile,
	)
	if err != nil {
		return blocked("implementation agent failed", err.Error())
	}
	if strings.TrimSpace(implementation) == "" {
		implementation = "Agent completed without a final message."
		_ = task.WriteArtifact(*item, filepath.Base(outFile), implementation)
	}
	return Outcome{OK: true}
}

func runReview(ctx config.WorkContext, item *task.Task, stdout io.Writer, intent string, finalPlan string) (string, Outcome) {
	if err := task.SetStatus(item, "reviewing", nil); err != nil {
		return "", blocked("status update failed", err.Error())
	}
	hooks.Emit(ctx.Root, ctx.Config.Hooks, "stage.change", map[string]string{
		"task":   item.ID,
		"stage":  "reviewing",
		"active": "true",
	})
	fmt.Fprintf(stdout, "%s: reviewing with %s\n", item.ID, agents.Label(ctx.Agents.Reviewer))
	review, err := agents.Run(
		ctx.Agents.Reviewer,
		ctx.Root,
		reviewPrompt(intent, finalPlan, item.Meta.Verify, gitutil.WorktreeDiff(ctx.Root)),
		agents.AccessRead,
		filepath.Join(item.Dir, "review.md"),
	)
	if err != nil {
		return "", blocked("review agent failed", err.Error())
	}
	switch markers.ParseReviewVerdict(review) {
	case "PASS":
		return review, Outcome{OK: true}
	case "FAIL":
		return review, blocked("review failed", review)
	default:
		return review, blocked("review did not report VERDICT: PASS or VERDICT: FAIL", review)
	}
}

func runVerify(ctx config.WorkContext, item *task.Task, stdout io.Writer) Outcome {
	if err := task.SetStatus(item, "verifying", nil); err != nil {
		return blocked("status update failed", err.Error())
	}
	hooks.Emit(ctx.Root, ctx.Config.Hooks, "stage.change", map[string]string{
		"task":   item.ID,
		"stage":  "verifying",
		"active": "true",
	})
	fmt.Fprintf(stdout, "%s: verifying: %s\n", item.ID, *item.Meta.Verify)
	verify := executil.Shell(ctx.Root, *item.Meta.Verify, 0)
	log := verify.Stdout
	if verify.Stderr != "" {
		log += "\n" + verify.Stderr
	}
	_ = task.WriteArtifact(*item, "verify.log", log)
	if verify.Code != 0 {
		_ = task.SaveMeta(*item)
		detail := strings.TrimSpace(log)
		if detail == "" {
			detail = fmt.Sprintf("verify command `%s` failed with exit %d", *item.Meta.Verify, verify.Code)
		}
		return blocked(
			fmt.Sprintf("verify failed (exit %d)", verify.Code),
			detail,
		)
	}
	return Outcome{OK: true}
}

func fixGate(ctx config.WorkContext, item *task.Task, stdout io.Writer, intent string, finalPlan string, pendingFeedback *string, gate string, detail string, failures *[]task.Failure) (bool, Outcome) {
	entry := task.Failure{
		Attempt: len(*failures),
		Gate:    gate,
		Summary: truncate(firstLine(detail), 200),
		Detail:  detail,
	}
	*failures = append(*failures, entry)
	if err := task.AppendFailure(*item, entry); err != nil {
		return false, blocked("append failure history failed", err.Error())
	}
	if len(*failures) > ctx.Config.Retries {
		return false, blocked(fmt.Sprintf("%s failed after %d attempts", gate, len(*failures)), detail)
	}
	fmt.Fprintf(stdout, "%s: fixing %s failure (%d/%d)\n", item.ID, gate, len(*failures), ctx.Config.Retries)
	prompt := fixPrompt(intent, finalPlan, item.Meta.Verify, pendingFeedback, entry.Detail, priorFailureSummaries((*failures)[:len(*failures)-1]), gitutil.WorktreeDiff(ctx.Root))
	outcome := runImplementation(ctx, item, stdout, intent, prompt, filepath.Join(item.Dir, fmt.Sprintf("implement.fix.%d.md", len(*failures))))
	if !outcome.OK {
		return false, outcome
	}
	return true, Outcome{OK: true}
}

func runShip(ctx config.WorkContext, item *task.Task, stdout io.Writer, intent string) Outcome {
	if existing, err := task.ReadArtifact(*item, "ship.md"); err != nil {
		return blocked("read ship artifact failed", err.Error())
	} else if existing != nil && markers.ParseShip(*existing).OK {
		return Outcome{OK: true}
	}
	if err := task.SetStatus(item, "shipping", nil); err != nil {
		return blocked("status update failed", err.Error())
	}
	hooks.Emit(ctx.Root, ctx.Config.Hooks, "stage.change", map[string]string{
		"task":   item.ID,
		"stage":  "shipping",
		"active": "true",
	})
	fmt.Fprintf(stdout, "%s: shipping with %s\n", item.ID, agents.Label(ctx.Agents.Delivery))
	out, err := agents.Run(
		ctx.Agents.Delivery,
		ctx.Root,
		shipPrompt(intent, gitutil.CurrentBranch(ctx.Root), ctx.Config.OnComplete),
		agents.AccessFull,
		filepath.Join(item.Dir, "ship.md"),
	)
	if err != nil {
		return blocked("delivery agent failed", err.Error())
	}
	ship := markers.ParseShip(out)
	if !ship.OK {
		return blocked("ship failed: "+ship.Reason, out)
	}
	return Outcome{OK: true}
}

type labeledText struct {
	Label string
	Text  string
}

func triagePrompt(intent string, verify *string, answers *string) string {
	var b strings.Builder
	b.WriteString("Classify the task below on two axes. Look at the repo briefly if it helps.\n\n")
	b.WriteString("COMPLEXITY:\n")
	b.WriteString("TRIVIAL - a small, mechanical, low-risk change: a one-to-few-line edit, rename, config bump, or obvious localized fix.\n")
	b.WriteString("COMPLEX - needs design choices, touches multiple components, is ambiguous, security/data-sensitive, or otherwise risky. When in doubt, choose COMPLEX.\n\n")
	b.WriteString("USER-FACING:\n")
	b.WriteString("YES - changes something an end user sees or interacts with: UI, styling, layout, copy, labels, or flow.\n")
	b.WriteString("NO - internal backend/API/data/infra/build/tooling/refactor only.\n\n")
	b.WriteString("## Task\n")
	b.WriteString(intent)
	if answers != nil && strings.TrimSpace(*answers) != "" {
		b.WriteString("\n\n## Answers already provided by the human\n")
		b.WriteString(*answers)
	}
	if verify != nil && strings.TrimSpace(*verify) != "" {
		b.WriteString("\n\n## Verification command\n`")
		b.WriteString(*verify)
		b.WriteString("`")
	}
	b.WriteString("\n\nOutput ONLY these two final lines:\nCOMPLEXITY: TRIVIAL|COMPLEX\nUSER-FACING: YES|NO\n")
	return b.String()
}

func planPrompt(intent string, verify *string, answers *string) string {
	var b strings.Builder
	b.WriteString("Plan how to implement the task below in the repository at your working directory. Explore the codebase first and base the plan on what actually exists, not assumptions.\n\n")
	b.WriteString("Produce a concrete, interface-level plan another engineer could execute without re-deciding the design. Cover files, interfaces, verification, and implementation order. Follow existing patterns and keep scope deliberate.\n\n")
	b.WriteString("## Task\n")
	b.WriteString(intent)
	if answers != nil && strings.TrimSpace(*answers) != "" {
		b.WriteString("\n\n## Answers already provided by the human\n")
		b.WriteString(*answers)
	}
	if verify != nil && strings.TrimSpace(*verify) != "" {
		b.WriteString("\n\n## Verification command\n`")
		b.WriteString(*verify)
		b.WriteString("`")
	}
	b.WriteString("\n\nOutput ONLY the plan as markdown. Make no code changes.\n")
	return b.String()
}

func selectPrompt(intent string, plans []labeledText, answers *string) string {
	var b strings.Builder
	if len(plans) > 1 {
		b.WriteString("Several independent plans for the task below are given. Choose the strongest, or merge the best of them into one coherent plan.\n")
	} else {
		b.WriteString("A plan for the task below is given. Refine it into the final plan to implement.\n")
	}
	b.WriteString("Favor correctness first, then the simplest plan that meets the requirements. Do not make it larger than the task needs.\n\n")
	b.WriteString("## Task\n")
	b.WriteString(intent)
	if answers != nil && strings.TrimSpace(*answers) != "" {
		b.WriteString("\n\n## Answers already provided by the human\n")
		b.WriteString(*answers)
	}
	b.WriteString("\n")
	for _, plan := range plans {
		b.WriteString("\n## Plan (")
		b.WriteString(plan.Label)
		b.WriteString(")\n")
		b.WriteString(plan.Text)
		b.WriteString("\n")
	}
	b.WriteString("\nOutput ONLY the final plan as a self-contained markdown document. Make no code changes.\n")
	return b.String()
}

func reconcilePrompt(intent string, finalPlan string, answers *string) string {
	var b strings.Builder
	b.WriteString("Decide whether this task is clear enough to implement autonomously, or must pause for the human. Default to PROCEED. Pause only for a genuine blocker: ambiguity that changes what gets built, destructive or irreversible work, or no reasonable default.\n\n")
	b.WriteString("## Task\n")
	b.WriteString(intent)
	if answers != nil && strings.TrimSpace(*answers) != "" {
		b.WriteString("\n\n## Answers already provided by the human\n")
		b.WriteString(*answers)
	}
	b.WriteString("\n\n## Final plan\n")
	b.WriteString(finalPlan)
	b.WriteString("\n\nOn the FIRST line output exactly one of:\nDECISION: PROCEED\nDECISION: ASK\nIf ASK, follow it with a concise markdown list of only the blocking questions, each with your recommended default. Make no code changes.\n")
	return b.String()
}

type sharpenResult struct {
	Ready  bool
	Verify *string
	Spec   string
}

func parseSharpen(text string) sharpenResult {
	lines := strings.Split(text, "\n")
	marker := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == "SPEC READY" {
			marker = i
			break
		}
	}
	if marker < 0 {
		return sharpenResult{}
	}
	var verify *string
	specStart := marker + 1
	for i := marker + 1; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if strings.HasPrefix(line, "VERIFY:") {
			raw := strings.TrimSpace(strings.TrimPrefix(line, "VERIFY:"))
			if raw != "" && !strings.EqualFold(raw, "none") {
				verify = &raw
			}
			specStart = i + 1
			break
		}
		if line != "" {
			specStart = i
			break
		}
	}
	return sharpenResult{Ready: true, Verify: verify, Spec: strings.TrimSpace(strings.Join(lines[specStart:], "\n"))}
}

func formatSharpenQuestions(text string) string {
	lines := strings.Split(text, "\n")
	marker := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == "QUESTIONS" {
			marker = i
			break
		}
	}
	if marker < 0 {
		return ""
	}
	var out []string
	preamble := strings.TrimSpace(strings.Join(lines[:marker], "\n"))
	if preamble != "" {
		out = append(out, preamble)
	}
	for _, line := range lines[marker+1:] {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "-") {
			continue
		}
		item := strings.TrimSpace(strings.TrimPrefix(trimmed, "-"))
		parts := strings.SplitN(item, "|||", 2)
		question := strings.TrimSpace(parts[0])
		if question == "" {
			continue
		}
		out = append(out, "- "+question)
		if len(parts) == 2 && strings.TrimSpace(parts[1]) != "" {
			out = append(out, "  Recommended: "+strings.TrimSpace(parts[1]))
		}
	}
	return strings.TrimSpace(strings.Join(out, "\n\n"))
}

func sharpenTranscript(intent string, answers *string) string {
	var b strings.Builder
	b.WriteString("human: ")
	b.WriteString(intent)
	if answers != nil && strings.TrimSpace(*answers) != "" {
		b.WriteString("\n\nhuman: Answers already provided:\n\n")
		b.WriteString(*answers)
	}
	return b.String()
}

func sharpenPrompt(transcript string, finalize bool) string {
	specFormat := `SPEC READY
VERIFY: <the shell command that proves the outcome, or "none">

## Problem
<what is broken, missing, confusing, or worth improving>

## Goal
<the observable end state: what is true when this is done>

## Context
<why this matters, including the user's motivation or "not specified">

## Verified Current State
<repo facts you verified before asking, with file:line when useful; or "Not verified / greenfield: <why>">

## Scope
In: <what this changes>
Out: <what it explicitly does not touch or must not touch>

## Constraints
<invariants that must not regress or break>

## Acceptance Criteria
<behavior-level checks that define done>

## Assumptions
<recommended answers chosen for unresolved questions, or "none">`
	ending := `When you have enough for a self-contained task spec, respond with exactly this format:

` + specFormat + `

Otherwise, ask the unresolved human decisions as one batch in exactly this format:

QUESTIONS
- <question> ||| <your recommended answer>
- <question> ||| <your recommended answer>`
	if finalize {
		ending = `The human has ended the interview. Output the spec now, in exactly this format:

` + specFormat + `

For anything still unresolved, choose your recommended answer and record it under Assumptions.`
	}
	return `You are sharpening a rough task intent into a precise spec for an autonomous coding agent.

Rules:
- You have read access to the repo. Inspect the code to answer repo-answerable questions yourself.
- Ask only decisions that would change what gets built and need the human now.
- Preserve the user's problem framing, priorities, constraints, scope, and verification.
- Do not write an implementation plan and do not change code.

` + ending + `

## Conversation so far
` + transcript
}

func shipPrompt(intent string, branch string, onComplete *config.OnComplete) string {
	how := ""
	if onComplete != nil && onComplete.Skill != "" {
		how = fmt.Sprintf("Deliver it by running the `%s` skill.", onComplete.Skill)
	} else if onComplete != nil {
		how = "Deliver it according to this policy:\n\n" + onComplete.Policy
	} else {
		how = "Deliver it according to the repository policy."
	}
	return fmt.Sprintf(`The task below has been implemented, reviewed, verified, and committed on the current branch. %s
Use whatever tools and skills the repo provides - open a merge request / PR, iterate on CI until green, respond to review. The commit is already made; push as needed.

## Branch
%s

## Task
%s

When done, output on the FINAL line exactly one of:
SHIP: OK
SHIP: FAILED <one-line reason>`, how, branch, intent)
}

func implementPrompt(intent string, finalPlan string, verify *string, resume bool, resumeNote *string, pendingFeedback *string) string {
	var b strings.Builder
	b.WriteString("Implement the plan below in the repository at your working directory.\n\n")
	b.WriteString("Rules:\n")
	b.WriteString("- Make the requested code changes directly in the worktree.\n")
	b.WriteString("- Follow existing project patterns and keep the change scoped to the task.\n")
	b.WriteString("- Address root causes; do not weaken, skip, or delete tests.\n")
	b.WriteString("- Do not commit; factory will verify and commit after you finish.\n")
	b.WriteString("- If the task cannot be completed safely, explain the blocker in your final message.\n\n")
	if resume {
		b.WriteString("This is a resume. Reuse the existing worktree diff and saved artifacts; do not restart from scratch.\n")
		if resumeNote != nil && strings.TrimSpace(*resumeNote) != "" {
			b.WriteString("\nResume note:\n")
			b.WriteString(*resumeNote)
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("## Task\n")
	b.WriteString(intent)
	b.WriteString("\n")
	b.WriteString("\n## Plan\n")
	b.WriteString(finalPlan)
	b.WriteString("\n")
	writeFeedbackBlock(&b, pendingFeedback)
	if verify != nil && strings.TrimSpace(*verify) != "" {
		b.WriteString("\n## Verification command\n`")
		b.WriteString(*verify)
		b.WriteString("`\n")
	}
	return b.String()
}

func reviewPrompt(intent string, finalPlan string, verify *string, diff string) string {
	var b strings.Builder
	b.WriteString("You are a senior staff engineer reviewing an autonomous implementation. Read files in the repo as needed, but do not change code.\n\n")
	b.WriteString("Focus only on defects that would block shipping: wrong behavior, unmet task requirements, weakened tests, hard-coded test passing, or unrelated risky edits. Do not block on style, taste, or optional polish.\n\n")
	b.WriteString("For each finding, cite the specific file or code and tag it BLOCKING or ADVISORY. If there are no blocking findings, say so plainly.\n\n")
	b.WriteString("## Task\n")
	b.WriteString(intent)
	b.WriteString("\n")
	b.WriteString("\n## Plan\n")
	b.WriteString(finalPlan)
	b.WriteString("\n")
	if verify != nil && strings.TrimSpace(*verify) != "" {
		b.WriteString("\n## Verification command\n`")
		b.WriteString(*verify)
		b.WriteString("`\n")
	}
	b.WriteString("\n## Diff\n```diff\n")
	b.WriteString(diff)
	b.WriteString("\n```\n\n")
	b.WriteString("As the FINAL line, output exactly one of:\nVERDICT: PASS\nVERDICT: FAIL\n")
	return b.String()
}

func fixPrompt(intent string, finalPlan string, verify *string, pendingFeedback *string, failure string, history []string, diff string) string {
	var b strings.Builder
	b.WriteString("A previous attempt at the factory task below failed a gate. Fix the working tree in place so it satisfies the task and passes review and verification.\n\n")
	b.WriteString("Rules:\n")
	b.WriteString("- Address the root cause of the failure; do not weaken or delete tests.\n")
	b.WriteString("- Change only what is needed for this task.\n")
	b.WriteString("- Do not commit; factory will rerun gates and commit after they pass.\n\n")
	b.WriteString("## Task\n")
	b.WriteString(intent)
	b.WriteString("\n")
	b.WriteString("\n## Plan\n")
	b.WriteString(finalPlan)
	b.WriteString("\n")
	writeFeedbackBlock(&b, pendingFeedback)
	if verify != nil && strings.TrimSpace(*verify) != "" {
		b.WriteString("\n## Verification command\n`")
		b.WriteString(*verify)
		b.WriteString("`\n")
	}
	b.WriteString("\n## What failed\n")
	b.WriteString(failure)
	b.WriteString("\n")
	if len(history) > 0 {
		b.WriteString("\n## Prior failed attempts\n")
		for i, summary := range history {
			b.WriteString(fmt.Sprintf("%d. %s\n", i+1, summary))
		}
	}
	b.WriteString("\n## Current diff\n```diff\n")
	b.WriteString(diff)
	b.WriteString("\n```\n")
	return b.String()
}

func writeFeedbackBlock(b *strings.Builder, pendingFeedback *string) {
	if pendingFeedback == nil || strings.TrimSpace(*pendingFeedback) == "" {
		return
	}
	b.WriteString("\n## Human feedback\n")
	b.WriteString(strings.TrimSpace(*pendingFeedback))
	b.WriteString("\n\nApply this as post-progress feedback: generalize from the concrete comment before changing code, and change only the concrete cases justified by the inferred problem or root cause.\n")
}

func proofArtifact(id, intent string, finalPlan string, verify *string) string {
	verifyLine := "no verify command"
	if verify != nil && strings.TrimSpace(*verify) != "" {
		verifyLine = "`" + *verify + "` passed"
	}
	return strings.Join([]string{
		"# Proof - " + id,
		"",
		"## Task",
		intent,
		"",
		"## Plan",
		finalPlan,
		"",
		"## Verify",
		verifyLine,
		"",
		"## Review",
		"VERDICT: PASS",
	}, "\n")
}

func writeCompletionFeedback(ctx config.WorkContext, item task.Task, intent string) error {
	diff := ""
	if item.Meta.Commit != nil {
		diff = gitutil.WorktreeDiff(ctx.Root)
	}
	text := strings.Join([]string{
		"# Feedback - " + item.ID,
		"",
		"Completed task:",
		intent,
		"",
		"Commit: " + value(item.Meta.Commit),
		"",
		"Current diff after commit:",
		"```diff",
		diff,
		"```",
	}, "\n")
	return os.WriteFile(filepath.Join(item.Dir, "feedback.md"), []byte(text), 0o644)
}

func WritePostmortem(ctx config.WorkContext, item task.Task, reason string, detail string) error {
	if !ctx.Config.Postmortem {
		return nil
	}
	if existing, err := task.ReadArtifact(item, "postmortem.md"); err != nil {
		return err
	} else if existing != nil && strings.TrimSpace(*existing) != "" {
		return nil
	}
	intent, err := task.ReadIntent(item)
	if err != nil {
		return err
	}
	failures, _ := task.ReadArtifact(item, "failures.jsonl")
	diff := gitutil.WorktreeDiff(ctx.Root)
	out, err := agents.Run(
		ctx.Agents.Reviewer,
		ctx.Root,
		postmortemPrompt(intent, reason, detail, value(failures), diff),
		agents.AccessRead,
		filepath.Join(item.Dir, "postmortem.md"),
	)
	if err != nil {
		return err
	}
	summary := firstLine(out)
	if summary == "" {
		summary = reason
	}
	lessons.AppendCandidate(ctx, fmt.Sprintf("blocked · %s · %s", item.ID, summary))
	return nil
}

func postmortemPrompt(intent string, reason string, detail string, failures string, diff string) string {
	var b strings.Builder
	b.WriteString("Diagnose why this autonomous factory task blocked. This is a postmortem for improving future runs, not a retry. Do not change files.\n\n")
	b.WriteString("Output concise markdown with:\n")
	b.WriteString("- Root cause\n- What the agent missed\n- What would have unblocked it\n- A reusable lesson candidate\n\n")
	b.WriteString("## Task\n")
	b.WriteString(intent)
	b.WriteString("\n\n## Block reason\n")
	b.WriteString(reason)
	if strings.TrimSpace(detail) != "" {
		b.WriteString("\n\n## Detail\n")
		b.WriteString(detail)
	}
	if strings.TrimSpace(failures) != "" {
		b.WriteString("\n\n## Failure history\n```jsonl\n")
		b.WriteString(failures)
		b.WriteString("\n```")
	}
	if strings.TrimSpace(diff) != "" {
		b.WriteString("\n\n## Current diff\n```diff\n")
		b.WriteString(diff)
		b.WriteString("\n```")
	}
	return b.String()
}

func commitMessage(intent string) string {
	subject := strings.TrimSpace(strings.SplitN(intent, "\n", 2)[0])
	subject = strings.TrimSuffix(subject, ".")
	if len(subject) > 72 {
		subject = subject[:72]
	}
	if subject == "" {
		return "Apply task"
	}
	return subject
}

func priorFailureSummaries(failures []task.Failure) []string {
	summaries := make([]string, 0, len(failures))
	for _, failure := range failures {
		summaries = append(summaries, failure.Gate+": "+failure.Summary)
	}
	return summaries
}

func plannerLabels(planners []config.Agent) []string {
	labels := make([]string, 0, len(planners))
	seen := map[string]int{}
	for i, planner := range planners {
		base := plannerLabelBase(planner, i)
		seen[base]++
		if seen[base] == 1 {
			labels = append(labels, base)
		} else {
			labels = append(labels, fmt.Sprintf("%s-%d", base, seen[base]))
		}
	}
	return labels
}

func plannerLabelBase(agent config.Agent, index int) string {
	base := agent.CLI
	if agent.Model != "" {
		base = agent.Model
	}
	label := strings.ToLower(base)
	label = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '.' {
			return r
		}
		return '-'
	}, label)
	label = strings.Trim(label, "-.")
	if label == "" {
		label = fmt.Sprintf("planner-%d", index+1)
	}
	return label
}

func firstLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			return trimmed
		}
	}
	return strings.TrimSpace(text)
}

func truncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit]
}

func blocked(reason, detail string) Outcome {
	return Outcome{OK: false, Kind: "blocked", Reason: reason, Detail: detail}
}

func value(ptr *string) string {
	if ptr == nil {
		return ""
	}
	return *ptr
}
