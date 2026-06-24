package backlog

import (
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

type Entry struct {
	ID        string  `json:"id"`
	Intent    string  `json:"intent"`
	Verify    *string `json:"verify"`
	CreatedAt string  `json:"createdAt"`
}

type RemoveResult struct {
	Removed   *Entry
	Ambiguous []Entry
}

func Add(ctx config.RepoContext, intent string, verify *string) (Entry, error) {
	if err := os.MkdirAll(ctx.BacklogDir, 0o755); err != nil {
		return Entry{}, err
	}
	files, err := entryFiles(ctx.BacklogDir)
	if err != nil {
		return Entry{}, err
	}
	existing := map[string]bool{}
	for _, file := range files {
		existing[strings.TrimSuffix(file, ".json")] = true
	}
	slug := slugify(firstLine(intent))
	id := slug
	for n := 2; existing[id]; n++ {
		id = fmt.Sprintf("%s-%d", slug, n)
	}
	entry := Entry{
		ID:        id,
		Intent:    strings.TrimSpace(intent),
		Verify:    verify,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err := writeEntry(filepath.Join(ctx.BacklogDir, id+".json"), entry); err != nil {
		return Entry{}, err
	}
	return entry, nil
}

func Load(ctx config.RepoContext) ([]Entry, error) {
	files, err := entryFiles(ctx.BacklogDir)
	if err != nil {
		return nil, err
	}
	var entries []Entry
	for _, file := range files {
		data, err := os.ReadFile(filepath.Join(ctx.BacklogDir, file))
		if err != nil {
			return nil, err
		}
		var entry Entry
		if err := json.Unmarshal(data, &entry); err == nil && entry.ID != "" {
			entries = append(entries, entry)
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].CreatedAt < entries[j].CreatedAt
	})
	return entries, nil
}

func Remove(ctx config.RepoContext, query string) (*RemoveResult, error) {
	entries, err := Load(ctx)
	if err != nil {
		return nil, err
	}
	var matches []Entry
	for _, entry := range entries {
		if entry.ID == query {
			matches = []Entry{entry}
			break
		}
	}
	if len(matches) == 0 {
		for _, entry := range entries {
			if strings.Contains(entry.ID, query) {
				matches = append(matches, entry)
			}
		}
	}
	if len(matches) == 0 {
		return nil, nil
	}
	if len(matches) > 1 {
		return &RemoveResult{Ambiguous: matches}, nil
	}
	entry := matches[0]
	if err := os.Remove(filepath.Join(ctx.BacklogDir, entry.ID+".json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return &RemoveResult{Removed: &entry}, nil
}

func writeEntry(path string, entry Entry) error {
	data, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func entryFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var files []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			files = append(files, entry.Name())
		}
	}
	sort.Strings(files)
	return files, nil
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
