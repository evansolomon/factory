package lessons

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/evansolomon/factory/internal/config"
)

const candidatesHeader = "# Lesson candidates\n\nRaw signals from blocks and questions. Curate the recurring ones into\nLESSONS.md (which the planner reads every run); delete the noise.\n\n"

func LessonsPath(ctx config.WorkContext) string {
	return filepath.Join(ctx.RepoStateDir, "LESSONS.md")
}

func CandidatesPath(ctx config.WorkContext) string {
	return filepath.Join(ctx.RepoStateDir, "LESSONS.candidates.md")
}

func ReadLessons(ctx config.WorkContext) (string, error) {
	return readTrimmed(LessonsPath(ctx))
}

func ReadCandidates(ctx config.WorkContext) (string, error) {
	return readTrimmed(CandidatesPath(ctx))
}

func AppendCandidate(ctx config.WorkContext, signal string) {
	path := CandidatesPath(ctx)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	existingBytes, err := os.ReadFile(path)
	existing := candidatesHeader
	if err == nil {
		existing = string(existingBytes)
	}
	line := fmt.Sprintf("- %s - %s\n", time.Now().UTC().Format(time.RFC3339Nano), strings.TrimSpace(signal))
	_ = os.WriteFile(path, []byte(existing+line), 0o644)
}

func readTrimmed(path string) (string, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}
