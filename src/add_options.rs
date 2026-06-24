use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskComplexity {
    Trivial,
    Complex,
}

impl TaskComplexity {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "trivial" => Some(Self::Trivial),
            "complex" => Some(Self::Complex),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trivial => "trivial",
            Self::Complex => "complex",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAddOptions {
    pub args: Vec<String>,
    pub raw: bool,
    pub complexity: Option<TaskComplexity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseAddOptionsResult {
    Ok(ParsedAddOptions),
    Err(String),
}

const ADD_USAGE: &str =
    "usage: factory add [--raw] [--trivial | --complexity trivial|complex] [intent...] [--verify <cmd...>] [--edit]";

fn fail(message: impl AsRef<str>) -> ParseAddOptionsResult {
    ParseAddOptionsResult::Err(format!("{ADD_USAGE}\n{}", message.as_ref()))
}

fn set_complexity(
    current: Option<TaskComplexity>,
    next: TaskComplexity,
) -> Result<TaskComplexity, String> {
    if let Some(current) = current {
        if current != next {
            return Err(format!(
                "conflicting complexity flags: {} and {}",
                current.as_str(),
                next.as_str()
            ));
        }
    }
    Ok(next)
}

pub fn parse_add_options(args: &[String]) -> ParseAddOptionsResult {
    let verify_index = args.iter().position(|arg| arg == "--verify");
    let (head, tail): (&[String], &[String]) = match verify_index {
        Some(i) => (&args[..i], &args[i + 1..]),
        None => (args, &[]),
    };
    if tail
        .iter()
        .any(|arg| arg == "--trivial" || arg == "--complexity")
    {
        return fail("complexity flags must appear before --verify");
    }

    let mut cleaned = Vec::new();
    let mut raw = false;
    let mut complexity = None;
    let mut i = 0;
    while i < head.len() {
        let arg = &head[i];
        if arg == "--raw" {
            raw = true;
            i += 1;
            continue;
        }
        if arg == "--trivial" {
            match set_complexity(complexity, TaskComplexity::Trivial) {
                Ok(next) => complexity = Some(next),
                Err(message) => return fail(message),
            }
            i += 1;
            continue;
        }
        if arg == "--complexity" {
            let Some(value) = head.get(i + 1) else {
                return fail("--complexity needs a value: trivial or complex");
            };
            if value.starts_with("--") {
                return fail("--complexity needs a value: trivial or complex");
            }
            let Some(parsed) = TaskComplexity::parse(value) else {
                return fail(format!(
                    "invalid complexity \"{value}\" (expected trivial or complex)"
                ));
            };
            match set_complexity(complexity, parsed) {
                Ok(next) => complexity = Some(next),
                Err(message) => return fail(message),
            }
            i += 2;
            continue;
        }
        cleaned.push(arg.clone());
        i += 1;
    }

    let args = if verify_index.is_some() {
        let mut full = cleaned;
        full.push("--verify".to_string());
        full.extend(tail.iter().cloned());
        full
    } else {
        cleaned
    };

    ParseAddOptionsResult::Ok(ParsedAddOptions {
        args,
        raw,
        complexity,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

    fn expect_parsed(args: &[&str]) -> ParsedAddOptions {
        match parse_add_options(&strings(args)) {
            ParseAddOptionsResult::Ok(options) => options,
            ParseAddOptionsResult::Err(message) => panic!("{message}"),
        }
    }

    fn expect_error(args: &[&str]) -> String {
        match parse_add_options(&strings(args)) {
            ParseAddOptionsResult::Ok(_) => panic!("expected parse failure"),
            ParseAddOptionsResult::Err(message) => message,
        }
    }

    #[test]
    fn parses_trivial() {
        assert_eq!(
            expect_parsed(&["--trivial", "Fix", "typo"]),
            ParsedAddOptions {
                args: strings(&["Fix", "typo"]),
                raw: false,
                complexity: Some(TaskComplexity::Trivial),
            }
        );
    }

    #[test]
    fn parses_complexity_complex() {
        assert_eq!(
            expect_parsed(&["--complexity", "complex", "Refactor", "parser"]),
            ParsedAddOptions {
                args: strings(&["Refactor", "parser"]),
                raw: false,
                complexity: Some(TaskComplexity::Complex),
            }
        );
    }

    #[test]
    fn accepts_redundant_trivial_declarations() {
        assert_eq!(
            expect_parsed(&["--trivial", "--complexity", "trivial", "Fix", "typo"]).complexity,
            Some(TaskComplexity::Trivial)
        );
    }

    #[test]
    fn rejects_conflicting_complexity_declarations() {
        assert!(
            expect_error(&["--trivial", "--complexity", "complex", "Fix"])
                .contains("conflicting complexity flags")
        );
    }

    #[test]
    fn rejects_missing_complexity_value() {
        assert!(expect_error(&["--complexity"])
            .contains("--complexity needs a value: trivial or complex"));
    }

    #[test]
    fn rejects_invalid_complexity_value() {
        assert!(expect_error(&["--complexity", "maybe"])
            .contains("invalid complexity \"maybe\" (expected trivial or complex)"));
    }

    #[test]
    fn parses_complexity_before_verify() {
        assert_eq!(
            expect_parsed(&[
                "--complexity",
                "trivial",
                "Fix",
                "typo",
                "--verify",
                "bun",
                "test"
            ]),
            ParsedAddOptions {
                args: strings(&["Fix", "typo", "--verify", "bun", "test"]),
                raw: false,
                complexity: Some(TaskComplexity::Trivial),
            }
        );
    }

    #[test]
    fn rejects_complexity_flags_after_verify() {
        assert!(
            expect_error(&["Fix", "--verify", "bun", "test", "--trivial"])
                .contains("complexity flags must appear before --verify")
        );
        assert!(
            expect_error(&["Fix", "--verify", "bun", "test", "--complexity"])
                .contains("complexity flags must appear before --verify")
        );
    }

    #[test]
    fn preserves_normal_verify_tokens_after_verify() {
        assert_eq!(
            expect_parsed(&["Fix", "typo", "--verify", "bun", "test", "--raw"]),
            ParsedAddOptions {
                args: strings(&["Fix", "typo", "--verify", "bun", "test", "--raw"]),
                raw: false,
                complexity: None,
            }
        );
    }

    #[test]
    fn parses_raw_before_verify() {
        assert_eq!(
            expect_parsed(&["--raw", "Fix", "typo"]),
            ParsedAddOptions {
                args: strings(&["Fix", "typo"]),
                raw: true,
                complexity: None,
            }
        );
    }
}
