use std::env;
use std::io::{self, IsTerminal, Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use serde_json::{json, Map};

use factory::add_options::{parse_add_options, ParseAddOptionsResult, TaskComplexity};
use factory::agent_session::{
    agent_session_command, build_agent_session_handoff, parse_agent_session_args, target_task,
    InteractiveAgent, ParseAgentSessionResult,
};
use factory::agents::{agent_label, run_agent, Access, AgentRun};
use factory::ask::{
    answer_ask_question_with_runner, ask_session_tty_error, parse_ask_request, run_ask_session,
    sort_for_ask, AskMode, AskSessionIo, AskTurnOutcome,
};
use factory::backlog::{add_backlog, load_backlog, remove_backlog, RemoveBacklogResult};
use factory::clock::now_iso;
use factory::conductor::{run_task, TaskOutcome};
use factory::config::{expand_tilde, global_config_file, load_context, load_repo_context};
use factory::editor::{compose_in_editor, open_editor};
use factory::evals::capture_correction;
use factory::feedback::{
    decide_feedback_route, feedback_route_input, follow_up_intent, latest_feedback_target,
    FeedbackRoute,
};
use factory::git::has_changes;
use factory::hooks::{emit, HookEvent};
use factory::input::{parse_input_args, ParseInputResult, ParsedInput};
use factory::lessons::{read_candidates, read_lessons};
use factory::prompt_worker::start_prompt_worker;
use factory::task::{
    add_task, append_answer, append_feedback, find_task, latest_task, load_tasks,
    mark_feedback_consumed, next_runnable, read_live_meter, read_plan, resumable_statuses,
    save_meta, set_status, AddTaskOptions, ResumeKind, SharpenState, Status,
};
use factory::upgrade::upgrade_factory;
use factory::version::resolve_factory_version;
use factory::view::{print_config, print_report, print_show};

const HELP: &str = r#"factory - a self-improving coding loop.

COMMANDS
  factory add [--raw] [--trivial | --complexity trivial|complex] [intent...] [--verify <cmd...>]
  factory backlog [add|rm]
  factory answer [task-id] [-m <answer> | --edit]
  factory resume [task-id] [-m <note> | --edit]
  factory feedback [task-id] [-m <feedback> | --edit]
  factory correct [task-id] [-m <note> | --edit]
  factory run [--once | --drain] [--no-prompt]
  factory status
  factory ask [--print] [task-id] [question...]
  factory show [task-id] [step]
  factory report
  factory lessons
  factory session [--agent codex|claude] [task-id]
  factory codex [task-id]
  factory claude [task-id]
  factory config
  factory version | --version
  factory upgrade

The Rust rewrite covers the queue/config/state commands plus the autonomous
triage, sharpen, planning, review, verify, commit, retry, and delivery loop.
"#;

fn parse_add(args: &[String]) -> (String, Option<String>) {
    let verify_index = args.iter().position(|arg| arg == "--verify");
    match verify_index {
        Some(i) => {
            let intent = args[..i].join(" ").trim().to_string();
            let verify = args[i + 1..].join(" ").trim().to_string();
            (intent, (!verify.is_empty()).then_some(verify))
        }
        None => (args.join(" ").trim().to_string(), None),
    }
}

fn resolve_intent(args: &[String]) -> io::Result<(String, Option<String>)> {
    let (mut intent, verify) = parse_add(args);
    if intent.is_empty() && !io::stdin().is_terminal() {
        let mut stdin = String::new();
        io::stdin().read_to_string(&mut stdin)?;
        intent = stdin.trim().to_string();
    }
    Ok((intent, verify))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MessageMode {
    Required,
    Optional,
}

fn resolve_message(parsed: &ParsedInput, mode: MessageMode) -> io::Result<Option<String>> {
    if let Some(message) = &parsed.message {
        let trimmed = message.trim().to_string();
        return Ok((!trimmed.is_empty()).then_some(trimmed));
    }
    if parsed.edit {
        let text = compose_in_editor("")?;
        return Ok((!text.is_empty()).then_some(text));
    }
    if mode == MessageMode::Required {
        if io::stdin().is_terminal() {
            let text = compose_in_editor("")?;
            Ok((!text.is_empty()).then_some(text))
        } else {
            let mut stdin = String::new();
            io::stdin().read_to_string(&mut stdin)?;
            let text = stdin.trim().to_string();
            Ok((!text.is_empty()).then_some(text))
        }
    } else {
        Ok(None)
    }
}

fn add_command(raw_args: &[String]) -> Result<i32, Box<dyn std::error::Error>> {
    let parsed = match parse_add_options(raw_args) {
        ParseAddOptionsResult::Ok(options) => options,
        ParseAddOptionsResult::Err(message) => {
            eprintln!("{message}");
            return Ok(2);
        }
    };
    let (intent, verify) = resolve_intent(&parsed.args)?;
    if intent.is_empty() {
        eprintln!("usage: factory add [intent...] [--verify <cmd...>]");
        eprintln!("missing intent");
        return Ok(2);
    }

    let ctx = load_context(env::current_dir()?)?;
    let task = add_task(
        &ctx,
        &intent,
        verify.clone(),
        AddTaskOptions {
            sharpen: Some(if parsed.raw || parsed.complexity.is_some() {
                SharpenState::Done
            } else {
                SharpenState::Pending
            }),
            complexity: parsed.complexity,
            ..AddTaskOptions::default()
        },
    )?;
    println!(
        "queued {}{}",
        task.id,
        queued_suffix(verify.as_deref(), parsed.complexity)
    );
    Ok(0)
}

fn queued_suffix(verify: Option<&str>, complexity: Option<TaskComplexity>) -> String {
    let mut pieces = Vec::new();
    if let Some(verify) = verify {
        pieces.push(format!("verify: {verify}"));
    }
    match complexity {
        Some(TaskComplexity::Trivial) => pieces.push("declared trivial".to_string()),
        Some(TaskComplexity::Complex) => pieces.push("declared complex".to_string()),
        None => {}
    }
    if pieces.is_empty() {
        String::new()
    } else {
        format!(" ({})", pieces.join(", "))
    }
}

fn status_command() -> Result<i32, Box<dyn std::error::Error>> {
    let ctx = load_context(env::current_dir()?)?;
    let tasks = load_tasks(&ctx)?;
    if tasks.is_empty() {
        println!("no tasks");
        return Ok(0);
    }
    for task in tasks {
        let meter = if is_active_status(task.meta.status) {
            read_live_meter(&task)?.map(|meter| {
                format!(
                    " - tokens {} in -> {} out ({} total)",
                    format_tokens(meter.input_tokens),
                    format_tokens(meter.output_tokens),
                    format_tokens(meter.input_tokens + meter.output_tokens)
                )
            })
        } else {
            None
        }
        .unwrap_or_default();
        let updated = task
            .meta
            .updated_at
            .as_deref()
            .unwrap_or(task.meta.created_at.as_str());
        let note = task
            .meta
            .note
            .as_deref()
            .map(|note| format!(" - {note}"))
            .unwrap_or_default();
        println!(
            "{}\t{}\t{}{}{}",
            task.id,
            task.meta.status.as_str(),
            updated,
            note,
            meter
        );
    }
    Ok(0)
}

fn format_tokens(tokens: i64) -> String {
    if tokens.abs() >= 1000 {
        format!("{:.1}k", tokens as f64 / 1000.0)
    } else {
        tokens.to_string()
    }
}

fn is_active_status(status: Status) -> bool {
    !matches!(
        status,
        Status::Ready | Status::NeedsInput | Status::Retrying | Status::Done | Status::Blocked
    )
}

fn queue_attention_state(tasks: &[factory::task::Task]) -> Option<&'static str> {
    if tasks.iter().any(|task| task.meta.status == Status::Blocked) {
        return Some("blocked");
    }
    if tasks
        .iter()
        .any(|task| task.meta.status == Status::NeedsInput)
    {
        return Some("needs-input");
    }
    if !tasks.is_empty() && tasks.iter().all(|task| task.meta.status == Status::Done) {
        return Some("done");
    }
    None
}

fn emit_attention_if_changed(
    ctx: &factory::config::WorkContext,
    alerted: &mut Option<String>,
    state: Option<&str>,
) {
    let state = state.unwrap_or("none");
    if alerted.as_deref() == Some(state) {
        return;
    }
    *alerted = Some(state.to_string());
    let mut payload = Map::new();
    payload.insert("state".to_string(), json!(state));
    emit(&ctx.root, &ctx.config.hooks, HookEvent::Attention, payload);
}

fn emit_loop_idle(ctx: &factory::config::WorkContext, state: Option<&str>) {
    let mut payload = Map::new();
    payload.insert("state".to_string(), json!(state.unwrap_or("idle")));
    emit(&ctx.root, &ctx.config.hooks, HookEvent::LoopIdle, payload);
}

fn clear_stage(ctx: &factory::config::WorkContext) {
    let mut payload = Map::new();
    payload.insert("stage".to_string(), json!(""));
    payload.insert("active".to_string(), json!(false));
    emit(
        &ctx.root,
        &ctx.config.hooks,
        HookEvent::StageChange,
        payload,
    );
}

fn run_command(args: &[String]) -> Result<i32, Box<dyn std::error::Error>> {
    let mut once = false;
    let mut drain = false;
    let mut no_prompt = false;
    for arg in args {
        match arg.as_str() {
            "--once" => once = true,
            "--drain" => drain = true,
            "--no-prompt" => no_prompt = true,
            other => {
                eprintln!("unknown run option: {other}");
                eprintln!("usage: factory run [--once | --drain] [--no-prompt]");
                return Ok(2);
            }
        }
    }
    if once && drain {
        eprintln!("usage: factory run [--once | --drain] [--no-prompt]");
        eprintln!("choose only one of --once or --drain");
        return Ok(2);
    }

    let mut alerted: Option<String> = None;
    let interactive = !once && !drain && io::stdin().is_terminal() && !no_prompt;
    if interactive {
        start_prompt_worker(load_context(env::current_dir()?)?);
    }
    loop {
        let ctx = load_context(env::current_dir()?)?;
        let Some(task) = next_runnable(&ctx, factory::clock::now_millis())? else {
            let tasks = load_tasks(&ctx)?;
            let state = queue_attention_state(&tasks);
            emit_attention_if_changed(&ctx, &mut alerted, state);
            if once || drain {
                println!("no runnable tasks");
                clear_stage(&ctx);
                return Ok(0);
            }
            emit_loop_idle(&ctx, state);
            thread::sleep(Duration::from_secs(2));
            continue;
        };

        emit_attention_if_changed(&ctx, &mut alerted, None);
        println!("running {}", task.id);
        match run_task(&ctx, task)? {
            TaskOutcome::Done => {
                println!("done");
                if once {
                    clear_stage(&ctx);
                    return Ok(0);
                }
            }
            TaskOutcome::NeedsInput { .. } => {
                println!("needs input");
                if once || drain {
                    clear_stage(&ctx);
                    return Ok(0);
                }
            }
            TaskOutcome::Retrying {
                reason, retry_at, ..
            } => {
                println!("retrying at {retry_at}: {reason}");
                if once || drain {
                    clear_stage(&ctx);
                    return Ok(0);
                }
            }
            TaskOutcome::Blocked { reason, .. } => {
                eprintln!("blocked: {reason}");
                if once || drain {
                    clear_stage(&ctx);
                    return Ok(1);
                }
            }
        }

        if !drain && !once {
            continue;
        }
        if once {
            return Ok(0);
        }
    }
}

fn show_command(args: &[String]) -> Result<i32, Box<dyn std::error::Error>> {
    if args.len() > 2 {
        eprintln!("usage: factory show [task-id] [step]");
        return Ok(1);
    }
    let ctx = load_context(env::current_dir()?)?;
    Ok(print_show(
        &ctx,
        args.first().map(String::as_str),
        args.get(1).map(String::as_str),
    )?)
}

fn ask_command(args: &[String]) -> Result<i32, Box<dyn std::error::Error>> {
    let ctx = load_context(env::current_dir()?)?;
    let tasks = sort_for_ask(&load_tasks(&ctx)?);
    let request = parse_ask_request(args, &tasks);
    if tasks.is_empty() {
        eprintln!("no tasks in this worktree");
        return Ok(1);
    }

    if request.mode == AskMode::Print {
        if request.question.is_empty() {
            eprintln!("usage: factory ask --print [task-id] <question...>");
            return Ok(1);
        }
        let result = answer_ask_question_with_runner(
            &ctx,
            &request.question,
            request.task_id.as_deref(),
            &[],
            &[],
            |prompt, _selected| {
                run_agent(
                    &ctx.ask_agent,
                    &AgentRun {
                        root: ctx.root.clone(),
                        prompt,
                        access: Access::Read,
                        out_file: None,
                    },
                )
                .map(|result| result.text)
            },
        )?;
        println!("{}", result.answer);
        return Ok(0);
    }

    if let Some(message) =
        ask_session_tty_error(io::stdin().is_terminal(), io::stdout().is_terminal())
    {
        eprintln!("{message}");
        return Ok(1);
    }

    let task_id = request.task_id.clone();
    let code = run_ask_session(AskSessionIo {
        agent: agent_label(&ctx.ask_agent),
        task_id: task_id.clone(),
        initial_question: request.question,
        read_line: || {
            print!("you> ");
            let _ = io::stdout().flush();
            let mut line = String::new();
            if io::stdin().read_line(&mut line).is_ok() {
                line
            } else {
                String::new()
            }
        },
        write: |text| println!("{text}"),
        write_error: |text| eprintln!("{text}"),
        turn: |question, transcript, carried_task_ids| match answer_ask_question_with_runner(
            &ctx,
            question,
            task_id.as_deref(),
            transcript,
            carried_task_ids,
            |prompt, _selected| {
                run_agent(
                    &ctx.ask_agent,
                    &AgentRun {
                        root: ctx.root.clone(),
                        prompt,
                        access: Access::Read,
                        out_file: None,
                    },
                )
                .map(|result| result.text)
            },
        ) {
            Ok(result) => Ok(AskTurnOutcome::Answer {
                answer: result.answer,
                selected_task_ids: result.selected_task_ids,
            }),
            Err(err) if err.to_string().contains("is no longer in this worktree") => {
                Ok(AskTurnOutcome::Fatal {
                    message: err.to_string(),
                })
            }
            Err(err) => Err(err.to_string()),
        },
        edit: Some(|| compose_in_editor("").unwrap_or_default()),
        render_answer: factory::sharpen::render_agent_markdown,
    });
    Ok(code)
}

fn config_command(args: &[String]) -> Result<i32, Box<dyn std::error::Error>> {
    let ctx = load_context(env::current_dir()?)?;
    if args.first().map(String::as_str) == Some("edit") {
        let dir_flag = args.iter().position(|arg| arg == "--dir");
        let explicit_dir = match dir_flag {
            Some(index) => {
                let Some(dir) = args.get(index + 1) else {
                    eprintln!("usage: factory config edit --dir <dir>");
                    return Ok(1);
                };
                Some(dir.as_str())
            }
            None => None,
        };
        let legacy_dir = args
            .get(1)
            .filter(|arg| !arg.starts_with("--"))
            .map(String::as_str);
        let target = if args.iter().any(|arg| arg == "--worktree") {
            Some(ctx.root.as_str())
        } else if args.iter().any(|arg| arg == "--repo-parent") {
            std::path::Path::new(&ctx.root)
                .parent()
                .and_then(|path| path.to_str())
        } else {
            explicit_dir.or(legacy_dir)
        };
        let path = target
            .map(|target| format!("{}/.factory.json", expand_tilde(target)))
            .unwrap_or_else(global_config_file);
        if !std::path::Path::new(&path).exists() {
            if let Some(parent) = std::path::Path::new(&path).parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, "{}\n")?;
        }
        eprintln!("editing {path}");
        open_editor(path)?;
        return Ok(0);
    }
    print_config(&ctx);
    Ok(0)
}

