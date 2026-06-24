package upgrade

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (r roundTrip) Do(req *http.Request) (*http.Response, error) {
	return r(req)
}

func response(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func TestVersionComparison(t *testing.T) {
	if NormalizeGitHubReleaseVersion("v0.1.0") != "0.1.0" {
		t.Fatal("expected leading v to be stripped")
	}
	if ShouldInstallLatest("0.1.0", "v0.1.0") {
		t.Fatal("same normalized versions should not upgrade")
	}
	if !ShouldInstallLatest("0.1.0", "0.1.1") {
		t.Fatal("different versions should upgrade")
	}
}

func TestFetchLatestRelease(t *testing.T) {
	release, err := FetchLatestRelease(context.Background(), roundTrip(func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("User-Agent") != "factory" {
			t.Fatalf("missing user agent: %s", req.Header.Get("User-Agent"))
		}
		return response(200, `{"tag_name":"v0.1.0"}`), nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	if release.TagName != "v0.1.0" || release.Version != "0.1.0" {
		t.Fatalf("unexpected release: %+v", release)
	}
}

func TestFetchLatestReleaseRejectsMalformedResponse(t *testing.T) {
	_, err := FetchLatestRelease(context.Background(), roundTrip(func(req *http.Request) (*http.Response, error) {
		return response(200, `{}`), nil
	}))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestResolveCurrentFactoryInstallDir(t *testing.T) {
	dir := ResolveCurrentFactoryInstallDir("/Users/evan/.local/bin/factory")
	if dir == nil || *dir != "/Users/evan/.local/bin" {
		t.Fatalf("unexpected install dir: %v", dir)
	}
	if ResolveCurrentFactoryInstallDir("/opt/homebrew/bin/bun") != nil {
		t.Fatal("source runner should not resolve install dir")
	}
}

func TestBuildInstallerEnv(t *testing.T) {
	dir := "/factory/bin"
	env := BuildInstallerEnv([]string{"PATH=/bin", "FACTORY_INSTALL_DIR=/old"}, &dir)
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "PATH=/bin") || !strings.Contains(joined, "FACTORY_INSTALL_DIR=/factory/bin") {
		t.Fatalf("unexpected env: %#v", env)
	}
	if strings.Contains(joined, "FACTORY_INSTALL_DIR=/old") {
		t.Fatalf("old install dir was not removed: %#v", env)
	}
}
