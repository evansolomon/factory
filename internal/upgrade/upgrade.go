package upgrade

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	latestReleaseURL = "https://api.github.com/repos/evansolomon/factory/releases/latest"
	installerURL     = "https://raw.githubusercontent.com/evansolomon/factory/master/install.sh"
)

type Error struct {
	Message string
}

func (e Error) Error() string { return e.Message }

type Release struct {
	TagName string
	Version string
}

type HTTPClient interface {
	Do(req *http.Request) (*http.Response, error)
}

func NormalizeGitHubReleaseVersion(tagName string) string {
	return strings.TrimPrefix(tagName, "v")
}

func ShouldInstallLatest(localVersion, latestVersion string) bool {
	return NormalizeGitHubReleaseVersion(localVersion) != NormalizeGitHubReleaseVersion(latestVersion)
}

func FetchLatestRelease(ctx context.Context, client HTTPClient) (Release, error) {
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, latestReleaseURL, nil)
	if err != nil {
		return Release{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "factory")
	resp, err := client.Do(req)
	if err != nil {
		return Release{}, Error{Message: "failed to fetch latest GitHub release: " + err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Release{}, Error{Message: strings.TrimSpace(fmt.Sprintf("failed to fetch latest GitHub release: HTTP %d %s", resp.StatusCode, resp.Status))}
	}
	var body struct {
		TagName string `json:"tag_name"`
	}
	decoder := json.NewDecoder(resp.Body)
	if err := decoder.Decode(&body); err != nil {
		return Release{}, Error{Message: "malformed GitHub release response: invalid JSON"}
	}
	if body.TagName == "" {
		return Release{}, Error{Message: "malformed GitHub release response: invalid or missing tag_name"}
	}
	return Release{TagName: body.TagName, Version: NormalizeGitHubReleaseVersion(body.TagName)}, nil
}

func ResolveCurrentFactoryInstallDir(execPath string) *string {
	if filepath.Base(execPath) != "factory" {
		return nil
	}
	dir := filepath.Dir(execPath)
	return &dir
}

func BuildInstallerEnv(parent []string, installDir *string) []string {
	out := make([]string, 0, len(parent)+1)
	for _, entry := range parent {
		if strings.HasPrefix(entry, "FACTORY_INSTALL_DIR=") {
			continue
		}
		out = append(out, entry)
	}
	if installDir != nil {
		out = append(out, "FACTORY_INSTALL_DIR="+*installDir)
	}
	return out
}

type Options struct {
	CurrentVersion string
	ExecPath       string
	Cwd            string
	Stdout         io.Writer
	Stderr         io.Writer
	Client         HTTPClient
	ParentEnv      []string
}

func Run(opts Options) int {
	stdout := opts.Stdout
	if stdout == nil {
		stdout = io.Discard
	}
	stderr := opts.Stderr
	if stderr == nil {
		stderr = io.Discard
	}
	client := opts.Client
	if client == nil {
		client = http.DefaultClient
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	latest, err := FetchLatestRelease(ctx, client)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if !ShouldInstallLatest(opts.CurrentVersion, latest.Version) {
		fmt.Fprintf(stdout, "already on the latest version (%s)\n", opts.CurrentVersion)
		return 0
	}
	fmt.Fprintf(stdout, "updating %s -> %s\n", opts.CurrentVersion, latest.Version)
	installDir := ResolveCurrentFactoryInstallDir(opts.ExecPath)
	if installDir != nil {
		fmt.Fprintf(stdout, "installing to %s\n", *installDir)
	} else {
		fmt.Fprintln(stderr, "could not detect an existing factory install; using the installer default. Set FACTORY_INSTALL_DIR for a custom install directory.")
	}
	if err := RunLatestInstaller(ctx, client, installDir, opts.ParentEnv, opts.Cwd); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "factory upgraded to %s\n", latest.Version)
	return 0
}

func RunLatestInstaller(ctx context.Context, client HTTPClient, installDir *string, parentEnv []string, cwd string) error {
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, installerURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/plain")
	req.Header.Set("User-Agent", "factory")
	resp, err := client.Do(req)
	if err != nil {
		return Error{Message: "failed to fetch installer: " + err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Error{Message: strings.TrimSpace(fmt.Sprintf("failed to fetch installer: HTTP %d %s", resp.StatusCode, resp.Status))}
	}
	installer, err := io.ReadAll(resp.Body)
	if err != nil {
		return Error{Message: "failed to fetch installer: " + err.Error()}
	}
	cmd := exec.CommandContext(ctx, "bash", "-s")
	if cwd != "" {
		cmd.Dir = cwd
	}
	if parentEnv == nil {
		parentEnv = os.Environ()
	}
	cmd.Env = BuildInstallerEnv(parentEnv, installDir)
	cmd.Stdin = bytes.NewReader(installer)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return Error{Message: "installer timed out"}
		}
		code := 1
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		}
		output := strings.TrimSpace(strings.Join([]string{strings.TrimSpace(stdout.String()), strings.TrimSpace(stderr.String())}, "\n"))
		if output != "" {
			return Error{Message: fmt.Sprintf("installer failed with exit code %d: %s", code, output)}
		}
		return Error{Message: fmt.Sprintf("installer failed with exit code %d", code)}
	}
	return nil
}
