package gitutil

import (
	"errors"
	"os/exec"
	"strings"
)

var ErrNotRepo = errors.New("not in a git repository - run factory from inside a repo")

func RepoRoot(cwd string) (string, error) {
	out, err := git(cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", ErrNotRepo
	}
	return strings.TrimSpace(out), nil
}

func MainWorktreeRoot(cwd string) (string, error) {
	out, err := git(cwd, "worktree", "list", "--porcelain")
	if err != nil {
		return "", ErrNotRepo
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "worktree ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "worktree ")), nil
		}
	}
	return RepoRoot(cwd)
}

func HasChanges(root string) bool {
	out, err := git(root, "status", "--porcelain")
	return err == nil && strings.TrimSpace(out) != ""
}

func WorktreeDiff(root string) string {
	status, _ := git(root, "status", "--porcelain")
	diff, _ := git(root, "diff", "HEAD")
	return "# git status\n" + status + "\n# git diff HEAD\n" + diff
}

func CommitAll(root, message string) error {
	if _, err := git(root, "add", "-A"); err != nil {
		return err
	}
	_, err := git(root, "commit", "-m", message)
	return err
}

func HeadSHA(root string) (string, error) {
	out, err := git(root, "rev-parse", "--short", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

func CurrentBranch(root string) string {
	out, err := git(root, "branch", "--show-current")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

func git(cwd string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", cwd}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
