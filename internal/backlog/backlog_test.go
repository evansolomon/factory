package backlog

import (
	"path/filepath"
	"testing"

	"github.com/evansolomon/factory/internal/config"
)

func repoContext(t *testing.T) config.RepoContext {
	t.Helper()
	root := t.TempDir()
	return config.RepoContext{MainRoot: root, BacklogDir: filepath.Join(root, "state", "backlog")}
}

func TestBacklogAddLoadRemove(t *testing.T) {
	ctx := repoContext(t)
	verify := "go test ./..."
	first, err := Add(ctx, "Same task", &verify)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Add(ctx, "Same task", nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != "same-task" || second.ID != "same-task-2" {
		t.Fatalf("ids = %q, %q", first.ID, second.ID)
	}
	entries, err := Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Verify == nil || *entries[0].Verify != verify {
		t.Fatalf("entries = %#v", entries)
	}
	removed, err := Remove(ctx, "same-task-2")
	if err != nil {
		t.Fatal(err)
	}
	if removed == nil || removed.Removed == nil || removed.Removed.ID != "same-task-2" {
		t.Fatalf("removed = %#v", removed)
	}
	entries, err = Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].ID != "same-task" {
		t.Fatalf("entries = %#v", entries)
	}
}

func TestBacklogRemoveAmbiguous(t *testing.T) {
	ctx := repoContext(t)
	if _, err := Add(ctx, "Alpha one", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := Add(ctx, "Alpha two", nil); err != nil {
		t.Fatal(err)
	}
	removed, err := Remove(ctx, "alpha")
	if err != nil {
		t.Fatal(err)
	}
	if removed == nil || len(removed.Ambiguous) != 2 {
		t.Fatalf("removed = %#v", removed)
	}
}
