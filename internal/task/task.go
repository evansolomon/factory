package task

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/evansolomon/factory/internal/config"
)

var settled = map[string]bool{
	"ready":       true,
	"needs-input": true,
	"grilling":    true,
	"retrying":    true,
	"done":        true,
	"blocked":     true,
}

var statuses = map[string]bool{
	"ready":        true,
	"needs-input":  true,
	"sharpening":   true,
	"grilling":     true,
	"planning":     true,
	"implementing": true,
	"reviewing":    true,
	"verifying":    true,
	"shipping":     true,
	"retrying":     true,
	"done":         true,
	"blocked":      true,
}

type Meta struct {
	ID                   string  `json:"id"`
	Slug                 string  `json:"slug"`
	Status               string  `json:"status"`
	Verify               *string `json:"verify"`
	CreatedAt            string  `json:"createdAt"`
	UpdatedAt            *string `json:"updatedAt"`
	Commit               *string `json:"commit"`
	Note                 *string `json:"note"`
	Sharpen              string  `json:"sharpen"`
	Resume               bool    `json:"resume"`
	ResumeNote           *string `json:"resumeNote"`
	ResumeKind           *string `json:"resumeKind"`
	RetryAt              *string `json:"retryAt"`
	AutoRetries          int     `json:"autoRetries"`
	Complexity           *string `json:"complexity"`
	FeedbackCount        int     `json:"feedbackCount"`
	FeedbackConsumed     int     `json:"feedbackConsumed"`
	FeedbackSourceTaskID *string `json:"feedbackSourceTaskId"`
}

type Task struct {
	ID   string
	Dir  string
	Meta Meta
}

type AddOptions struct {
	Status               string
	Sharpen              string
	Complexity           string
	FeedbackSourceTaskID string
}

type Failure struct {
	Attempt int    `json:"attempt"`
	Gate    string `json:"gate"`
	Summary string `json:"summary"`
	Detail  string `json:"detail"`
}

func IsStranded(status string) bool {
	return !settled[status]
}

func Add(ctx config.WorkContext, intent string, verify *string, opts AddOptions) (Task, error) {
	if err := os.MkdirAll(ctx.TasksDir, 0o755); err != nil {
		return Task{}, err
	}
	slug := slugify(firstLine(intent))
	id := slug
	dir := filepath.Join(ctx.TasksDir, id)
	for n := 2; ; n++ {
		err := os.Mkdir(dir, 0o755)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrExist) {
			return Task{}, err
		}
		id = fmt.Sprintf("%s-%d", slug, n)
		dir = filepath.Join(ctx.TasksDir, id)
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	status := opts.Status
	if status == "" {
		status = "ready"
	}
	sharpen := opts.Sharpen
	if sharpen == "" {
		sharpen = "done"
	}
	var complexity *string
	if opts.Complexity != "" {
		complexity = &opts.Complexity
	}
	var feedbackSource *string
	if opts.FeedbackSourceTaskID != "" {
		feedbackSource = &opts.FeedbackSourceTaskID
	}
	meta := Meta{
		ID:                   id,
		Slug:                 slug,
		Status:               status,
		Verify:               verify,
		CreatedAt:            now,
		UpdatedAt:            &now,
		Commit:               nil,
		Note:                 nil,
		Sharpen:              sharpen,
		Resume:               false,
		ResumeNote:           nil,
		ResumeKind:           nil,
		RetryAt:              nil,
		AutoRetries:          0,
		Complexity:           complexity,
		FeedbackCount:        0,
		FeedbackConsumed:     0,
		FeedbackSourceTaskID: feedbackSource,
	}
	if err := os.WriteFile(filepath.Join(dir, "task.md"), []byte(strings.TrimSpace(intent)+"\n"), 0o644); err != nil {
		return Task{}, err
	}
	if err := writeMeta(dir, meta); err != nil {
		return Task{}, err
	}
	return Task{ID: id, Dir: dir, Meta: meta}, nil
}

