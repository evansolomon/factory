package task

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/evansolomon/factory/internal/config"
)

func testContext(t *testing.T) config.WorkContext {
	t.Helper()
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	return config.WorkContext{Root: root, StateDir: stateDir, TasksDir: filepath.Join(stateDir, "tasks")}
}

func saveTask(t *testing.T, task Task) {
	t.Helper()
	if err := SaveMeta(task); err != nil {
		t.Fatal(err)
	}
}

func TestNextRunnablePrioritizesReadyOverDueRetry(t *testing.T) {
	ctx := testContext(t)
	retry, err := Add(ctx, "Retry later", nil, AddOptions{})
	if err != nil {
		t.Fatal(err)
	}
	retry.Meta.Status = "retrying"
	retryAt := time.Unix(1, 0).UTC().Format(time.RFC3339)
	retry.Meta.RetryAt = &retryAt
	saveTask(t, retry)
	ready, err := Add(ctx, "Ready now", nil, AddOptions{})
	if err != nil {
		t.Fatal(err)
	}
	next, err := NextRunnable(ctx, time.Unix(2, 0).UTC())
	if err != nil {
		t.Fatal(err)
	}
	if next == nil || next.ID != ready.ID || next.Meta.Status != "ready" {
		t.Fatalf("next = %#v", next)
	}
}

func TestStrandedPlanningRestarts(t *testing.T) {
	ctx := testContext(t)
	created, err := Add(ctx, "Plan from scratch", nil, AddOptions{Status: "planning"})
	if err != nil {
		t.Fatal(err)
	}
	next, err := NextRunnable(ctx, time.Unix(2, 0).UTC())
	if err != nil {
		t.Fatal(err)
	}
	if next == nil || next.ID != created.ID || next.Meta.Status != "ready" || next.Meta.Resume {
		t.Fatalf("next = %#v", next)
	}
	if next.Meta.Note == nil || !strings.Contains(*next.Meta.Note, "recovered after interrupted planning stage") {
		t.Fatalf("note = %#v", next.Meta.Note)
	}
}

func TestStrandedLaterStageResumes(t *testing.T) {
	ctx := testContext(t)
	created, err := Add(ctx, "Resume review", nil, AddOptions{Status: "reviewing"})
	if err != nil {
		t.Fatal(err)
	}
	next, err := NextRunnable(ctx, time.Unix(2, 0).UTC())
	if err != nil {
		t.Fatal(err)
	}
	if next == nil || next.ID != created.ID || next.Meta.Status != "ready" || !next.Meta.Resume {
		t.Fatalf("next = %#v", next)
	}
	if next.Meta.ResumeKind == nil || *next.Meta.ResumeKind != "stranded" {
		t.Fatalf("resume kind = %#v", next.Meta.ResumeKind)
	}
	if next.Meta.ResumeNote == nil || !strings.Contains(*next.Meta.ResumeNote, "interrupted reviewing stage") {
		t.Fatalf("resume note = %#v", next.Meta.ResumeNote)
	}
}

func TestInterruptedSharpeningRestarts(t *testing.T) {
	ctx := testContext(t)
	_, err := Add(ctx, "Still sharpening", nil, AddOptions{Status: "sharpening", Sharpen: "pending"})
	if err != nil {
		t.Fatal(err)
	}
	next, err := NextRunnable(ctx, time.Unix(2, 0).UTC())
	if err != nil {
		t.Fatal(err)
	}
	if next == nil || next.Meta.Status != "ready" || next.Meta.Sharpen != "pending" || next.Meta.Resume {
		t.Fatalf("next = %#v", next)
	}
}

func TestLegacyGrillingIsNotReclaimed(t *testing.T) {
	ctx := testContext(t)
	if _, err := Add(ctx, "Still grilling", nil, AddOptions{Status: "grilling"}); err != nil {
		t.Fatal(err)
	}
	next, err := NextRunnable(ctx, time.Unix(2, 0).UTC())
	if err != nil {
		t.Fatal(err)
	}
	if next != nil {
		t.Fatalf("next = %#v", next)
	}
}

func TestDueRetriesResume(t *testing.T) {
	ctx := testContext(t)
	created, err := Add(ctx, "Retry now", nil, AddOptions{})
	if err != nil {
		t.Fatal(err)
	}
	created.Meta.Status = "retrying"
	retryAt := time.Unix(1, 0).UTC().Format(time.RFC3339)
	created.Meta.RetryAt = &retryAt
	saveTask(t, created)
	next, err := NextRunnable(ctx, time.Unix(2, 0).UTC())
	if err != nil {
		t.Fatal(err)
	}
	if next == nil || next.Meta.Status != "ready" || !next.Meta.Resume {
		t.Fatalf("next = %#v", next)
	}
	if next.Meta.ResumeKind == nil || *next.Meta.ResumeKind != "auto-retry" || next.Meta.RetryAt != nil {
		t.Fatalf("meta = %#v", next.Meta)
	}
}

