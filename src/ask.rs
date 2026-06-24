use std::fs;
use std::io;
use std::path::Path;

use crate::config::{OnComplete, WorkContext};
use crate::task::{load_tasks, Status, Task};

const ARTIFACT_LIMIT: usize = 8000;
const LOG_TAIL_LIMIT: usize = 8000;
const FAILURE_TAIL_LINES: usize = 8;
const DETAILED_TASK_LIMIT: usize = 4;

pub const NON_TTY_ASK_MESSAGE: &str = "factory ask is interactive and needs a terminal. For a scriptable one-shot answer use: factory ask --print [task-id] <question...>";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskMode {
    Session,
    Print,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskRequest {
    pub mode: AskMode,
    pub task_id: Option<String>,
    pub question: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskTranscriptTurn {
    pub question: String,
    pub answer: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskAnswer {
    pub answer: String,
    pub selected_task_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskTurnOutcome {
    Answer {
        answer: String,
        selected_task_ids: Vec<String>,
    },
    Fatal {
        message: String,
    },
}

pub fn sort_for_ask(tasks: &[Task]) -> Vec<Task> {
    let mut tasks = tasks.to_vec();
    tasks.sort_by(|a, b| {
        let ranked = rank(a).cmp(&rank(b));
        if ranked.is_eq() {
            stamp(b).cmp(stamp(a))
        } else {
            ranked
        }
    });
    tasks
}

pub fn parse_ask_request(args: &[String], tasks: &[Task]) -> AskRequest {
    let mode = if args.first().map(String::as_str) == Some("--print") {
        AskMode::Print
    } else {
        AskMode::Session
    };
    let rest_args = if mode == AskMode::Print {
        &args[1..]
    } else {
        args
    };
    let Some(first) = rest_args.first() else {
        return AskRequest {
            mode,
            task_id: None,
            question: String::new(),
        };
    };
    if let Some(task) = tasks
        .iter()
        .find(|candidate| candidate.id == *first || candidate.id.contains(first))
    {
        return AskRequest {
            mode,
            task_id: Some(task.id.clone()),
            question: rest_args[1..].join(" ").trim().to_string(),
        };
    }
    AskRequest {
        mode,
        task_id: None,
        question: rest_args.join(" ").trim().to_string(),
    }
}

pub fn build_ask_prompt(
    question: &str,
    ctx: &WorkContext,
    tasks: &[Task],
    detailed: &[String],
    transcript: &[AskTranscriptTurn],
) -> String {
    let task_index = if tasks.is_empty() {
        "(no tasks)".to_string()
    } else {
        tasks.iter().map(task_line).collect::<Vec<_>>().join("\n")
    };
    let artifacts = if detailed.is_empty() {
        "(no artifacts selected)".to_string()
    } else {
        detailed.join("\n\n")
    };
    let conversation = if transcript.is_empty() {
        String::new()
    } else {
        format!(
            "\nConversation history (live session memory, not saved evidence):\n{}\n",
            format_transcript(transcript)
        )
    };
    let transcript_rules = if transcript.is_empty() {
        String::new()
    } else {
        "\n- Use the conversation history only to resolve references like \"why?\", \"that one\", or \"the second issue\".\n- Answer factual questions only from the current task index and selected artifact excerpts.\n- If the conversation history conflicts with current saved state, current saved state wins.".to_string()
    };

    format!(
        r#"You are answering a question about factory's saved task state.
{conversation}
User question:
{question}

Rules:
- Answer only from the provided context.
- Do not run commands, inspect extra files, edit files, use git, run tests, or access the network.
- If the context does not prove the answer, say what is missing.{transcript_rules}
- Prefer direct facts over speculation.
- Include task ids and artifact names when relevant.
- Keep the answer concise.
- End with the next useful factory command if one exists.

Factory context:
- worktree: {root}
- stateDir: {state_dir}
- tasksDir: {tasks_dir}
- onComplete: {on_complete}

Task index, ordered by likely relevance:
{task_index}

Selected artifact excerpts:
{artifacts}
"#,
        root = ctx.root,
        state_dir = ctx.state_dir,
        tasks_dir = ctx.tasks_dir,
        on_complete = on_complete_label(ctx),
    )
}

pub fn task_artifacts(task: &Task) -> io::Result<Vec<String>> {
    let names = [
        "task.md",
        "questions.md",
        "answers.md",
        "feedback.md",
        "agent-session.summary.md",
        "human-feedback.md",
        "human-feedback.analysis.md",
        "plan.final.md",
        "consolidated.md",
        "postmortem.md",
        "proof.md",
        "ship.md",
        "verify.log",
    ];
    let mut out = vec![format!(
        "### {}/meta.json\n{}",
        task.id,
        serde_json::to_string_pretty(&task.meta).map_err(io::Error::other)?
    )];
    for name in names {
        if let Some(text) = artifact(task, name)? {
            out.push(text);
        }
    }
    if let Some(text) = failures(task)? {
        out.push(text);
    }
    Ok(out)
}

pub fn select_detailed_tasks(
    question: &str,
    tasks: &[Task],
    explicit: Option<&Task>,
    carried_task_ids: &[String],
) -> Vec<Task> {
    if let Some(explicit) = explicit {
        return vec![explicit.clone()];
    }

    let mut selected = Vec::new();
    for id in carried_task_ids {
        if let Some(task) = tasks.iter().find(|candidate| &candidate.id == id) {
            add_task_once(&mut selected, task);
        }
    }
    for task in tasks.iter().take(DETAILED_TASK_LIMIT) {
        add_task_once(&mut selected, task);
    }

    if is_delivery_question(question) {
        for task in tasks {
            if task.meta.status == Status::Shipping
                || task.meta.status == Status::Retrying
                || task.meta.status == Status::Done
                || has_artifact(task, "ship.md")
                || has_artifact(task, "proof.md")
            {
                add_task_once(&mut selected, task);
            }
            if selected.len() >= DETAILED_TASK_LIMIT {
                break;
            }
        }
    }

    selected.truncate(DETAILED_TASK_LIMIT);
    selected
}

pub fn ask_session_tty_error(input_is_tty: bool, output_is_tty: bool) -> Option<&'static str> {
    if input_is_tty && output_is_tty {
        None
    } else {
        Some(NON_TTY_ASK_MESSAGE)
    }
}

pub fn answer_ask_question_with_runner<E>(
    ctx: &WorkContext,
    question: &str,
    task_id: Option<&str>,
    transcript: &[AskTranscriptTurn],
    carried_task_ids: &[String],
    mut runner: impl FnMut(String, Vec<String>) -> Result<String, E>,
) -> Result<AskAnswer, Box<dyn std::error::Error>>
where
    E: std::error::Error + 'static,
{
    let tasks = sort_for_ask(&load_tasks(ctx)?);
    if tasks.is_empty() {
        return Err("no tasks in this worktree".into());
    }
    let scoped_task = match task_id {
        Some(id) => Some(
            tasks
                .iter()
                .find(|candidate| candidate.id == id)
                .ok_or_else(|| format!("task {id} is no longer in this worktree"))?,
        ),
        None => None,
    };
    let selection_question = [question, &prior_questions(transcript)]
        .into_iter()
        .filter(|piece| !piece.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let selected =
        select_detailed_tasks(&selection_question, &tasks, scoped_task, carried_task_ids);
    let mut detailed = Vec::new();
    for task in &selected {
        detailed.extend(task_artifacts(task)?);
    }
    let prompt = build_ask_prompt(question, ctx, &tasks, &detailed, transcript);
    let selected_task_ids: Vec<String> = selected.iter().map(|task| task.id.clone()).collect();
    let answer = runner(prompt, selected_task_ids.clone())?;
    let answer = answer.trim();

    Ok(AskAnswer {
        answer: if answer.is_empty() {
            "(no answer)".to_string()
        } else {
            answer.to_string()
        },
        selected_task_ids,
    })
}

pub struct AskSessionIo<R, W, E, T, G>
where
    R: FnMut() -> String,
    W: FnMut(String),
    E: FnMut(String),
    T: FnMut(&str, &[AskTranscriptTurn], &[String]) -> Result<AskTurnOutcome, String>,
    G: FnMut() -> String,
{
    pub agent: String,
    pub task_id: Option<String>,
    pub initial_question: String,
    pub read_line: R,
    pub write: W,
    pub write_error: E,
    pub turn: T,
    pub edit: Option<G>,
    pub render_answer: fn(&str) -> String,
}

pub fn run_ask_session<R, W, E, T, G>(mut opts: AskSessionIo<R, W, E, T, G>) -> i32
where
    R: FnMut() -> String,
    W: FnMut(String),
    E: FnMut(String),
    T: FnMut(&str, &[AskTranscriptTurn], &[String]) -> Result<AskTurnOutcome, String>,
    G: FnMut() -> String,
{
    let mut transcript = Vec::new();
    let mut carried_task_ids = Vec::new();

    (opts.write)(format!(
        "ask - {}{}",
        opts.agent,
        opts.task_id
            .as_ref()
            .map(|id| format!(" - task {id}"))
            .unwrap_or_default()
    ));
    (opts.write)(
        "ask a question - Enter or /done to exit - /edit long reply - /cancel abort".to_string(),
    );

    let initial = opts.initial_question.trim().to_string();
    if !initial.is_empty() {
        if let Some(code) = submit(
            &initial,
            &mut transcript,
            &mut carried_task_ids,
            &mut opts.write,
            &mut opts.write_error,
            &mut opts.turn,
            opts.render_answer,
        ) {
            return code;
        }
    }

    loop {
        let input = (opts.read_line)().trim().to_string();
        if input.is_empty() || input == "/done" {
            return 0;
        }
        if input == "/cancel" {
            return 1;
        }
        if input == "/edit" {
            let edited = opts.edit.as_mut().map(|edit| edit()).unwrap_or_default();
            if edited.is_empty() {
                (opts.write)("  (nothing entered)".to_string());
                continue;
            }
            if let Some(code) = submit(
                &edited,
                &mut transcript,
                &mut carried_task_ids,
                &mut opts.write,
                &mut opts.write_error,
                &mut opts.turn,
                opts.render_answer,
            ) {
                return code;
            }
            continue;
        }
        if let Some(code) = submit(
            &input,
            &mut transcript,
            &mut carried_task_ids,
            &mut opts.write,
            &mut opts.write_error,
            &mut opts.turn,
            opts.render_answer,
        ) {
            return code;
        }
    }
}

fn submit<W, E, T>(
    question: &str,
    transcript: &mut Vec<AskTranscriptTurn>,
    carried_task_ids: &mut Vec<String>,
    write: &mut W,
    write_error: &mut E,
    turn: &mut T,
    render_answer: fn(&str) -> String,
) -> Option<i32>
where
    W: FnMut(String),
    E: FnMut(String),
    T: FnMut(&str, &[AskTranscriptTurn], &[String]) -> Result<AskTurnOutcome, String>,
{
    write("  ...thinking".to_string());
    match turn(question, transcript, carried_task_ids) {
        Ok(AskTurnOutcome::Fatal { message }) => {
            write_error(message);
            Some(1)
        }
        Ok(AskTurnOutcome::Answer {
            answer,
            selected_task_ids,
        }) => {
            write(render_answer(&answer));
            transcript.push(AskTranscriptTurn {
                question: question.to_string(),
                answer,
            });
            merge_ids(carried_task_ids, &selected_task_ids);
            None
        }
        Err(err) => {
            write_error(format!("ask failed: {err}"));
            None
        }
    }
}

fn rank(task: &Task) -> u8 {
    match task.meta.status {
        Status::Blocked => 0,
        Status::NeedsInput => 1,
        Status::Planning
        | Status::Implementing
        | Status::Reviewing
        | Status::Verifying
        | Status::Shipping => 2,
        Status::Retrying => 3,
        Status::Ready => 4,
        Status::Done => 5,
        Status::Sharpening | Status::Grilling => 6,
    }
}

fn stamp(task: &Task) -> &str {
    task.meta
        .updated_at
        .as_deref()
        .unwrap_or(&task.meta.created_at)
}

fn file_text(task: &Task, name: &str) -> io::Result<Option<String>> {
    let path = Path::new(&task.dir).join(name);
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(fs::read_to_string(path)?.trim().to_string()))
}

fn has_artifact(task: &Task, name: &str) -> bool {
    Path::new(&task.dir).join(name).exists()
}

fn head(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        text.to_string()
    } else {
        format!("{}\n[truncated after {limit} chars]", &text[..limit])
    }
}

fn tail(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        text.to_string()
    } else {
        format!(
            "[truncated to last {limit} chars]\n{}",
            &text[text.len() - limit..]
        )
    }
}

fn artifact(task: &Task, name: &str) -> io::Result<Option<String>> {
    let Some(text) = file_text(task, name)? else {
        return Ok(None);
    };
    if text.is_empty() {
        return Ok(None);
    }
    let clipped = if name.ends_with(".log") || name.ends_with(".jsonl") {
        tail(&text, LOG_TAIL_LIMIT)
    } else {
        head(&text, ARTIFACT_LIMIT)
    };
    Ok(Some(format!("### {}/{name}\n{clipped}", task.id)))
}

fn failures(task: &Task) -> io::Result<Option<String>> {
    let Some(text) = file_text(task, "failures.jsonl")? else {
        return Ok(None);
    };
    let lines: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    if lines.is_empty() {
        return Ok(None);
    }
    let start = lines.len().saturating_sub(FAILURE_TAIL_LINES);
    let lines = &lines[start..];
    Ok(Some(format!(
        "### {}/failures.jsonl (last {})\n{}",
        task.id,
        lines.len(),
        lines.join("\n")
    )))
}

fn on_complete_label(ctx: &WorkContext) -> String {
    match &ctx.config.on_complete {
        Some(OnComplete::Skill { skill }) => format!("skill:{skill}"),
        Some(OnComplete::Policy { policy }) => format!("policy:{policy}"),
        None => "disabled".to_string(),
    }
}

fn task_line(task: &Task) -> String {
    let meta = &task.meta;
    let mut parts = vec![
        format!("id={}", meta.id),
        format!("status={}", meta.status.as_str()),
        format!(
            "updatedAt={}",
            meta.updated_at.as_deref().unwrap_or("(unset)")
        ),
        format!("verify={}", meta.verify.as_deref().unwrap_or("(none)")),
    ];
    if let Some(note) = &meta.note {
        parts.push(format!("note={note}"));
    }
    if let Some(commit) = &meta.commit {
        parts.push(format!("commit={commit}"));
    }
    if let Some(retry_at) = &meta.retry_at {
        parts.push(format!("retryAt={retry_at}"));
    }
    if meta.auto_retries > 0 {
        parts.push(format!("autoRetries={}", meta.auto_retries));
    }
    format!("- {}", parts.join(" - "))
}

fn format_transcript(transcript: &[AskTranscriptTurn]) -> String {
    transcript
        .iter()
        .map(|turn| format!("Human: {}\nAssistant: {}", turn.question, turn.answer))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn add_task_once(tasks: &mut Vec<Task>, task: &Task) {
    if !tasks.iter().any(|existing| existing.id == task.id) {
        tasks.push(task.clone());
    }
}

fn is_delivery_question(question: &str) -> bool {
    let lower = question.to_ascii_lowercase();
    [
        "ship",
        "shipped",
        "shipping",
        "deliver",
        "delivered",
        "push",
        "pushed",
        "pr",
        "mr",
    ]
    .iter()
    .any(|word| {
        lower
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .any(|part| part == *word)
    })
}

fn prior_questions(transcript: &[AskTranscriptTurn]) -> String {
    transcript
        .iter()
        .map(|turn| turn.question.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn merge_ids(existing: &mut Vec<String>, incoming: &[String]) {
    for id in incoming {
        if !existing.contains(id) {
            existing.push(id.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use tempfile::TempDir;

    use crate::config::{Agent, AgentCli, AgentsConfig, AskConfig, Config, RoleAgents};
    use crate::task::{add_task, AddTaskOptions};

    use super::*;

    fn ctx(dir: &TempDir) -> WorkContext {
        let root = dir.path().to_string_lossy().to_string();
        WorkContext {
            root: root.clone(),
            config: Config {
                plans_dir: None,
                capture_evals: false,
                postmortem: false,
                agents: AgentsConfig::default(),
                ask: AskConfig::default(),
                ..Config::default()
            },
            state_dir: format!("{root}/state"),
            tasks_dir: format!("{root}/state/tasks"),
            plans_dir: None,
            agents: RoleAgents {
                planners: vec![
                    Agent {
                        cli: AgentCli::Codex,
                        model: None,
                        provider: None,
                    },
                    Agent {
                        cli: AgentCli::Claude,
                        model: None,
                        provider: None,
                    },
                ],
                implementer: Agent {
                    cli: AgentCli::Codex,
                    model: None,
                    provider: None,
                },
                reviewer: Agent {
                    cli: AgentCli::Claude,
                    model: None,
                    provider: None,
                },
                delivery: Agent {
                    cli: AgentCli::Claude,
                    model: None,
                    provider: None,
                },
            },
            ask_agent: Agent {
                cli: AgentCli::Claude,
                model: None,
                provider: None,
            },
            repo_state_dir: format!("{root}/state"),
            metrics_path: format!("{root}/state/metrics.db"),
        }
    }

    fn read_lines(lines: &[&str]) -> impl FnMut() -> String {
        let mut index = 0;
        let lines = lines
            .iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>();
        move || {
            let line = lines.get(index).cloned().unwrap_or_default();
            index += 1;
            line
        }
    }

    fn identity(text: &str) -> String {
        text.to_string()
    }

    #[test]
    fn parse_request_leading_print_resolves_task_substrings() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        let task = add_task(&ctx, "Ship the thing", None, AddTaskOptions::default()).unwrap();

        assert_eq!(
            parse_ask_request(
                &[
                    "--print".to_string(),
                    "ship".to_string(),
                    "has ship ran?".to_string()
                ],
                &[task.clone()]
            ),
            AskRequest {
                mode: AskMode::Print,
                task_id: Some(task.id),
                question: "has ship ran?".to_string(),
            }
        );
    }

    #[test]
    fn parse_request_non_leading_print_remains_question() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        let task = add_task(&ctx, "Existing task", None, AddTaskOptions::default()).unwrap();

        assert_eq!(
            parse_ask_request(
                &[
                    "what".to_string(),
                    "--print".to_string(),
                    "means".to_string()
                ],
                &[task]
            ),
            AskRequest {
                mode: AskMode::Session,
                task_id: None,
                question: "what --print means".to_string(),
            }
        );
    }

    #[test]
    fn parse_request_task_id_with_no_question_scopes_session() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        let task = add_task(&ctx, "Scoped task", None, AddTaskOptions::default()).unwrap();

        assert_eq!(
            parse_ask_request(std::slice::from_ref(&task.id), &[task.clone()]),
            AskRequest {
                mode: AskMode::Session,
                task_id: Some(task.id),
                question: String::new(),
            }
        );
    }

    #[test]
    fn build_prompt_empty_transcript_omits_conversation_rules() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        let task = add_task(&ctx, "Explain status", None, AddTaskOptions::default()).unwrap();
        let prompt = build_ask_prompt("what happened?", &ctx, &[task], &[], &[]);

        assert!(prompt.contains("You are answering a question about factory's saved task state."));
        assert!(prompt.contains("User question:\nwhat happened?"));
        assert!(!prompt.contains("Conversation history"));
        assert!(!prompt.contains("Use the conversation history only"));
    }

    #[test]
    fn build_prompt_non_empty_transcript_adds_continuity_rules() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        let task = add_task(&ctx, "Explain status", None, AddTaskOptions::default()).unwrap();
        let prompt = build_ask_prompt(
            "why?",
            &ctx,
            &[task],
            &[],
            &[AskTranscriptTurn {
                question: "what failed?".to_string(),
                answer: "verify failed".to_string(),
            }],
        );

        assert!(prompt.contains("Conversation history (live session memory, not saved evidence):"));
        assert!(prompt.contains("Human: what failed?"));
        assert!(prompt.contains("Assistant: verify failed"));
        assert!(prompt.contains("Use the conversation history only to resolve references"));
        assert!(prompt.contains("current saved state wins"));
    }

    #[test]
    fn answer_question_builds_prompt_and_trims_answer() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        let task = add_task(&ctx, "Check ship", None, AddTaskOptions::default()).unwrap();
        let prompts = Rc::new(RefCell::new(Vec::new()));
        let prompt_sink = Rc::clone(&prompts);

        let result = answer_ask_question_with_runner(
            &ctx,
            "has ship ran?",
            None,
            &[],
            &[],
            move |prompt, _selected| {
                prompt_sink.borrow_mut().push(prompt);
                Ok::<_, io::Error>("  no ship artifact  ".to_string())
            },
        )
        .unwrap();

        assert_eq!(
            result,
            AskAnswer {
                answer: "no ship artifact".to_string(),
                selected_task_ids: vec![task.id],
            }
        );
        assert!(prompts.borrow()[0].contains("User question:\nhas ship ran?"));
    }

    #[test]
    fn follow_up_selection_includes_carried_task_from_fresh_state() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        add_task(&ctx, "Alpha", None, AddTaskOptions::default()).unwrap();
        add_task(&ctx, "Beta", None, AddTaskOptions::default()).unwrap();
        add_task(&ctx, "Gamma", None, AddTaskOptions::default()).unwrap();
        add_task(&ctx, "Delta", None, AddTaskOptions::default()).unwrap();
        let carried = add_task(
            &ctx,
            "Epsilon carried task",
            None,
            AddTaskOptions::default(),
        )
        .unwrap();
        let prompts = Rc::new(RefCell::new(Vec::new()));
        let prompt_sink = Rc::clone(&prompts);

        answer_ask_question_with_runner(
            &ctx,
            "why?",
            None,
            &[AskTranscriptTurn {
                question: "what about epsilon?".to_string(),
                answer: "epsilon was selected".to_string(),
            }],
            std::slice::from_ref(&carried.id),
            move |prompt, _selected| {
                prompt_sink.borrow_mut().push(prompt);
                Ok::<_, io::Error>("answer".to_string())
            },
        )
        .unwrap();

        assert!(prompts.borrow()[0].contains("Human: what about epsilon?"));
        assert!(prompts.borrow()[0].contains(&format!("### {}/meta.json", carried.id)));
    }

    #[test]
    fn scoped_task_disappearance_fails_instead_of_widening() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        let scoped = add_task(&ctx, "Scoped task", None, AddTaskOptions::default()).unwrap();
        add_task(&ctx, "Other task", None, AddTaskOptions::default()).unwrap();
        fs::remove_dir_all(&scoped.dir).unwrap();

        let err = answer_ask_question_with_runner(
            &ctx,
            "what happened?",
            Some(&scoped.id),
            &[],
            &[],
            |_prompt, _selected| Ok::<_, io::Error>("should not run".to_string()),
        )
        .unwrap_err();

        assert_eq!(
            err.to_string(),
            format!("task {} is no longer in this worktree", scoped.id)
        );
    }

    #[test]
    fn session_seeded_question_is_sent_before_reading_follow_up() {
        let questions = Rc::new(RefCell::new(Vec::new()));
        let questions_sink = Rc::clone(&questions);
        let reads = Rc::new(RefCell::new(0));
        let reads_sink = Rc::clone(&reads);

        let code = run_ask_session(AskSessionIo {
            agent: "claude".to_string(),
            task_id: None,
            initial_question: "first question".to_string(),
            read_line: move || {
                *reads_sink.borrow_mut() += 1;
                "/done".to_string()
            },
            write: |_| {},
            write_error: |_| {},
            turn: move |question, _transcript, _carried| {
                questions_sink.borrow_mut().push(question.to_string());
                Ok(AskTurnOutcome::Answer {
                    answer: "answer".to_string(),
                    selected_task_ids: Vec::new(),
                })
            },
            edit: None::<fn() -> String>,
            render_answer: identity,
        });

        assert_eq!(code, 0);
        assert_eq!(questions.borrow().as_slice(), ["first question"]);
        assert_eq!(*reads.borrow(), 1);
    }

    #[test]
    fn session_follow_up_receives_transcript_and_carried_ids() {
        let seen = Rc::new(RefCell::new(Vec::new()));
        let seen_sink = Rc::clone(&seen);

        let code = run_ask_session(AskSessionIo {
            agent: "claude".to_string(),
            task_id: None,
            initial_question: "what failed?".to_string(),
            read_line: read_lines(&["why?", "/done"]),
            write: |_| {},
            write_error: |_| {},
            turn: move |question, transcript, carried| {
                seen_sink.borrow_mut().push((
                    question.to_string(),
                    transcript.len(),
                    carried.to_vec(),
                ));
                Ok(AskTurnOutcome::Answer {
                    answer: format!("{question} answer"),
                    selected_task_ids: if question == "what failed?" {
                        vec!["task-a".to_string()]
                    } else {
                        Vec::new()
                    },
                })
            },
            edit: None::<fn() -> String>,
            render_answer: identity,
        });

        assert_eq!(code, 0);
        assert_eq!(
            seen.borrow().as_slice(),
            [
                ("what failed?".to_string(), 0, Vec::new()),
                ("why?".to_string(), 1, vec!["task-a".to_string()]),
            ]
        );
    }

    #[test]
    fn session_empty_done_and_cancel_exit_codes() {
        assert_eq!(
            run_ask_session(AskSessionIo {
                agent: "claude".to_string(),
                task_id: None,
                initial_question: String::new(),
                read_line: read_lines(&[""]),
                write: |_| {},
                write_error: |_| {},
                turn: |_question, _transcript, _carried| Ok(AskTurnOutcome::Answer {
                    answer: "unused".to_string(),
                    selected_task_ids: Vec::new(),
                }),
                edit: None::<fn() -> String>,
                render_answer: identity,
            }),
            0
        );
        assert_eq!(
            run_ask_session(AskSessionIo {
                agent: "claude".to_string(),
                task_id: None,
                initial_question: String::new(),
                read_line: read_lines(&["/done"]),
                write: |_| {},
                write_error: |_| {},
                turn: |_question, _transcript, _carried| Ok(AskTurnOutcome::Answer {
                    answer: "unused".to_string(),
                    selected_task_ids: Vec::new(),
                }),
                edit: None::<fn() -> String>,
                render_answer: identity,
            }),
            0
        );
        assert_eq!(
            run_ask_session(AskSessionIo {
                agent: "claude".to_string(),
                task_id: None,
                initial_question: String::new(),
                read_line: read_lines(&["/cancel"]),
                write: |_| {},
                write_error: |_| {},
                turn: |_question, _transcript, _carried| Ok(AskTurnOutcome::Answer {
                    answer: "unused".to_string(),
                    selected_task_ids: Vec::new(),
                }),
                edit: None::<fn() -> String>,
                render_answer: identity,
            }),
            1
        );
    }

    #[test]
    fn session_turn_failure_reports_and_reprompts_without_transcript_append() {
        let errors = Rc::new(RefCell::new(Vec::new()));
        let errors_sink = Rc::clone(&errors);
        let transcript_lengths = Rc::new(RefCell::new(Vec::new()));
        let lengths_sink = Rc::clone(&transcript_lengths);

        let code = run_ask_session(AskSessionIo {
            agent: "claude".to_string(),
            task_id: None,
            initial_question: String::new(),
            read_line: read_lines(&["bad", "retry", "/done"]),
            write: |_| {},
            write_error: move |text| errors_sink.borrow_mut().push(text),
            turn: move |question, transcript, _carried| {
                lengths_sink.borrow_mut().push(transcript.len());
                if question == "bad" {
                    Err("agent exploded".to_string())
                } else {
                    Ok(AskTurnOutcome::Answer {
                        answer: "ok".to_string(),
                        selected_task_ids: Vec::new(),
                    })
                }
            },
            edit: None::<fn() -> String>,
            render_answer: identity,
        });

        assert_eq!(code, 0);
        assert_eq!(errors.borrow().as_slice(), ["ask failed: agent exploded"]);
        assert_eq!(transcript_lengths.borrow().as_slice(), [0, 0]);
    }

    #[test]
    fn session_fatal_turn_ends_nonzero() {
        let errors = Rc::new(RefCell::new(Vec::new()));
        let errors_sink = Rc::clone(&errors);

        let code = run_ask_session(AskSessionIo {
            agent: "claude".to_string(),
            task_id: Some("missing".to_string()),
            initial_question: "what happened?".to_string(),
            read_line: read_lines(&["/done"]),
            write: |_| {},
            write_error: move |text| errors_sink.borrow_mut().push(text),
            turn: |_question, _transcript, _carried| {
                Ok(AskTurnOutcome::Fatal {
                    message: "task missing is no longer in this worktree".to_string(),
                })
            },
            edit: None::<fn() -> String>,
            render_answer: identity,
        });

        assert_eq!(code, 1);
        assert_eq!(
            errors.borrow().as_slice(),
            ["task missing is no longer in this worktree"]
        );
    }

    #[test]
    fn non_tty_session_points_users_to_print() {
        assert_eq!(
            ask_session_tty_error(false, true),
            Some(NON_TTY_ASK_MESSAGE)
        );
        assert_eq!(
            ask_session_tty_error(true, false),
            Some(NON_TTY_ASK_MESSAGE)
        );
        assert_eq!(ask_session_tty_error(true, true), None);
    }
}