func LoadAll(ctx config.WorkContext) ([]Task, error) {
	entries, err := os.ReadDir(ctx.TasksDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var tasks []Task
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(ctx.TasksDir, entry.Name())
		meta, err := readMeta(filepath.Join(dir, "meta.json"))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, Task{ID: entry.Name(), Dir: dir, Meta: meta})
	}
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].Meta.CreatedAt < tasks[j].Meta.CreatedAt
	})
	return tasks, nil
}

func NextRunnable(ctx config.WorkContext, now time.Time) (*Task, error) {
	tasks, err := LoadAll(ctx)
	if err != nil {
		return nil, err
	}
	for i := range tasks {
		if tasks[i].Meta.Status == "ready" {
			return &tasks[i], nil
		}
	}
	for i := range tasks {
		if IsStranded(tasks[i].Meta.Status) {
			return recoverStranded(&tasks[i])
		}
	}
	var due []*Task
	for i := range tasks {
		retryAt := tasks[i].Meta.RetryAt
		if tasks[i].Meta.Status != "retrying" || retryAt == nil {
			continue
		}
		parsed, err := time.Parse(time.RFC3339Nano, *retryAt)
		if err != nil {
			parsed, err = time.Parse(time.RFC3339, *retryAt)
		}
		if err == nil && !parsed.After(now) {
			due = append(due, &tasks[i])
		}
	}
	sort.Slice(due, func(i, j int) bool {
		return value(due[i].Meta.RetryAt) < value(due[j].Meta.RetryAt)
	})
	if len(due) == 0 {
		return nil, nil
	}
	return resumeRun(due[0], "auto-retry")
}

func Latest(ctx config.WorkContext, wanted ...string) (*Task, error) {
	tasks, err := LoadAll(ctx)
	if err != nil {
		return nil, err
	}
	want := map[string]bool{}
	for _, status := range wanted {
		want[status] = true
	}
	var latest *Task
	for i := range tasks {
		if len(want) > 0 && !want[tasks[i].Meta.Status] {
			continue
		}
		if latest == nil || stamp(tasks[i]) > stamp(*latest) {
			latest = &tasks[i]
		}
	}
	return latest, nil
}

func Find(ctx config.WorkContext, query string) (*Task, error) {
	tasks, err := LoadAll(ctx)
	if err != nil {
		return nil, err
	}
	for i := range tasks {
		if tasks[i].ID == query {
			return &tasks[i], nil
		}
	}
	for i := range tasks {
		if strings.Contains(tasks[i].ID, query) {
			return &tasks[i], nil
		}
	}
	return nil, nil
}

func SetStatus(task *Task, status string, note *string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	task.Meta.Status = status
	task.Meta.Note = note
	task.Meta.UpdatedAt = &now
	return writeMeta(task.Dir, task.Meta)
}

func SaveMeta(task Task) error {
	return writeMeta(task.Dir, task.Meta)
}

