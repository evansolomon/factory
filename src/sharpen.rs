use regex::Regex;

pub const DIM: &str = "\x1b[2m";
pub const BOLD: &str = "\x1b[1m";
pub const CYAN: &str = "\x1b[36m";
pub const GREEN: &str = "\x1b[32m";
pub const RESET: &str = "\x1b[0m";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharpenParsed {
    pub ready: bool,
    pub verify: Option<String>,
    pub spec: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub q: String,
    pub rec: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedQuestions {
    pub preamble: String,
    pub questions: Vec<Question>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Review {
    Pass,
    Revise {
        message: String,
    },
    Questions {
        preamble: String,
        questions: Vec<Question>,
    },
}

pub fn parse_sharpen(text: &str) -> SharpenParsed {
    let marker = Regex::new(r"(?m)^SPEC READY[ \t\r]*$").expect("valid regex");
    let Some(marker_match) = marker.find(text) else {
        return SharpenParsed {
            ready: false,
            verify: None,
            spec: String::new(),
            message: text.trim().to_string(),
        };
    };

    let message = text[..marker_match.start()].trim().to_string();
    let after = &text[marker_match.end()..];
    let verify_re = Regex::new(r"(?m)^VERIFY:[ \t\r]*(.*)$").expect("valid regex");
    let verify_match = verify_re.captures(after);
    let raw_verify = verify_match
        .as_ref()
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().trim())
        .unwrap_or_default();
    let verify = if raw_verify.is_empty() || raw_verify.eq_ignore_ascii_case("none") {
        None
    } else {
        Some(raw_verify.to_string())
    };
    let spec = verify_match
        .as_ref()
        .and_then(|captures| captures.get(0))
        .map(|matched| after[matched.end()..].trim().to_string())
        .unwrap_or_else(|| after.trim().to_string());

    SharpenParsed {
        ready: true,
        verify,
        spec,
        message,
    }
}

pub fn parse_questions(text: &str) -> ParsedQuestions {
    let marker = Regex::new(r"(?m)^QUESTIONS[ \t\r]*$").expect("valid regex");
    let Some(marker_match) = marker.find(text) else {
        return ParsedQuestions {
            preamble: String::new(),
            questions: Vec::new(),
        };
    };

    let preamble = text[..marker_match.start()].trim().to_string();
    let item = Regex::new(r"^\s*-\s+(.+)$").expect("valid regex");
    let mut questions = Vec::new();
    for line in text[marker_match.end()..].lines() {
        let Some(captures) = item.captures(line) else {
            continue;
        };
        let Some(raw) = captures.get(1).map(|value| value.as_str()) else {
            continue;
        };
        let mut parts = raw.split("|||");
        let q = parts.next().map(str::trim).unwrap_or_default();
        let rec = parts.next().map(str::trim).unwrap_or_default();
        if !q.is_empty() {
            questions.push(Question {
                q: q.to_string(),
                rec: rec.to_string(),
            });
        }
    }

    ParsedQuestions {
        preamble,
        questions,
    }
}

pub fn parse_review(text: &str) -> Review {
    let marker = first_line(text);
    if marker == "SHARPEN: PASS" {
        return Review::Pass;
    }
    if marker == "SHARPEN: REVISE" {
        let start = text
            .find(&marker)
            .map(|idx| idx + marker.len())
            .unwrap_or(marker.len());
        let message = text[start..].trim();
        return Review::Revise {
            message: fallback_review_message(message),
        };
    }

    let parsed = parse_questions(text);
    if !parsed.questions.is_empty() {
        return Review::Questions {
            preamble: parsed.preamble,
            questions: parsed.questions,
        };
    }

    Review::Revise {
        message: fallback_review_message(text.trim()),
    }
}

pub fn format_questions(preamble: &str, questions: &[Question]) -> String {
    let mut blocks = Vec::new();
    let preamble = preamble.trim();
    if !preamble.is_empty() {
        blocks.push(preamble.to_string());
    }
    blocks.extend(questions.iter().map(|question| {
        if question.rec.is_empty() {
            format!("- {}", question.q)
        } else {
            format!("- {}\n  Recommended: {}", question.q, question.rec)
        }
    }));
    blocks.join("\n\n")
}

pub fn parse_formatted_questions(text: &str) -> ParsedQuestions {
    let question_re = Regex::new(r"^\s*-\s+(.+?)\s*$").expect("valid regex");
    let recommendation_re = Regex::new(r"^\s+Recommended:\s*(.*)$").expect("valid regex");
    let mut preamble = Vec::new();
    let mut questions = Vec::new();

    for block in Regex::new(r"\n{2,}")
        .expect("valid regex")
        .split(text.trim())
    {
        let lines: Vec<&str> = block.split('\n').collect();
        let question = lines
            .first()
            .and_then(|line| question_re.captures(line))
            .and_then(|captures| captures.get(1))
            .map(|value| value.as_str().trim().to_string());
        let recommendation = lines
            .get(1)
            .and_then(|line| recommendation_re.captures(line))
            .and_then(|captures| captures.get(1))
            .map(|value| value.as_str());

        let Some(q) = question else {
            preamble.push(block.to_string());
            continue;
        };
        let Some(first_rec_line) = recommendation else {
            preamble.push(block.to_string());
            continue;
        };

        let mut rec_lines = vec![first_rec_line];
        rec_lines.extend(lines.iter().skip(2).copied());
        questions.push(Question {
            q,
            rec: rec_lines.join("\n").trim().to_string(),
        });
    }

    ParsedQuestions {
        preamble: preamble.join("\n\n").trim().to_string(),
        questions,
    }
}

pub fn style_sharpen_markdown_line(line: &str) -> String {
    let heading = Regex::new(r"^(\s{0,3})(#{2,3})\s+(.+?)\s*#*\s*$").expect("valid regex");
    if let Some(captures) = heading.captures(line) {
        let sp = captures
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let marks = captures
            .get(2)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let text = captures
            .get(3)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let color = if marks == "##" { GREEN } else { CYAN };
        let heading_style = format!("{color}{BOLD}");
        return format!(
            "{sp}{heading_style}{}{RESET}",
            style_inline_markdown(text, &heading_style)
        );
    }

    let bullet = Regex::new(r"^(\s*)([-*]|\d+[.)])(\s+)(.+)$").expect("valid regex");
    if let Some(captures) = bullet.captures(line) {
        let sp = captures
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let marker = captures
            .get(2)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let gap = captures
            .get(3)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let text = captures
            .get(4)
            .map(|value| value.as_str())
            .unwrap_or_default();
        return format!(
            "{sp}{DIM}{marker}{RESET}{gap}{}",
            style_inline_markdown(text, "")
        );
    }

    style_inline_markdown(line, "")
}

pub fn render_agent_markdown(text: &str) -> String {
    text.lines()
        .map(|line| format!("{DIM}|{RESET} {}", style_sharpen_markdown_line(line)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn fallback_review_message(message: &str) -> String {
    if message.is_empty() {
        "Tighten the spec before showing it to the human.".to_string()
    } else {
        message.to_string()
    }
}

fn style_inline_markdown(line: &str, restore: &str) -> String {
    let label = Regex::new(r"^(\s*)([A-Z][A-Za-z ]{1,38}):").expect("valid regex");
    let code = Regex::new(r"`([^`]+)`").expect("valid regex");
    let bold = Regex::new(r"\*\*([^*]+)\*\*").expect("valid regex");

    let styled = label
        .replace(line, |captures: &regex::Captures<'_>| {
            format!("{}{}{}:{RESET}{restore}", &captures[1], BOLD, &captures[2])
        })
        .to_string();
    let styled = code
        .replace_all(&styled, |captures: &regex::Captures<'_>| {
            format!("{CYAN}{}{RESET}{restore}", &captures[1])
        })
        .to_string();
    bold.replace_all(&styled, |captures: &regex::Captures<'_>| {
        format!("{BOLD}{}{RESET}{restore}", &captures[1])
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip_ansi(text: &str) -> String {
        Regex::new(&format!("{}\\[[0-9;]*m", char::from(27)))
            .expect("valid regex")
            .replace_all(text, "")
            .to_string()
    }

    #[test]
    fn parses_ready_sharpen_output() {
        assert_eq!(
            parse_sharpen("context\nSPEC READY\nVERIFY: bun test\n\n## Goal\nShip it."),
            SharpenParsed {
                ready: true,
                verify: Some("bun test".to_string()),
                spec: "## Goal\nShip it.".to_string(),
                message: "context".to_string(),
            }
        );
        assert_eq!(parse_sharpen("SPEC READY\nVERIFY: none\nBody").verify, None);
    }

    #[test]
    fn unready_sharpen_output_is_message() {
        assert_eq!(
            parse_sharpen("Still investigating."),
            SharpenParsed {
                ready: false,
                verify: None,
                spec: String::new(),
                message: "Still investigating.".to_string(),
            }
        );
    }

    #[test]
    fn parses_batched_questions() {
        assert_eq!(
            parse_questions(
                "Grounding.\nQUESTIONS\n- Which scope? ||| Keep it narrow.\n- Any deadline?"
            ),
            ParsedQuestions {
                preamble: "Grounding.".to_string(),
                questions: vec![
                    Question {
                        q: "Which scope?".to_string(),
                        rec: "Keep it narrow.".to_string(),
                    },
                    Question {
                        q: "Any deadline?".to_string(),
                        rec: String::new(),
                    },
                ],
            }
        );
    }

    #[test]
    fn parses_review_markers_and_fallbacks() {
        assert_eq!(parse_review("\nSHARPEN: PASS\n"), Review::Pass);
        assert_eq!(
            parse_review("SHARPEN: REVISE\nAdd acceptance criteria."),
            Review::Revise {
                message: "Add acceptance criteria.".to_string(),
            }
        );
        assert_eq!(
            parse_review("QUESTIONS\n- Choose behavior? ||| Preserve current."),
            Review::Questions {
                preamble: String::new(),
                questions: vec![Question {
                    q: "Choose behavior?".to_string(),
                    rec: "Preserve current.".to_string(),
                }],
            }
        );
        assert_eq!(
            parse_review(""),
            Review::Revise {
                message: "Tighten the spec before showing it to the human.".to_string(),
            }
        );
    }

    #[test]
    fn formatted_questions_round_trip_recommendations() {
        let text = format_questions(
            "Grounding context.",
            &[
                Question {
                    q: "Should auto-upgrade skip source runs?".to_string(),
                    rec: "Yes, only installed binaries.".to_string(),
                },
                Question {
                    q: "Which commands are eligible?".to_string(),
                    rec: "Interactive normal commands only.".to_string(),
                },
            ],
        );

        assert_eq!(
            parse_formatted_questions(&text),
            ParsedQuestions {
                preamble: "Grounding context.".to_string(),
                questions: vec![
                    Question {
                        q: "Should auto-upgrade skip source runs?".to_string(),
                        rec: "Yes, only installed binaries.".to_string(),
                    },
                    Question {
                        q: "Which commands are eligible?".to_string(),
                        rec: "Interactive normal commands only.".to_string(),
                    },
                ],
            }
        );
    }

    #[test]
    fn formatted_question_parser_ignores_unrecommended_preamble_bullets() {
        let text = [
            "- Existing fact without a recommendation.",
            "",
            "- Which scope should apply?",
            "  Recommended: Keep it narrow.",
        ]
        .join("\n");

        assert_eq!(
            parse_formatted_questions(&text),
            ParsedQuestions {
                preamble: "- Existing fact without a recommendation.".to_string(),
                questions: vec![Question {
                    q: "Which scope should apply?".to_string(),
                    rec: "Keep it narrow.".to_string(),
                }],
            }
        );
    }

    #[test]
    fn renders_spec_headings_without_visible_markers() {
        let heading = style_sharpen_markdown_line("## Problem");

        assert!(heading.contains("\x1b[32m\x1b[1m"));
        assert_eq!(strip_ansi(&heading), "Problem");
        assert_eq!(
            strip_ansi(&style_sharpen_markdown_line("### Rejected Alternatives")),
            "Rejected Alternatives"
        );
    }

    #[test]
    fn renders_inline_emphasis_and_code_as_display_text() {
        let line = style_sharpen_markdown_line("Use **small** `terminal` markdown.");

        assert!(line.contains("\x1b[1msmall\x1b[0m"));
        assert!(line.contains("\x1b[36mterminal\x1b[0m"));
        assert_eq!(strip_ansi(&line), "Use small terminal markdown.");
    }

    #[test]
    fn keeps_list_structure_and_unsupported_markdown_readable() {
        let bullet = style_sharpen_markdown_line("- Use `bun test`");

        assert!(bullet.contains("\x1b[2m-\x1b[0m"));
        assert_eq!(strip_ansi(&bullet), "- Use bun test");
        assert_eq!(
            strip_ansi(&style_sharpen_markdown_line(
                "1. Read [README](./README.md)"
            )),
            "1. Read [README](./README.md)"
        );
    }
}
