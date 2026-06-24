#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedInput {
    pub task_query: Option<String>,
    pub message: Option<String>,
    pub edit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseInputResult {
    Ok(ParsedInput),
    Err(String),
}

pub fn parse_input_args(args: &[String], usage: &str) -> ParseInputResult {
    let mut message = None;
    let mut edit = false;
    let mut positionals = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-m" || arg == "--message" {
            let Some(next) = args.get(i + 1) else {
                return ParseInputResult::Err(usage.to_string());
            };
            message = Some(next.clone());
            i += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--message=") {
            message = Some(value.to_string());
            i += 1;
            continue;
        }
        if arg == "--edit" {
            edit = true;
            i += 1;
            continue;
        }
        if arg.starts_with("--") || (arg.starts_with('-') && arg != "-") {
            return ParseInputResult::Err(format!("unknown option {arg}\n{usage}"));
        }
        positionals.push(arg.clone());
        i += 1;
    }

    if positionals.len() > 1 {
        return ParseInputResult::Err(format!(
            "{usage}\nthe message is set with -m/--message or composed in $EDITOR"
        ));
    }

    ParseInputResult::Ok(ParsedInput {
        task_query: positionals.into_iter().next(),
        message,
        edit,
    })
}

pub fn resolve_inline_message(parsed: &ParsedInput) -> Option<String> {
    parsed
        .message
        .as_ref()
        .map(|message| message.trim().to_string())
        .filter(|message| !message.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    const USAGE: &str = "usage";

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

    #[test]
    fn no_args_has_no_task_or_message() {
        assert_eq!(
            parse_input_args(&[], USAGE),
            ParseInputResult::Ok(ParsedInput {
                task_query: None,
                message: None,
                edit: false,
            })
        );
    }

    #[test]
    fn lone_positional_is_task_id_not_message() {
        assert_eq!(
            parse_input_args(&strings(&["task-1"]), USAGE),
            ParseInputResult::Ok(ParsedInput {
                task_query: Some("task-1".to_string()),
                message: None,
                edit: false,
            })
        );
    }

    #[test]
    fn message_flag_carries_message() {
        assert_eq!(
            parse_input_args(&strings(&["-m", "hello"]), USAGE),
            ParseInputResult::Ok(ParsedInput {
                task_query: None,
                message: Some("hello".to_string()),
                edit: false,
            })
        );
    }

    #[test]
    fn task_id_plus_message() {
        assert_eq!(
            parse_input_args(&strings(&["task-1", "-m", "hello"]), USAGE),
            ParseInputResult::Ok(ParsedInput {
                task_query: Some("task-1".to_string()),
                message: Some("hello".to_string()),
                edit: false,
            })
        );
    }

    #[test]
    fn message_equals_form_and_edit() {
        assert_eq!(
            parse_input_args(&strings(&["--message=hello", "--edit"]), USAGE),
            ParseInputResult::Ok(ParsedInput {
                task_query: None,
                message: Some("hello".to_string()),
                edit: true,
            })
        );
    }

    #[test]
    fn message_without_value_is_error() {
        assert_eq!(
            parse_input_args(&strings(&["-m"]), USAGE),
            ParseInputResult::Err(USAGE.to_string())
        );
    }

    #[test]
    fn multiple_bare_words_error() {
        assert_eq!(
            parse_input_args(&strings(&["task-1", "message"]), USAGE),
            ParseInputResult::Err(
                "usage\nthe message is set with -m/--message or composed in $EDITOR".to_string()
            )
        );
    }

    #[test]
    fn unknown_option_is_rejected() {
        assert_eq!(
            parse_input_args(&strings(&["--bad"]), USAGE),
            ParseInputResult::Err("unknown option --bad\nusage".to_string())
        );
    }
}