fn lessons_command() -> Result<i32, Box<dyn std::error::Error>> {
    let ctx = load_context(env::current_dir()?)?;
    println!("## LESSONS.md (curated - read by the planner each run)");
    println!(
        "{}",
        read_lessons(&ctx)?.unwrap_or_else(|| "(none yet)".to_string())
    );
    println!();
    println!("## candidates (raw signal - curate the recurring ones into LESSONS.md)");
    println!(
        "{}",
        read_candidates(&ctx)?.unwrap_or_else(|| "(none yet)".to_string())
    );
    Ok(0)
}

fn answer_command(args: &[String]) -> Result<i32, Box<dyn std::error::Error>> {
    let usage = "usage: factory answer [task-id] [-m <answer> | --edit]";
    let parsed = match parse_input_args(args, usage) {
        ParseInputResult::Ok(parsed) => parsed,
        ParseInputResult::Err(error) => {
            eprintln!("{error}");
            return Ok(1);
        }
    };
    let ctx = load_context(env::current_dir()?)?;
    let Some(mut task) = (if let Some(query) = &parsed.task_query {
        find_task(&ctx, query)?
    } else {
        latest_task(&ctx, Some(&[Status::NeedsInput]))?
    }) else {
        eprintln!(
            "{}",
            parsed
                .task_query
                .as_ref()
                .map(|query| format!("no task matching {query}"))
                .unwrap_or_else(|| "no needs-input task to answer".to_string())
        );
        return Ok(1);
    };
    let Some(text) = resolve_message(&parsed, MessageMode::Required)? else {
        eprintln!("{usage}");
        return Ok(1);
    };
    append_answer(&task, &text)?;
    set_status(&mut task, Status::Ready, None)?;
    println!("{}: answered, back in queue", task.id);
    Ok(0)
}