func ReadArtifact(task Task, name string) (*string, error) {
	data, err := os.ReadFile(filepath.Join(task.Dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	text := strings.TrimSpace(string(data))
	return &text, nil
}

func WriteArtifact(task Task, name, content string) error {
	return os.WriteFile(filepath.Join(task.Dir, name), []byte(content), 0o644)
}

func ReadIntent(task Task) (string, error) {
	data, err := os.ReadFile(filepath.Join(task.Dir, "task.md"))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func ReadySharpened(task *Task, intent string, verify *string) error {
	if err := os.WriteFile(filepath.Join(task.Dir, "task.md"), []byte(strings.TrimSpace(intent)+"\n"), 0o644); err != nil {
		return err
	}
	task.Meta.Verify = verify
	task.Meta.Sharpen = "done"
	return SetStatus(task, "ready", nil)
}

func AppendAnswer(task Task, text string) error {
	path := filepath.Join(task.Dir, "answers.md")
	existing := readOptional(path)
	entry := fmt.Sprintf("## Answer (%s)\n%s\n", time.Now().UTC().Format(time.RFC3339Nano), strings.TrimSpace(text))
	if existing != "" {
		entry = existing + "\n\n" + entry
	}
	return os.WriteFile(path, []byte(entry), 0o644)
}

func ReadAnswers(task Task) (*string, error) {
	return ReadArtifact(task, "answers.md")
}

func AppendFeedback(task *Task, text string) error {
	path := filepath.Join(task.Dir, "human-feedback.md")
	existing := readOptional(path)
	entry := fmt.Sprintf("## Feedback (%s)\n\n%s\n", time.Now().UTC().Format(time.RFC3339Nano), strings.TrimSpace(text))
	if existing != "" {
		entry = existing + "\n\n" + entry
	}
	if err := os.WriteFile(path, []byte(entry), 0o644); err != nil {
		return err
	}
	task.Meta.FeedbackCount++
	now := time.Now().UTC().Format(time.RFC3339Nano)
	task.Meta.UpdatedAt = &now
	return writeMeta(task.Dir, task.Meta)
}

func ReadFeedback(task Task) (*string, error) {
	return ReadArtifact(task, "human-feedback.md")
}

func PendingFeedbackCount(task Task) int {
	count := task.Meta.FeedbackCount - task.Meta.FeedbackConsumed
	if count < 0 {
		return 0
	}
	return count
}

func ReadPendingFeedback(task Task) (*string, error) {
	text, err := ReadFeedback(task)
	if err != nil || text == nil {
		return nil, err
	}
	entries := feedbackEntries(*text)
	if task.Meta.FeedbackConsumed >= len(entries) {
		return nil, nil
	}
	pending := strings.Join(entries[task.Meta.FeedbackConsumed:], "\n\n")
	return &pending, nil
}

func MarkFeedbackConsumed(task *Task, count int) {
	if count > task.Meta.FeedbackConsumed {
		task.Meta.FeedbackConsumed = count
	}
}

func ReadFailures(task Task) ([]Failure, error) {
	file, err := os.Open(filepath.Join(task.Dir, "failures.jsonl"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var failures []Failure
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var failure Failure
		if err := json.Unmarshal([]byte(line), &failure); err == nil {
			failures = append(failures, failure)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return failures, nil
}

func AppendFailure(task Task, failure Failure) error {
	path := filepath.Join(task.Dir, "failures.jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	data, err := json.Marshal(failure)
	if err != nil {
		return err
	}
	if _, err := file.Write(append(data, '\n')); err != nil {
		return err
	}
	return nil
}

func readMeta(path string) (Meta, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Meta{}, err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return Meta{}, err
	}
	meta := Meta{
		Status:               "ready",
		Verify:               nil,
		UpdatedAt:            nil,
		Commit:               nil,
		Note:                 nil,
		Sharpen:              "done",
		Resume:               false,
		ResumeNote:           nil,
		ResumeKind:           nil,
		RetryAt:              nil,
		AutoRetries:          0,
		Complexity:           nil,
		FeedbackCount:        0,
		FeedbackConsumed:     0,
		FeedbackSourceTaskID: nil,
	}
	requiredString(raw, "id", &meta.ID)
	requiredString(raw, "slug", &meta.Slug)
	requiredString(raw, "createdAt", &meta.CreatedAt)
	optionalString(raw, "status", &meta.Status)
	optionalNullableString(raw, "verify", &meta.Verify)
	optionalNullableString(raw, "updatedAt", &meta.UpdatedAt)
	optionalNullableString(raw, "commit", &meta.Commit)
	optionalNullableString(raw, "note", &meta.Note)
	optionalString(raw, "sharpen", &meta.Sharpen)
	optionalBool(raw, "resume", &meta.Resume)
	optionalNullableString(raw, "resumeNote", &meta.ResumeNote)
	optionalNullableString(raw, "resumeKind", &meta.ResumeKind)
	optionalNullableString(raw, "retryAt", &meta.RetryAt)
	optionalInt(raw, "autoRetries", &meta.AutoRetries)
	optionalNullableString(raw, "complexity", &meta.Complexity)
	optionalInt(raw, "feedbackCount", &meta.FeedbackCount)
	optionalInt(raw, "feedbackConsumed", &meta.FeedbackConsumed)
	optionalNullableString(raw, "feedbackSourceTaskId", &meta.FeedbackSourceTaskID)
	if !statuses[meta.Status] {
		return Meta{}, fmt.Errorf("invalid task status %q", meta.Status)
	}
	if meta.Complexity != nil && *meta.Complexity != "trivial" && *meta.Complexity != "complex" {
		return Meta{}, fmt.Errorf("invalid task complexity %q", *meta.Complexity)
	}
	return meta, nil
}

func writeMeta(dir string, meta Meta) error {
	finalPath := filepath.Join(dir, "meta.json")
	tmpPath := filepath.Join(dir, fmt.Sprintf(".meta.%d.%d.tmp", os.Getpid(), time.Now().UnixNano()))
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmpPath, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmpPath, finalPath)
}

func resumeRun(task *Task, kind string) (*Task, error) {
	task.Meta.Resume = true
	task.Meta.ResumeKind = &kind
	task.Meta.RetryAt = nil
	if err := SetStatus(task, "ready", nil); err != nil {
		return nil, err
	}
	return task, nil
}

func recoverStranded(task *Task) (*Task, error) {
	status := task.Meta.Status
	if status == "sharpening" || status == "planning" {
		task.Meta.Resume = false
		task.Meta.ResumeKind = nil
		task.Meta.RetryAt = nil
		note := fmt.Sprintf("recovered after interrupted %s stage", status)
		if err := SetStatus(task, "ready", &note); err != nil {
			return nil, err
		}
		return task, nil
	}
	note := fmt.Sprintf("Recovered after interrupted %s stage. Inspect existing work and continue from the saved artifacts.", status)
	task.Meta.ResumeNote = &note
	return resumeRun(task, "stranded")
}

func slugify(text string) string {
	text = strings.ToLower(text)
	re := regexp.MustCompile(`[^a-z0-9]+`)
	slug := re.ReplaceAllString(text, "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > 40 {
		slug = slug[:40]
	}
	slug = strings.TrimRight(slug, "-")
	if slug == "" {
		return "task"
	}
	return slug
}

func firstLine(text string) string {
	text = strings.TrimSpace(text)
	if i := strings.IndexByte(text, '\n'); i >= 0 {
		return text[:i]
	}
	return text
}

func stamp(task Task) string {
	if task.Meta.UpdatedAt != nil {
		return *task.Meta.UpdatedAt
	}
	return task.Meta.CreatedAt
}

func value(ptr *string) string {
	if ptr == nil {
		return ""
	}
	return *ptr
}

func readOptional(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func feedbackEntries(text string) []string {
	re := regexp.MustCompile(`(?m)^## Feedback \([^)]+\)\n`)
	starts := re.FindAllStringIndex(text, -1)
	var entries []string
	for i, start := range starts {
		end := len(text)
		if i+1 < len(starts) {
			end = starts[i+1][0]
		}
		entry := strings.TrimSpace(text[start[0]:end])
		if entry != "" {
			entries = append(entries, entry)
		}
	}
	return entries
}

func requiredString(raw map[string]json.RawMessage, key string, dst *string) {
	if value, ok := raw[key]; ok {
		_ = json.Unmarshal(value, dst)
	}
}

func optionalString(raw map[string]json.RawMessage, key string, dst *string) {
	requiredString(raw, key, dst)
}

func optionalNullableString(raw map[string]json.RawMessage, key string, dst **string) {
	value, ok := raw[key]
	if !ok || string(value) == "null" {
		return
	}
	var parsed string
	if err := json.Unmarshal(value, &parsed); err == nil {
		*dst = &parsed
	}
}

func optionalBool(raw map[string]json.RawMessage, key string, dst *bool) {
	if value, ok := raw[key]; ok {
		_ = json.Unmarshal(value, dst)
	}
}

func optionalInt(raw map[string]json.RawMessage, key string, dst *int) {
	if value, ok := raw[key]; ok {
		_ = json.Unmarshal(value, dst)
	}
}
