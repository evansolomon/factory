package upgrade

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/evansolomon/factory/internal/config"
)

const AutoCheckInterval = 7 * 24 * time.Hour
const autoCheckTimeout = 2 * time.Second

type AutoState struct {
	LastCheckedAt string `json:"lastCheckedAt"`
}

type AutoOptions struct {
	Command        string
	CurrentVersion string
	ExecPath       string
	Cwd            string
	Stdin          *os.File
	StdoutFile     *os.File
	Stdout         io.Writer
	Stderr         io.Writer
	Client         HTTPClient
	Now            time.Time
	StateFile      string
	ParentEnv      []string
}

func MaybeAutoUpgrade(opts AutoOptions) (int, bool) {
	accepted := shouldAutoUpgradeNow(opts)
	if !accepted {
		return 0, false
	}
	code := Run(Options{
		CurrentVersion: opts.CurrentVersion,
		ExecPath:       opts.ExecPath,
		Cwd:            opts.Cwd,
		Stdout:         opts.Stdout,
		Stderr:         opts.Stderr,
		Client:         opts.Client,
		ParentEnv:      opts.ParentEnv,
	})
	if code == 0 {
		fmt.Fprintf(opts.Stdout, "re-run `factory %s` to continue on the new version\n", opts.Command)
	}
	return code, true
}

func IsAutoUpgradeCommand(command string) bool {
	switch command {
	case "add", "backlog", "run", "answer", "feedback", "resume", "correct", "status", "ask", "session", "codex", "claude", "config", "show", "lessons", "report":
		return true
	default:
		return false
	}
}

func IsDevVersion(version string) bool {
	return strings.Contains(version, "-dev.")
}

func ShouldRunAutoUpgradeCheck(state *AutoState, now time.Time) bool {
	if state == nil {
		return true
	}
	last, err := time.Parse(time.RFC3339Nano, state.LastCheckedAt)
	if err != nil {
		return true
	}
	return now.Sub(last) >= AutoCheckInterval
}

func ReadAutoState(file string) *AutoState {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var state AutoState
	if err := json.Unmarshal(data, &state); err != nil || state.LastCheckedAt == "" {
		return nil
	}
	return &state
}

func WriteAutoState(file string, now time.Time) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(AutoState{LastCheckedAt: now.Format(time.RFC3339Nano)}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(file, append(data, '\n'), 0o644)
}

func shouldAutoUpgradeNow(opts AutoOptions) bool {
	defer func() {
		_ = recover()
	}()
	if os.Getenv("FACTORY_DISABLE_AUTO_UPGRADE") != "" {
		return false
	}
	if !IsAutoUpgradeCommand(opts.Command) {
		return false
	}
	if opts.Stdin == nil {
		opts.Stdin = os.Stdin
	}
	if opts.StdoutFile == nil {
		opts.StdoutFile = os.Stdout
	}
	if !isTerminalFile(opts.Stdin) || !isTerminalFile(opts.StdoutFile) {
		return false
	}
	if ResolveCurrentFactoryInstallDir(opts.ExecPath) == nil {
		return false
	}
	if IsDevVersion(opts.CurrentVersion) {
		return false
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	stateFile := opts.StateFile
	if stateFile == "" {
		stateFile = config.AutoUpgradeStateFile()
	}
	if !ShouldRunAutoUpgradeCheck(ReadAutoState(stateFile), now) {
		return false
	}
	if err := WriteAutoState(stateFile, now); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), autoCheckTimeout)
	defer cancel()
	latest, err := FetchLatestRelease(ctx, opts.Client)
	if err != nil || !ShouldInstallLatest(opts.CurrentVersion, latest.Version) {
		return false
	}
	stdout := opts.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	fmt.Fprintf(stdout, "a newer factory is available: %s -> %s\nupgrade now? [y/N] ", stripControlChars(opts.CurrentVersion), stripControlChars(latest.Version))
	reader := bufio.NewReader(opts.Stdin)
	answer, err := reader.ReadString('\n')
	if err != nil && strings.TrimSpace(answer) == "" {
		return false
	}
	normalized := strings.ToLower(strings.TrimSpace(answer))
	return normalized == "y" || normalized == "yes"
}

func isTerminalFile(file *os.File) bool {
	info, err := file.Stat()
	return err == nil && (info.Mode()&os.ModeCharDevice) != 0
}

func stripControlChars(value string) string {
	var builder strings.Builder
	for _, char := range value {
		if (char >= 0 && char <= 31) || (char >= 127 && char <= 159) {
			continue
		}
		builder.WriteRune(char)
	}
	return builder.String()
}