fn resume_command(args: &[String]) -> Result<i32, Box<dyn std::error::Error>> {
    let usage = "usage: factory resume [task-id] [-m <note> | --edit]";
    let parsed = match parse_input_args(args, usage) {
        ParseInputResult::Ok(parsed) => parsed,
        ParseInputResult::Err(error) => {
            eprintln!("{error}");
            return Ok(1);
        }
    };
    let ctx = load_context(env::current_dir()?)?;
    let statuses = resumable_statuses();
    let Some(mut task) = (if let Some(query) = &parsed.task_query {
        find_task(&ctx, query)?
    } else {
        latest_task(&ctx, Some(&statuses))?
    }) else {
        eprintln!(
            "{}",
            parsed
                .task_query
                .as_ref()
                .map(|query| format!("no task matching {query}"))
                .unwrap_or_else(|| {
                    "no resumable task (blocked, retrying, or interrupted mid-stage)".to_string()
                })
        );
        return Ok(1);
    };
    let note = resolve_message(&parsed, MessageMode::Optional)?;
    task.meta.resume = true;
    task.meta.resume_note = note.clone();
    task.meta.resume_kind = Some(ResumeKind::Manual);
    task.meta.auto_retries = 0;
    task.meta.retry_at = None;
    set_status(&mut task, Status::Ready, None)?;
    println!(
        "{}: resuming, back in queue{}",
        task.id,
        if note.is_some() { " with note" } else { "" }
    );
    Ok(0)
}

