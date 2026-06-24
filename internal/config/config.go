package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/evansolomon/factory/internal/gitutil"
)

type ConfigError struct {
	Message string
}

func (e ConfigError) Error() string { return e.Message }

type Agent struct {
	CLI      string `json:"cli"`
	Model    string `json:"model,omitempty"`
	Provider string `json:"provider,omitempty"`
}

type RoleAgents struct {
	Planners    []Agent
	Implementer Agent
	Reviewer    Agent
	Delivery    Agent
}

type Agents struct {
	Planners    []Agent `json:"planners"`
	Implementer Agent   `json:"implementer"`
	Reviewer    Agent   `json:"reviewer"`
	Delivery    Agent   `json:"delivery"`
}

type Ask struct {
	Agent Agent `json:"agent"`
}

type OnComplete struct {
	Skill  string `json:"skill,omitempty"`
	Policy string `json:"policy,omitempty"`
}

type Config struct {
	Dir          string              `json:"dir,omitempty"`
	Retries      int                 `json:"retries"`
	Triage       bool                `json:"triage"`
	Security     bool                `json:"security"`
	UX           bool                `json:"ux"`
	PlansDir     *string             `json:"plansDir"`
	CaptureEvals bool                `json:"captureEvals"`
	Postmortem   bool                `json:"postmortem"`
	Remediate    bool                `json:"remediate"`
	OnComplete   *OnComplete         `json:"onComplete"`
	Hooks        map[string][]string `json:"hooks"`
	Agents       Agents              `json:"agents"`
	Ask          Ask                 `json:"ask"`
}

type WorkContext struct {
	Root         string
	Config       Config
	StateDir     string
	TasksDir     string
	PlansDir     string
	Agents       RoleAgents
	AskAgent     Agent
	RepoStateDir string
	MetricsPath  string
}

type RepoContext struct {
	MainRoot    string
	Config      Config
	BacklogDir  string
	MetricsPath string
	Agents      RoleAgents
}

type rawConfig struct {
	Dir          *string             `json:"dir"`
	Retries      *int                `json:"retries"`
	Triage       *bool               `json:"triage"`
	Security     *bool               `json:"security"`
	UX           *bool               `json:"ux"`
	PlansDir     *nullableString     `json:"plansDir"`
	CaptureEvals *bool               `json:"captureEvals"`
	Postmortem   *bool               `json:"postmortem"`
	Remediate    *bool               `json:"remediate"`
	OnComplete   *OnComplete         `json:"onComplete"`
	Hooks        map[string][]string `json:"hooks"`
	Agents       *rawAgents          `json:"agents"`
	Ask          *rawAsk             `json:"ask"`
}

type rawAgents struct {
	Planners    []Agent `json:"planners"`
	Implementer *Agent  `json:"implementer"`
	Reviewer    *Agent  `json:"reviewer"`
	Delivery    *Agent  `json:"delivery"`
}

type rawAsk struct {
	Agent *Agent `json:"agent"`
}

type nullableString struct {
	Value string
	Valid bool
}

func (s *nullableString) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		s.Valid = false
		s.Value = ""
		return nil
	}
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	s.Valid = true
	s.Value = value
	return nil
}

func (a *Agent) UnmarshalJSON(data []byte) error {
	var cli string
	if err := json.Unmarshal(data, &cli); err == nil {
		return setAgent(a, cli, "", "")
	}
	var obj struct {
		CLI      string `json:"cli"`
		Model    string `json:"model"`
		Provider string `json:"provider"`
	}
	if err := json.Unmarshal(data, &obj); err != nil {
		return err
	}
	return setAgent(a, obj.CLI, obj.Model, obj.Provider)
}

func setAgent(a *Agent, cli, model, provider string) error {
	if cli != "codex" && cli != "claude" {
		return fmt.Errorf(`expected "codex" or "claude"`)
	}
	if provider != "" && cli != "codex" {
		return errors.New("provider is only supported for the codex cli")
	}
	if provider != "" && model == "" {
		return errors.New("provider requires an explicit model")
	}
	*a = Agent{CLI: cli, Model: model, Provider: provider}
	return nil
}

