package evals

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/evansolomon/factory/internal/config"
	"github.com/evansolomon/factory/internal/gitutil"
	"github.com/evansolomon/factory/internal/lessons"
	"github.com/evansolomon/factory/internal/task"
)

type correctionRecord struct {
	ID           string  `json:"id"`
	TS           string  `json:"ts"`
	Outcome      string  `json:"outcome"`
	Reason       string  `json:"reason"`
	Note         *string `json:"note"`
	Worktree     string  `json:"worktree"`
	BaseCommit   string  `json:"baseCommit"`
	Verify       *string `json:"verify"`
	Spec         string  `json:"spec"`
	AgentAttempt string  `json:"agentAttempt"`
	HumanFix     string  `json:"humanFix"`
}

func CaptureCorrection(ctx config.WorkContext, item task.Task, note string) error {
	intent, err := task.ReadIntent(item)
	if err != nil {
		return err
	}
	agentAttempt := ""
	if text, err := task.ReadArtifact(item, "diff.patch"); err != nil {
		return err
	} else if text != nil {
		agentAttempt = *text
	}
	humanFix := gitutil.WorktreeDiff(ctx.Root)
	reason := "blocked"
	if item.Meta.Note != nil && strings.TrimSpace(*item.Meta.Note) != "" {
		reason = *item.Meta.Note
	}
	content := strings.Join([]string{
		"# Correction - " + item.ID,
		"",
		"## Task",
		intent,
		"",
		"## Block reason",
		reason,
		"",
		"## Human note",
		emptyAsNone(note),
		"",
		"## Agent attempt",
		emptyAsNone(agentAttempt),
		"",
		"## Human correction diff",
		emptyAsNone(humanFix),
		"",
	}, "\n")
	if err := task.WriteArtifact(item, "correction.md", content); err != nil {
		return err
	}
	if ctx.Config.CaptureEvals {
		writeCorrectionEval(ctx, item, intent, reason, note, agentAttempt, humanFix)
	}
	lesson := note
	if strings.TrimSpace(lesson) == "" {
		lesson = "manual correction recorded; inspect correction.md"
	}
	lessons.AppendCandidate(ctx, fmt.Sprintf("correction - %s - [other] %s", item.ID, lesson))
	return nil
}

func writeCorrectionEval(ctx config.WorkContext, item task.Task, intent string, reason string, note string, agentAttempt string, humanFix string) {
	baseCommit, err := gitutil.HeadSHA(ctx.Root)
	if err != nil {
		baseCommit = ""
	}
	var notePtr *string
	if strings.TrimSpace(note) != "" {
		notePtr = &note
	}
	record := correctionRecord{
		ID:           item.ID,
		TS:           time.Now().UTC().Format(time.RFC3339Nano),
		Outcome:      "corrected",
		Reason:       reason,
		Note:         notePtr,
		Worktree:     ctx.Root,
		BaseCommit:   baseCommit,
		Verify:       item.Meta.Verify,
		Spec:         intent,
		AgentAttempt: agentAttempt,
		HumanFix:     humanFix,
	}
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return
	}
	dir := filepath.Join(ctx.RepoStateDir, "eval-candidates")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	path := filepath.Join(dir, fmt.Sprintf("%s.corrected.%d.json", item.ID, time.Now().UnixMilli()))
	_ = os.WriteFile(path, append(data, '\n'), 0o644)
}

func emptyAsNone(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return "(none)"
	}
	return text
}