fn feedback_command(args: &[String]) -> Result<i32, Box<dyn std::error::Error>> {
    let usage = "usage: factory feedback [task-id] [-m <feedback> | --edit]";
    let parsed = match parse_input_args(args, usage) {
        ParseInputResult::Ok(parsed) => parsed,
        ParseInputResult::Err(error) => {
            eprintln!("{error}");
            return Ok(1);
        }
    };
    let ctx = load_context(env::current_dir()?)?;
    let has_worktree_diff = has_changes(&ctx.root)?;
    let Some(mut task) = (if let Some(query) = &parsed.task_query {
        find_task(&ctx, query)?
    } else {
        let tasks = load_tasks(&ctx)?;
        latest_feedback_target(&tasks, |candidate| {
            feedback_route_input(
                candidate,
                read_plan(candidate).ok().flatten().is_some(),
                has_worktree_diff,
            )
        })
    }) else {
        eprintln!(
            "{}",
            parsed
                .task_query
                .as_ref()
                .map(|query| format!("no task matching {query}"))
                .unwrap_or_else(|| "no feedback target with existing progress".to_string())
        );
        return Ok(1);
    };

    let route = decide_feedback_route(&feedback_route_input(
        &task,
        read_plan(&task)?.is_some(),
        has_worktree_diff,
    ));
    if let FeedbackRoute::Reject { message } = route {
        eprintln!("{message}");
        return Ok(1);
    }

    let Some(text) = resolve_message(&parsed, MessageMode::Required)? else {
        eprintln!("{usage}");
        return Ok(1);
    };
    match route {
        FeedbackRoute::FollowUp => {
            append_feedback(&mut task, &text)?;
            let consumed = task.meta.feedback_count;
            mark_feedback_consumed(&mut task, consumed);
            save_meta(&task)?;
            let follow_up = add_task(
                &ctx,
                &follow_up_intent(&task, &text),
                task.meta.verify.clone(),
                AddTaskOptions {
                    sharpen: Some(SharpenState::Skipped),
                    feedback_source_task_id: Some(task.id.clone()),
                    ..AddTaskOptions::default()
                },
            )?;
            println!(
                "{}: done, queued follow-up {} for feedback",
                task.id, follow_up.id
            );
            Ok(0)
        }
        FeedbackRoute::Resume => {
            append_feedback(&mut task, &text)?;
            task.meta.resume = true;
            task.meta.resume_kind = Some(ResumeKind::Manual);
            task.meta.resume_note = None;
            task.meta.auto_retries = 0;
            task.meta.retry_at = None;
            set_status(&mut task, Status::Ready, None)?;
            println!("{}: feedback recorded, back in queue", task.id);
            Ok(0)
        }
        FeedbackRoute::Reject { .. } => unreachable!("reject route returned earlier"),
    }
}

