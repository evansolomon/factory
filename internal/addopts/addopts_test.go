package addopts

import (
	"reflect"
	"strings"
	"testing"
)

func mustParse(t *testing.T, args []string) Parsed {
	t.Helper()
	parsed, err := Parse(args)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustError(t *testing.T, args []string) string {
	t.Helper()
	_, err := Parse(args)
	if err == nil {
		t.Fatal("expected parse failure")
	}
	return err.Error()
}

func TestParseAddOptions(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want Parsed
	}{
		{"trivial", []string{"--trivial", "Fix", "typo"}, Parsed{Args: []string{"Fix", "typo"}, Complexity: "trivial"}},
		{"complexity trivial", []string{"--complexity", "trivial", "Fix", "typo"}, Parsed{Args: []string{"Fix", "typo"}, Complexity: "trivial"}},
		{"complexity complex", []string{"--complexity", "complex", "Refactor", "parser"}, Parsed{Args: []string{"Refactor", "parser"}, Complexity: "complex"}},
		{"redundant trivial", []string{"--trivial", "--complexity", "trivial", "Fix", "typo"}, Parsed{Args: []string{"Fix", "typo"}, Complexity: "trivial"}},
		{"verify", []string{"--complexity", "trivial", "Fix", "typo", "--verify", "bun", "test"}, Parsed{Args: []string{"Fix", "typo", "--verify", "bun", "test"}, Complexity: "trivial"}},
		{"verify preserves raw", []string{"Fix", "typo", "--verify", "bun", "test", "--raw"}, Parsed{Args: []string{"Fix", "typo", "--verify", "bun", "test", "--raw"}}},
		{"raw", []string{"--raw", "Fix", "typo"}, Parsed{Args: []string{"Fix", "typo"}, Raw: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := mustParse(t, tc.args); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestParseAddOptionsErrors(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"--trivial", "--complexity", "complex", "Fix"}, "conflicting complexity flags"},
		{[]string{"--complexity"}, "--complexity needs a value"},
		{[]string{"--complexity", "maybe"}, "invalid complexity \"maybe\""},
		{[]string{"Fix", "--verify", "go", "test", "--trivial"}, "complexity flags must appear before --verify"},
	}
	for _, tc := range cases {
		if got := mustError(t, tc.args); !strings.Contains(got, tc.want) {
			t.Fatalf("got %q, want to contain %q", got, tc.want)
		}
	}
}
