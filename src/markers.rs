#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriageResult {
    pub trivial: bool,
    pub user_facing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShipResult {
    Ok,
    Failed { reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileDecision {
    Proceed,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemedyVerdict {
    EnvFixed,
    EnvBlocked,
    Code,
    Flake,
}

fn nonempty_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn first_nonempty_line(text: &str) -> String {
    nonempty_lines(text).into_iter().next().unwrap_or_default()
}

fn final_nonempty_line(text: &str) -> String {
    nonempty_lines(text).into_iter().last().unwrap_or_default()
}

fn marker_value(
    line: &str,
    marker: &str,
    allowed: &'static [&'static str],
) -> Option<&'static str> {
    let (head, value) = line.split_once(':')?;
    if !head.eq_ignore_ascii_case(marker) {
        return None;
    }
    let value = value.trim();
    allowed
        .iter()
        .find(|candidate| value.eq_ignore_ascii_case(candidate))
        .copied()
}

pub fn parse_triage(text: &str) -> TriageResult {
    let lines = nonempty_lines(text);
    let complexity_line = lines
        .len()
        .checked_sub(2)
        .and_then(|idx| lines.get(idx))
        .map(String::as_str)
        .unwrap_or_default();
    let user_facing_line = lines.last().map(String::as_str).unwrap_or_default();

    TriageResult {
        trivial: marker_value(complexity_line, "COMPLEXITY", &["TRIVIAL", "COMPLEX"])
            == Some("TRIVIAL"),
        user_facing: marker_value(user_facing_line, "USER-FACING", &["YES", "NO"]) == Some("YES"),
    }
}

pub fn parse_review_verdict(text: &str) -> Option<&'static str> {
    match marker_value(&final_nonempty_line(text), "VERDICT", &["PASS", "FAIL"]) {
        Some("PASS") => Some("PASS"),
        Some("FAIL") => Some("FAIL"),
        _ => None,
    }
}

pub fn parse_convergence_verdict(text: &str) -> Option<&'static str> {
    match marker_value(
        &final_nonempty_line(text),
        "VERDICT",
        &["CONTINUE", "STUCK"],
    ) {
        Some("CONTINUE") => Some("CONTINUE"),
        Some("STUCK") => Some("STUCK"),
        _ => None,
    }
}

pub fn parse_remedy(text: &str) -> Option<RemedyVerdict> {
    match marker_value(
        &final_nonempty_line(text),
        "VERDICT",
        &["ENV-FIXED", "ENV-BLOCKED", "CODE", "FLAKE"],
    ) {
        Some("ENV-FIXED") => Some(RemedyVerdict::EnvFixed),
        Some("ENV-BLOCKED") => Some(RemedyVerdict::EnvBlocked),
        Some("CODE") => Some(RemedyVerdict::Code),
        Some("FLAKE") => Some(RemedyVerdict::Flake),
        _ => None,
    }
}

pub fn parse_ship(text: &str) -> ShipResult {
    let line = final_nonempty_line(text);
    if marker_value(&line, "SHIP", &["OK"]) == Some("OK") {
        return ShipResult::Ok;
    }
    let Some((head, value)) = line.split_once(':') else {
        return ShipResult::Failed {
            reason: "ship did not report success".to_string(),
        };
    };
    if !head.eq_ignore_ascii_case("SHIP") {
        return ShipResult::Failed {
            reason: "ship did not report success".to_string(),
        };
    }
    let value = value.trim();
    let upper = value.to_uppercase();
    if !upper.starts_with("FAILED") {
        return ShipResult::Failed {
            reason: "ship did not report success".to_string(),
        };
    }
    let reason = &value["FAILED".len()..];
    let reason = reason.trim();
    ShipResult::Failed {
        reason: if reason.is_empty() {
            "ship did not report success".to_string()
        } else {
            reason.to_string()
        },
    }
}

pub fn parse_reconcile_decision(text: &str) -> Option<ReconcileDecision> {
    match marker_value(&first_nonempty_line(text), "DECISION", &["PROCEED", "ASK"]) {
        Some("PROCEED") => Some(ReconcileDecision::Proceed),
        Some("ASK") => Some(ReconcileDecision::Ask),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_triage_from_final_two_marker_lines() {
        assert_eq!(
            parse_triage(
                "Reasoning is allowed before the markers.\nCOMPLEXITY: TRIVIAL\nUSER-FACING: YES"
            ),
            TriageResult {
                trivial: true,
                user_facing: true,
            }
        );
    }

    #[test]
    fn malformed_triage_defaults_to_complex_not_user_facing() {
        assert_eq!(
            parse_triage("COMPLEXITY: MAYBE\nUSER-FACING: MAYBE"),
            TriageResult {
                trivial: false,
                user_facing: false,
            }
        );
    }

    #[test]
    fn review_verdict_must_be_final() {
        assert_eq!(
            parse_review_verdict("VERDICT: PASS\n\n## Findings\nnone"),
            None
        );
        assert_eq!(
            parse_review_verdict("## Findings\nnone\n\nVERDICT: PASS"),
            Some("PASS")
        );
        assert_eq!(parse_review_verdict("> VERDICT: PASS"), None);
    }

    #[test]
    fn convergence_verdict_must_be_final() {
        assert_eq!(
            parse_convergence_verdict("VERDICT: CONTINUE\n\nsame root cause"),
            None
        );
        assert_eq!(
            parse_convergence_verdict("same root cause\n\nVERDICT: STUCK"),
            Some("STUCK")
        );
        assert_eq!(parse_convergence_verdict("`VERDICT: CONTINUE`"), None);
    }

    #[test]
    fn parses_ship_only_from_final_line() {
        assert_eq!(parse_ship("opened PR\nSHIP: OK"), ShipResult::Ok);
        assert_eq!(
            parse_ship("SHIP: OK\nfollow-up text"),
            ShipResult::Failed {
                reason: "ship did not report success".to_string()
            }
        );
        assert_eq!(
            parse_ship("could not push\nSHIP: FAILED remote rejected"),
            ShipResult::Failed {
                reason: "remote rejected".to_string()
            }
        );
    }

    #[test]
    fn parses_remedy_only_from_final_line() {
        assert_eq!(
            parse_remedy("ran bun install\nSUMMARY: deps were missing\nVERDICT: ENV-FIXED"),
            Some(RemedyVerdict::EnvFixed)
        );
        assert_eq!(
            parse_remedy("SUMMARY: assertion failed\nVERDICT: CODE"),
            Some(RemedyVerdict::Code)
        );
        assert_eq!(parse_remedy("VERDICT: ENV-FIXED\ntrailing note"), None);
        assert_eq!(parse_remedy("VERDICT: MAYBE"), None);
    }

    #[test]
    fn parses_reconcile_only_from_first_nonempty_line() {
        assert_eq!(
            parse_reconcile_decision("DECISION: ASK\n\nWhat should the label be?"),
            Some(ReconcileDecision::Ask)
        );
        assert_eq!(
            parse_reconcile_decision("\nDECISION: PROCEED\nAssuming the default."),
            Some(ReconcileDecision::Proceed)
        );
        assert_eq!(
            parse_reconcile_decision("I might ask.\nDECISION: ASK"),
            None
        );
        assert_eq!(parse_reconcile_decision("> DECISION: ASK"), None);
    }
}
