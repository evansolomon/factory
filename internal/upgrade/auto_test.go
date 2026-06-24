package upgrade

import (
	"path/filepath"
	"testing"
	"time"
)

func TestAutoUpgradeCommandAllowList(t *testing.T) {
	for _, command := range []string{"add", "backlog", "run", "answer", "feedback", "resume", "correct", "status", "ask", "session", "codex", "claude", "config", "show", "lessons", "report"} {
		if !IsAutoUpgradeCommand(command) {
			t.Fatalf("expected %s to be allowed", command)
		}
	}
	for _, command := range []string{"", "help", "-h", "--help", "version", "--version", "upgrade", "wat"} {
		if IsAutoUpgradeCommand(command) {
			t.Fatalf("expected %s to be skipped", command)
		}
	}
}

func TestShouldRunAutoUpgradeCheck(t *testing.T) {
	now := time.Date(2026, 6, 23, 12, 0, 0, 0, time.UTC)
	recent := &AutoState{LastCheckedAt: now.Add(-time.Second).Format(time.RFC3339Nano)}
	old := &AutoState{LastCheckedAt: now.Add(-AutoCheckInterval - time.Second).Format(time.RFC3339Nano)}
	malformed := &AutoState{LastCheckedAt: "not-a-date"}
	if !ShouldRunAutoUpgradeCheck(nil, now) {
		t.Fatal("missing state should check")
	}
	if ShouldRunAutoUpgradeCheck(recent, now) {
		t.Fatal("recent state should suppress")
	}
	if !ShouldRunAutoUpgradeCheck(old, now) {
		t.Fatal("old state should check")
	}
	if !ShouldRunAutoUpgradeCheck(malformed, now) {
		t.Fatal("malformed state should check")
	}
}

func TestAutoStateRoundTrip(t *testing.T) {
	file := filepath.Join(t.TempDir(), "nested", "auto-upgrade.json")
	now := time.Date(2026, 6, 23, 12, 0, 0, 0, time.UTC)
	if err := WriteAutoState(file, now); err != nil {
		t.Fatal(err)
	}
	state := ReadAutoState(file)
	if state == nil || state.LastCheckedAt != now.Format(time.RFC3339Nano) {
		t.Fatalf("unexpected state: %+v", state)
	}
}