func Default() Config {
	plansDir := ".coding-agent-plans"
	return Config{
		Retries:      10,
		Triage:       true,
		Security:     true,
		UX:           true,
		PlansDir:     &plansDir,
		CaptureEvals: true,
		Postmortem:   true,
		Remediate:    true,
		Hooks:        map[string][]string{},
		Agents: Agents{
			Planners:    []Agent{{CLI: "codex"}, {CLI: "claude"}},
			Implementer: Agent{CLI: "codex"},
			Reviewer:    Agent{CLI: "claude"},
			Delivery:    Agent{CLI: "claude"},
		},
		Ask: Ask{Agent: Agent{CLI: "claude"}},
	}
}

func GlobalConfigFile() string {
	return filepath.Join(FactoryHome(), "config.json")
}

func AutoUpgradeStateFile() string {
	return filepath.Join(FactoryHome(), "auto-upgrade.json")
}

func Load(root string) (Config, error) {
	cfg := Default()
	var sources []string
	for _, path := range configCandidates(root) {
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return Config{}, err
		}
		var raw rawConfig
		if err := json.Unmarshal(data, &raw); err != nil {
			return Config{}, ConfigError{Message: fmt.Sprintf("invalid JSON config\n\n  %s: %s", path, err)}
		}
		if err := applyRaw(&cfg, raw, path); err != nil {
			return Config{}, err
		}
		sources = append(sources, path)
	}
	_ = sources
	return cfg, nil
}

func Sources(root string) ([]string, error) {
	var found []string
	for _, path := range configCandidates(root) {
		if _, err := os.Stat(path); err == nil {
			found = append(found, path)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(found)))
	return found, nil
}

func LoadContext(cwd string) (WorkContext, error) {
	root, err := gitutil.RepoRoot(cwd)
	if err != nil {
		return WorkContext{}, err
	}
	cfg, err := Load(root)
	if err != nil {
		return WorkContext{}, err
	}
	stateDir := resolveStateDir(root, cfg)
	mainRoot, err := gitutil.MainWorktreeRoot(cwd)
	if err != nil {
		return WorkContext{}, err
	}
	mainConfig := cfg
	if mainRoot != root {
		mainConfig, err = Load(mainRoot)
		if err != nil {
			return WorkContext{}, err
		}
	}
	repoStateDir := resolveStateDir(mainRoot, mainConfig)
	return WorkContext{
		Root:         root,
		Config:       cfg,
		StateDir:     stateDir,
		TasksDir:     filepath.Join(stateDir, "tasks"),
		PlansDir:     resolvePlansDir(root, cfg),
		Agents:       resolveAgents(cfg),
		AskAgent:     cfg.Ask.Agent,
		RepoStateDir: repoStateDir,
		MetricsPath:  filepath.Join(repoStateDir, "metrics.db"),
	}, nil
}

func LoadRepoContext(cwd string) (RepoContext, error) {
	mainRoot, err := gitutil.MainWorktreeRoot(cwd)
	if err != nil {
		return RepoContext{}, err
	}
	cfg, err := Load(mainRoot)
	if err != nil {
		return RepoContext{}, err
	}
	stateDir := resolveStateDir(mainRoot, cfg)
	return RepoContext{
		MainRoot:    mainRoot,
		Config:      cfg,
		BacklogDir:  filepath.Join(stateDir, "backlog"),
		MetricsPath: filepath.Join(stateDir, "metrics.db"),
		Agents:      resolveAgents(cfg),
	}, nil
}