fn correct_command(args: &[String]) -> Result<i32, Box<dyn std::error::Error>> {
    let usage = "usage: factory correct [task-id] [-m <note> | --edit]";
    let parsed = match parse_input_args(args, usage) {
        ParseInputResult::Ok(parsed) => parsed,
        ParseInputResult::Err(error) => {
            eprintln!("{error}");
            return Ok(1);
        }
    };
    let ctx = load_context(env::current_dir()?)?;
    let Some(mut task) = (if let Some(query) = &parsed.task_query {
        find_task(&ctx, query)?
    } else {
        latest_task(&ctx, Some(&[Status::Blocked]))?
    }) else {
        eprintln!(
            "{}",
            parsed
                .task_query
                .as_ref()
                .map(|query| format!("no task matching {query}"))
                .unwrap_or_else(|| "no blocked task to correct".to_string())
        );
        return Ok(1);
    };

    let note = resolve_message(&parsed, MessageMode::Optional)?.unwrap_or_default();
    capture_correction(&ctx, &task, &note);
    set_status(&mut task, Status::Done, None)?;
    println!("{}: correction recorded, marked done", task.id);
    Ok(0)
}

fn session_command(
    args: &[String],
    default_agent: InteractiveAgent,
    command_name: &str,
) -> Result<i32, Box<dyn std::error::Error>> {
    let request = match parse_agent_session_args(args, default_agent) {
        ParseAgentSessionResult::Ok(request) => request,
        ParseAgentSessionResult::Err(message) => {
            eprintln!("{message}");
            return Ok(1);
        }
    };
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        eprintln!("factory {command_name} needs an interactive terminal");
        return Ok(1);
    }
    let ctx = load_context(env::current_dir()?)?;
    let Some(task) = target_task(&ctx, request.task_query.as_deref())? else {
        eprintln!(
            "{}",
            request
                .task_query
                .as_ref()
                .map(|query| format!("no task matching {query}"))
                .unwrap_or_else(|| "no done task in this worktree".to_string())
        );
        return Ok(1);
    };
    let handoff = build_agent_session_handoff(&ctx, &task, request.agent, &now_iso())?;
    eprintln!("wrote {}", handoff.artifact);
    eprintln!("summary target: {}", handoff.summary_path);
    let cmd = agent_session_command(
        request.agent,
        &ctx.root,
        &task.id,
        &handoff.artifact,
        &handoff.summary_path,
    );
    let status = Command::new(&cmd[0])
        .args(&cmd[1..])
        .current_dir(&ctx.root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?;
    if std::fs::read_to_string(&handoff.summary_path)
        .map(|text| text.trim().is_empty())
        .unwrap_or(true)
    {
        eprintln!("warning: no summary written at {}", handoff.summary_path);
    }
    Ok(status.code().unwrap_or(1))
}

