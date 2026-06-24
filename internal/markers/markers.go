package markers

import (
	"regexp"
	"strings"
)

type TriageResult struct {
	Trivial    bool
	UserFacing bool
}

type ShipResult struct {
	OK     bool
	Reason string
}

func ParseTriage(text string) TriageResult {
	lines := nonemptyLines(text)
	complexityLine := ""
	userFacingLine := ""
	if len(lines) >= 2 {
		complexityLine = lines[len(lines)-2]
	}
	if len(lines) >= 1 {
		userFacingLine = lines[len(lines)-1]
	}
	complexity := markerValue(complexityLine, `^COMPLEXITY:\s*(TRIVIAL|COMPLEX)\s*$`)
	userFacing := markerValue(userFacingLine, `^USER-FACING:\s*(YES|NO)\s*$`)
	return TriageResult{
		Trivial:    complexity == "TRIVIAL",
		UserFacing: userFacing == "YES",
	}
}

func ParseReviewVerdict(text string) string {
	value := markerValue(finalNonemptyLine(text), `^VERDICT:\s*(PASS|FAIL)\s*$`)
	if value == "PASS" || value == "FAIL" {
		return value
	}
	return ""
}

func ParseConvergenceVerdict(text string) string {
	value := markerValue(finalNonemptyLine(text), `^VERDICT:\s*(CONTINUE|STUCK)\s*$`)
	if value == "CONTINUE" || value == "STUCK" {
		return value
	}
	return ""
}

func ParseRemedy(text string) string {
	value := markerValue(finalNonemptyLine(text), `^VERDICT:\s*(ENV-FIXED|ENV-BLOCKED|CODE|FLAKE)\s*$`)
	switch value {
	case "ENV-FIXED", "ENV-BLOCKED", "CODE", "FLAKE":
		return value
	default:
		return ""
	}
}

func ParseShip(text string) ShipResult {
	line := finalNonemptyLine(text)
	if regexp.MustCompile(`(?i)^SHIP:\s*OK\s*$`).MatchString(line) {
		return ShipResult{OK: true}
	}
	re := regexp.MustCompile(`(?i)^SHIP:\s*FAILED\s*(.*)$`)
	match := re.FindStringSubmatch(line)
	reason := "ship did not report success"
	if len(match) > 1 && strings.TrimSpace(match[1]) != "" {
		reason = strings.TrimSpace(match[1])
	}
	return ShipResult{OK: false, Reason: reason}
}

func ParseReconcileDecision(text string) string {
	value := markerValue(firstNonemptyLine(text), `^DECISION:\s*(PROCEED|ASK)\s*$`)
	if value == "PROCEED" || value == "ASK" {
		return value
	}
	return ""
}

func markerValue(line, pattern string) string {
	re := regexp.MustCompile(`(?i)` + pattern)
	match := re.FindStringSubmatch(line)
	if len(match) < 2 {
		return ""
	}
	return strings.ToUpper(match[1])
}

func nonemptyLines(text string) []string {
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	return lines
}

func firstNonemptyLine(text string) string {
	lines := nonemptyLines(text)
	if len(lines) == 0 {
		return ""
	}
	return lines[0]
}

func finalNonemptyLine(text string) string {
	lines := nonemptyLines(text)
	if len(lines) == 0 {
		return ""
	}
	return lines[len(lines)-1]
}