func applyRaw(cfg *Config, raw rawConfig, path string) error {
	if raw.Retries != nil {
		if *raw.Retries < 0 {
			return ConfigError{Message: fmt.Sprintf("invalid .factory.json config\n\nset in:\n  %s\n\nproblems:\n  retries: expected a nonnegative integer", path)}
		}
		cfg.Retries = *raw.Retries
	}
	if raw.Dir != nil {
		cfg.Dir = *raw.Dir
	}
	if raw.Triage != nil {
		cfg.Triage = *raw.Triage
	}
	if raw.Security != nil {
		cfg.Security = *raw.Security
	}
	if raw.UX != nil {
		cfg.UX = *raw.UX
	}
	if raw.PlansDir != nil {
		if raw.PlansDir.Valid {
			value := raw.PlansDir.Value
			cfg.PlansDir = &value
		} else {
			cfg.PlansDir = nil
		}
	}
	if raw.CaptureEvals != nil {
		cfg.CaptureEvals = *raw.CaptureEvals
	}
	if raw.Postmortem != nil {
		cfg.Postmortem = *raw.Postmortem
	}
	if raw.Remediate != nil {
		cfg.Remediate = *raw.Remediate
	}
	if raw.OnComplete != nil {
		cfg.OnComplete = raw.OnComplete
	}
	if raw.Hooks != nil {
		cfg.Hooks = mergeHooks(cfg.Hooks, raw.Hooks)
	}
	if raw.Agents != nil {
		if raw.Agents.Planners != nil {
			cfg.Agents.Planners = raw.Agents.Planners
		}
		if raw.Agents.Implementer != nil {
			cfg.Agents.Implementer = *raw.Agents.Implementer
		}
		if raw.Agents.Reviewer != nil {
			cfg.Agents.Reviewer = *raw.Agents.Reviewer
		}
		if raw.Agents.Delivery != nil {
			cfg.Agents.Delivery = *raw.Agents.Delivery
		}
	}
	if raw.Ask != nil && raw.Ask.Agent != nil {
		cfg.Ask.Agent = *raw.Ask.Agent
	}
	return nil
}

func mergeHooks(base, incoming map[string][]string) map[string][]string {
	merged := map[string][]string{}
	for event, commands := range base {
		merged[event] = append([]string{}, commands...)
	}
	for event, commands := range incoming {
		seen := map[string]bool{}
		for _, command := range merged[event] {
			seen[command] = true
		}
		for _, command := range commands {
			if !seen[command] {
				merged[event] = append(merged[event], command)
				seen[command] = true
			}
		}
	}
	return merged
}

func configCandidates(root string) []string {
	candidates := []string{GlobalConfigFile()}
	dirs := ancestorDirs(root)
	for i := len(dirs) - 1; i >= 0; i-- {
		candidates = append(candidates, filepath.Join(dirs[i], ".factory.json"))
	}
	return candidates
}

func ancestorDirs(root string) []string {
	var dirs []string
	for {
		dirs = append(dirs, root)
		parent := filepath.Dir(root)
		if parent == root {
			return dirs
		}
		root = parent
	}
}

func FactoryHome() string {
	if value := os.Getenv("FACTORY_HOME"); value != "" {
		return expandTilde(value)
	}
	return expandTilde("~/.factory")
}

func expandTilde(path string) string {
	if strings.HasPrefix(path, "~") {
		home, _ := os.UserHomeDir()
		return home + strings.TrimPrefix(path, "~")
	}
	return path
}

func worktreeKey(root string) string {
	return strings.TrimLeft(strings.ReplaceAll(root, string(filepath.Separator), "-"), "-")
}

func resolveStateDir(root string, cfg Config) string {
	if cfg.Dir != "" {
		if filepath.IsAbs(cfg.Dir) || strings.HasPrefix(cfg.Dir, "~") {
			return filepath.Join(expandTilde(cfg.Dir), worktreeKey(root))
		}
		return filepath.Join(root, cfg.Dir)
	}
	return filepath.Join(FactoryHome(), "sessions", worktreeKey(root))
}

func resolvePlansDir(root string, cfg Config) string {
	if cfg.PlansDir == nil || *cfg.PlansDir == "" {
		return ""
	}
	if filepath.IsAbs(*cfg.PlansDir) || strings.HasPrefix(*cfg.PlansDir, "~") {
		return expandTilde(*cfg.PlansDir)
	}
	return filepath.Join(root, *cfg.PlansDir)
}

func resolveAgents(cfg Config) RoleAgents {
	return RoleAgents{
		Planners:    cfg.Agents.Planners,
		Implementer: cfg.Agents.Implementer,
		Reviewer:    cfg.Agents.Reviewer,
		Delivery:    cfg.Agents.Delivery,
	}
}
