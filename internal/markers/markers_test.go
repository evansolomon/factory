package markers

import "testing"

func TestParseTriage(t *testing.T) {
	got := ParseTriage("Reasoning is allowed before the markers.\nCOMPLEXITY: TRIVIAL\nUSER-FACING: YES")
	if !got.Trivial || !got.UserFacing {
		t.Fatalf("got %#v", got)
	}
	got = ParseTriage("COMPLEXITY: MAYBE\nUSER-FACING: MAYBE")
	if got.Trivial || got.UserFacing {
		t.Fatalf("got %#v", got)
	}
}

func TestReviewVerdictRequiresFinalLine(t *testing.T) {
	if got := ParseReviewVerdict("VERDICT: PASS\n\n## Findings\nnone"); got != "" {
		t.Fatalf("got %q", got)
	}
	if got := ParseReviewVerdict("## Findings\nnone\n\nVERDICT: PASS"); got != "PASS" {
		t.Fatalf("got %q", got)
	}
	if got := ParseReviewVerdict("> VERDICT: PASS"); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestConvergenceVerdictRequiresFinalLine(t *testing.T) {
	if got := ParseConvergenceVerdict("VERDICT: CONTINUE\n\nsame root cause"); got != "" {
		t.Fatalf("got %q", got)
	}
	if got := ParseConvergenceVerdict("same root cause\n\nVERDICT: STUCK"); got != "STUCK" {
		t.Fatalf("got %q", got)
	}
	if got := ParseConvergenceVerdict("`VERDICT: CONTINUE`"); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestParseShip(t *testing.T) {
	if got := ParseShip("opened PR\nSHIP: OK"); !got.OK {
		t.Fatalf("got %#v", got)
	}
	if got := ParseShip("SHIP: OK\nfollow-up text"); got.OK || got.Reason != "ship did not report success" {
		t.Fatalf("got %#v", got)
	}
	if got := ParseShip("could not push\nSHIP: FAILED remote rejected"); got.OK || got.Reason != "remote rejected" {
		t.Fatalf("got %#v", got)
	}
}

func TestParseRemedy(t *testing.T) {
	if got := ParseRemedy("ran bun install\nSUMMARY: deps were missing\nVERDICT: ENV-FIXED"); got != "ENV-FIXED" {
		t.Fatalf("got %q", got)
	}
	if got := ParseRemedy("SUMMARY: assertion failed\nVERDICT: CODE"); got != "CODE" {
		t.Fatalf("got %q", got)
	}
	if got := ParseRemedy("VERDICT: ENV-FIXED\ntrailing note"); got != "" {
		t.Fatalf("got %q", got)
	}
	if got := ParseRemedy("VERDICT: MAYBE"); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestParseReconcileDecision(t *testing.T) {
	if got := ParseReconcileDecision("DECISION: ASK\n\nWhat should the label be?"); got != "ASK" {
		t.Fatalf("got %q", got)
	}
	if got := ParseReconcileDecision("\nDECISION: PROCEED\nAssuming the default."); got != "PROCEED" {
		t.Fatalf("got %q", got)
	}
	if got := ParseReconcileDecision("I might ask.\nDECISION: ASK"); got != "" {
		t.Fatalf("got %q", got)
	}
	if got := ParseReconcileDecision("> DECISION: ASK"); got != "" {
		t.Fatalf("got %q", got)
	}
}