func TestLegacyMetadataDefaults(t *testing.T) {
	ctx := testContext(t)
	dir := filepath.Join(ctx.TasksDir, "legacy")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := map[string]any{
		"id":        "legacy",
		"slug":      "legacy",
		"createdAt": "2026-01-01T00:00:00.000Z",
	}
	data, _ := json.MarshalIndent(legacy, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	tasks, err := LoadAll(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := tasks[0].Meta
	if got.Status != "ready" || got.Verify != nil || got.Sharpen != "done" || got.Resume || got.ResumeKind != nil || got.AutoRetries != 0 || got.Complexity != nil || got.FeedbackCount != 0 || got.FeedbackConsumed != 0 || got.FeedbackSourceTaskID != nil {
		t.Fatalf("meta = %#v", got)
	}
}

func TestDeclaredComplexityPersists(t *testing.T) {
	ctx := testContext(t)
	added, err := Add(ctx, "Fix typo", nil, AddOptions{Complexity: "trivial"})
	if err != nil {
		t.Fatal(err)
	}
	tasks, err := LoadAll(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if tasks[0].ID != added.ID || tasks[0].Meta.Complexity == nil || *tasks[0].Meta.Complexity != "trivial" {
		t.Fatalf("tasks = %#v", tasks)
	}
}

func TestParallelAddsClaimDistinctIDs(t *testing.T) {
	ctx := testContext(t)
	results := make(chan Task, 3)
	errs := make(chan error, 3)
	for i := 0; i < 3; i++ {
		go func() {
			added, err := Add(ctx, "Same task", nil, AddOptions{Sharpen: "pending"})
			if err != nil {
				errs <- err
				return
			}
			results <- added
		}()
	}
	var ids []string
	for i := 0; i < 3; i++ {
		select {
		case err := <-errs:
			t.Fatal(err)
		case result := <-results:
			ids = append(ids, result.ID)
		}
	}
	sort.Strings(ids)
	if want := []string{"same-task", "same-task-2", "same-task-3"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids = %#v, want %#v", ids, want)
	}
}

func TestReadArtifact(t *testing.T) {
	ctx := testContext(t)
	added, err := Add(ctx, "Read artifact", nil, AddOptions{})
	if err != nil {
		t.Fatal(err)
	}
	got, err := ReadArtifact(added, "feedback.md")
	if err != nil || got != nil {
		t.Fatalf("got = %#v, err = %v", got, err)
	}
	if err := WriteArtifact(added, "feedback.md", "\n\n## Summary\nDone.\n\n"); err != nil {
		t.Fatal(err)
	}
	got, err = ReadArtifact(added, "feedback.md")
	if err != nil || got == nil || *got != "## Summary\nDone." {
		t.Fatalf("got = %#v, err = %v", got, err)
	}
}

func TestFeedbackAccounting(t *testing.T) {
	ctx := testContext(t)
	added, err := Add(ctx, "Improve layout", nil, AddOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := AppendFeedback(&added, "First note."); err != nil {
		t.Fatal(err)
	}
	if err := AppendFeedback(&added, "Second note."); err != nil {
		t.Fatal(err)
	}
	MarkFeedbackConsumed(&added, 1)
	if PendingFeedbackCount(added) != 1 {
		t.Fatalf("pending count = %d", PendingFeedbackCount(added))
	}
	pending, err := ReadPendingFeedback(added)
	if err != nil {
		t.Fatal(err)
	}
	if pending == nil || !strings.Contains(*pending, "Second note.") || strings.Contains(*pending, "First note.") {
		t.Fatalf("pending = %#v", pending)
	}
}

func TestFailureHistoryRoundTripsJSONL(t *testing.T) {
	ctx := testContext(t)
	added, err := Add(ctx, "Fix failure", nil, AddOptions{})
	if err != nil {
		t.Fatal(err)
	}
	first := Failure{Attempt: 0, Gate: "review", Summary: "missing case", Detail: "full review text"}
	second := Failure{Attempt: 1, Gate: "verify", Summary: "test failed", Detail: "full verify log"}
	if err := AppendFailure(added, first); err != nil {
		t.Fatal(err)
	}
	if err := AppendFailure(added, second); err != nil {
		t.Fatal(err)
	}
	failures, err := ReadFailures(added)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(failures, []Failure{first, second}) {
		t.Fatalf("failures = %#v", failures)
	}
}

func TestMissingFailureHistoryIsEmpty(t *testing.T) {
	ctx := testContext(t)
	added, err := Add(ctx, "No failures", nil, AddOptions{})
	if err != nil {
		t.Fatal(err)
	}
	failures, err := ReadFailures(added)
	if err != nil {
		t.Fatal(err)
	}
	if len(failures) != 0 {
		t.Fatalf("failures = %#v", failures)
	}
}