fn backlog_command(args: &[String]) -> Result<i32, Box<dyn std::error::Error>> {
    let Some(command) = args.first().map(String::as_str) else {
        eprintln!("usage: factory backlog [add|rm] ...");
        return Ok(2);
    };
    let ctx = load_repo_context(env::current_dir()?)?;
    match command {
        "add" => {
            let (intent, verify) = resolve_intent(&args[1..])?;
            if intent.is_empty() {
                eprintln!("missing backlog intent");
                return Ok(2);
            }
            let entry = add_backlog(&ctx, &intent, verify)?;
            println!("backlog queued {}", entry.id);
            Ok(0)
        }
        "rm" => {
            let Some(query) = args.get(1) else {
                eprintln!("usage: factory backlog rm <id-or-substring>");
                return Ok(2);
            };
            match remove_backlog(&ctx, query)? {
                Some(RemoveBacklogResult::Removed(entry)) => {
                    println!("removed {}", entry.id);
                    Ok(0)
                }
                Some(RemoveBacklogResult::Ambiguous(entries)) => {
                    eprintln!(
                        "ambiguous backlog id: {}",
                        entries
                            .iter()
                            .map(|entry| entry.id.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    );
                    Ok(2)
                }
                None => {
                    eprintln!("no backlog entry matched {query}");
                    Ok(1)
                }
            }
        }
        "list" => {
            for entry in load_backlog(&ctx)? {
                println!("{}\t{}", entry.id, entry.created_at);
            }
            Ok(0)
        }
        _ => {
            eprintln!("usage: factory backlog [add|rm|list] ...");
            Ok(2)
        }
    }
}

fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        println!("{HELP}");
        return Ok(0);
    };
    match command {
        "--help" | "-h" | "help" => {
            println!("{HELP}");
            Ok(0)
        }
        "--version" | "version" => {
            println!("{}", resolve_factory_version());
            Ok(0)
        }
        "upgrade" => match upgrade_factory(
            &env::current_exe()?.to_string_lossy(),
            &env::current_dir()?.to_string_lossy(),
        ) {
            Ok(message) => {
                println!("{message}");
                Ok(0)
            }
            Err(err) => {
                eprintln!("{err}");
                Ok(1)
            }
        },
        "add" => add_command(&args[1..]),
        "answer" => answer_command(&args[1..]),
        "resume" => resume_command(&args[1..]),
        "feedback" => feedback_command(&args[1..]),
        "correct" => correct_command(&args[1..]),
        "run" => run_command(&args[1..]),
        "status" => status_command(),
        "ask" => ask_command(&args[1..]),
        "show" => show_command(&args[1..]),
        "report" => {
            let ctx = load_repo_context(env::current_dir()?)?;
            Ok(print_report(&ctx))
        }
        "lessons" => lessons_command(),
        "session" => session_command(&args[1..], InteractiveAgent::Codex, "session"),
        "codex" => session_command(&args[1..], InteractiveAgent::Codex, "codex"),
        "claude" => session_command(&args[1..], InteractiveAgent::Claude, "claude"),
        "config" => config_command(&args[1..]),
        "backlog" => backlog_command(&args[1..]),
        other => {
            eprintln!("unknown command: {other}");
            eprintln!("{HELP}");
            Ok(2)
        }
    }
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use factory::task::{Meta, Task};

    fn task(status: Status) -> Task {
        Task {
            id: format!("task-{}", status.as_str()),
            dir: "/tmp/task".to_string(),
            meta: Meta {
                id: format!("task-{}", status.as_str()),
                slug: "task".to_string(),
                status,
                verify: None,
                created_at: "2026-01-01T00:00:00Z".to_string(),
                updated_at: None,
                commit: None,
                note: None,
                sharpen: SharpenState::Done,
                resume: false,
                resume_note: None,
                resume_kind: None,
                retry_at: None,
                auto_retries: 0,
                complexity: None,
                feedback_count: 0,
                feedback_consumed: 0,
                feedback_source_task_id: None,
            },
        }
    }

    #[test]
    fn queue_attention_state_prioritizes_waiting_states() {
        assert_eq!(queue_attention_state(&[]), None);
        assert_eq!(
            queue_attention_state(&[task(Status::Done), task(Status::Done)]),
            Some("done")
        );
        assert_eq!(
            queue_attention_state(&[task(Status::Done), task(Status::Ready)]),
            None
        );
        assert_eq!(
            queue_attention_state(&[task(Status::Done), task(Status::NeedsInput)]),
            Some("needs-input")
        );
        assert_eq!(
            queue_attention_state(&[
                task(Status::NeedsInput),
                task(Status::Blocked),
                task(Status::Done),
            ]),
            Some("blocked")
        );
    }
}
