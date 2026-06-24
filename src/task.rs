use std::cmp::Ordering;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::add_options::TaskComplexity;
use crate::clock::now_iso;
use crate::config::WorkContext;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Ready,
    NeedsInput,
    Sharpening,
    Grilling,
    Planning,
    Implementing,
    Reviewing,
    Verifying,
    Shipping,
    Retrying,
    Done,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SharpenState {
    Pending,
    Done,
    Skipped,
}

impl SharpenState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Done => "done",
            Self::Skipped => "skipped",
        }
    }
}

fn default_status() -> Status {
    Status::Ready
}

fn default_sharpen() -> SharpenState {
    SharpenState::Done
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    pub id: String,
    pub slug: String,
    #[serde(default = "default_status")]
    pub status: Status,
    #[serde(default)]
    pub verify: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default = "default_sharpen")]
    pub sharpen: SharpenState,
    #[serde(default)]
    pub resume: bool,
    #[serde(default, rename = "resumeNote")]
    pub resume_note: Option<String>,
    #[serde(default, rename = "resumeKind")]
    pub resume_kind: Option<ResumeKind>,
    #[serde(default, rename = "retryAt")]
    pub retry_at: Option<String>,
    #[serde(default, rename = "autoRetries")]
    pub auto_retries: u32,
    #[serde(default)]
    pub complexity: Option<TaskComplexity>,
    #[serde(default, rename = "feedbackCount")]
    pub feedback_count: u32,
    #[serde(default, rename = "feedbackConsumed")]
    pub feedback_consumed: u32,
    #[serde(default, rename = "feedbackSourceTaskId")]
    pub feedback_source_task_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResumeKind {
    Manual,
    AutoRetry,
    Stranded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub dir: String,
    pub meta: Meta,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AddTaskOptions {
    pub status: Option<Status>,
    pub sharpen: Option<SharpenState>,
    pub complexity: Option<TaskComplexity>,
    pub feedback_source_task_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Failure {
    pub attempt: u32,
    pub gate: String,
    pub summary: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveMeterStage {
    pub stage: String,
    pub agent: String,
    #[serde(rename = "inTok")]
    pub in_tok: i64,
    #[serde(rename = "outTok")]
    pub out_tok: i64,
    pub ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveMeter {
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "inputTokens")]
    pub input_tokens: i64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: i64,
    pub stages: Vec<LiveMeterStage>,
}

pub fn is_stranded(status: Status) -> bool {
    !matches!(
        status,
        Status::Ready
            | Status::NeedsInput
            | Status::Grilling
            | Status::Retrying
            | Status::Done
            | Status::Blocked
    )
}

pub fn resumable_statuses() -> Vec<Status> {
    [
        Status::Ready,
        Status::NeedsInput,
        Status::Sharpening,
        Status::Grilling,
        Status::Planning,
        Status::Implementing,
        Status::Reviewing,
        Status::Verifying,
        Status::Shipping,
        Status::Retrying,
        Status::Done,
        Status::Blocked,
    ]
    .into_iter()
    .filter(|status| matches!(status, Status::Blocked | Status::Retrying) || is_stranded(*status))
    .collect()
}

fn slugify(text: &str) -> String {
    let re = Regex::new(r"[^a-z0-9]+").expect("slug regex compiles");
    let lower = text.to_lowercase();
    let slug = re.replace_all(&lower, "-");
    let slug = slug
        .trim_matches('-')
        .chars()
        .take(40)
        .collect::<String>()
        .trim_end_matches('-')
        .to_string();
    if slug.is_empty() {
        "task".to_string()
    } else {
        slug
    }
}

fn first_line(text: &str) -> &str {
    text.trim().lines().next().unwrap_or_default()
}

fn list_task_dirs(tasks_dir: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(tasks_dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    dirs.sort();
    dirs
}

pub fn add_task(
    ctx: &WorkContext,
    intent: &str,
    verify: Option<String>,
    options: AddTaskOptions,
) -> io::Result<Task> {
    fs::create_dir_all(&ctx.tasks_dir)?;
    let slug = slugify(first_line(intent));
    let mut id = slug.clone();
    let mut dir = PathBuf::from(&ctx.tasks_dir).join(&id);
    for n in 2.. {
        match fs::create_dir(&dir) {
            Ok(()) => break,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                id = format!("{slug}-{n}");
                dir = PathBuf::from(&ctx.tasks_dir).join(&id);
            }
            Err(err) => return Err(err),
        }
    }

    let now = now_iso();
    let meta = Meta {
        id: id.clone(),
        slug,
        status: options.status.unwrap_or(Status::Ready),
        verify,
        created_at: now.clone(),
        updated_at: Some(now),
        commit: None,
        note: None,
        sharpen: options.sharpen.unwrap_or(SharpenState::Done),
        resume: false,
        resume_note: None,
        resume_kind: None,
        retry_at: None,
        auto_retries: 0,
        complexity: options.complexity,
        feedback_count: 0,
        feedback_consumed: 0,
        feedback_source_task_id: options.feedback_source_task_id,
    };

    fs::write(dir.join("task.md"), format!("{}\n", intent.trim()))?;
    write_meta_path(&dir, &meta)?;
    Ok(Task {
        id,
        dir: dir.to_string_lossy().to_string(),
        meta,
    })
}

pub fn load_tasks(ctx: &WorkContext) -> io::Result<Vec<Task>> {
    let mut tasks = Vec::new();
    for name in list_task_dirs(&ctx.tasks_dir) {
        let dir = PathBuf::from(&ctx.tasks_dir).join(&name);
        let meta_path = dir.join("meta.json");
        if !meta_path.exists() {
            continue;
        }
        let text = fs::read_to_string(&meta_path)?;
        let meta: Meta = serde_json::from_str(&text).map_err(io::Error::other)?;
        tasks.push(Task {
            id: name,
            dir: dir.to_string_lossy().to_string(),
            meta,
        });
    }
    tasks.sort_by(|a, b| a.meta.created_at.cmp(&b.meta.created_at));
    Ok(tasks)
}

pub fn next_runnable(ctx: &WorkContext, now_ms: i64) -> io::Result<Option<Task>> {
    let tasks = load_tasks(ctx)?;
    if let Some(task) = tasks.iter().find(|task| task.meta.status == Status::Ready) {
        return Ok(Some(task.clone()));
    }
    if let Some(task) = tasks.iter().find(|task| is_stranded(task.meta.status)) {
        return recover_stranded(task.clone()).map(Some);
    }
    let mut due: Vec<Task> = tasks
        .into_iter()
        .filter(|task| {
            task.meta.status == Status::Retrying
                && task
                    .meta
                    .retry_at
                    .as_deref()
                    .and_then(parse_iso_millis)
                    .is_some_and(|retry_at| retry_at <= now_ms)
        })
        .collect();
    due.sort_by(|a, b| match (&a.meta.retry_at, &b.meta.retry_at) {
        (Some(a), Some(b)) => a.cmp(b),
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (None, None) => Ordering::Equal,
    });
    let Some(first) = due.into_iter().next() else {
        return Ok(None);
    };
    resume_run(first, ResumeKind::AutoRetry).map(Some)
}

fn parse_iso_millis(text: &str) -> Option<i64> {
    let parsed =
        ::time::OffsetDateTime::parse(text, &::time::format_description::well_known::Rfc3339)
            .ok()?;
    Some(parsed.unix_timestamp_nanos().checked_div(1_000_000)? as i64)
}

fn resume_run(mut task: Task, kind: ResumeKind) -> io::Result<Task> {
    task.meta.resume = true;
    task.meta.resume_kind = Some(kind);
    task.meta.retry_at = None;
    set_status(&mut task, Status::Ready, None)?;
    Ok(task)
}

fn recover_stranded(mut task: Task) -> io::Result<Task> {
    if matches!(task.meta.status, Status::Sharpening | Status::Planning) {
        let status = task.meta.status;
        task.meta.resume = false;
        task.meta.resume_kind = None;
        task.meta.retry_at = None;
        set_status(
            &mut task,
            Status::Ready,
            Some(format!(
                "recovered after interrupted {} stage",
                status.as_str()
            )),
        )?;
        return Ok(task);
    }
    task.meta.resume_note = Some(format!(
        "Recovered after interrupted {} stage. Inspect existing work and continue from the saved artifacts.",
        task.meta.status.as_str()
    ));
    resume_run(task, ResumeKind::Stranded)
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Ready => "ready",
            Status::NeedsInput => "needs-input",
            Status::Sharpening => "sharpening",
            Status::Grilling => "grilling",
            Status::Planning => "planning",
            Status::Implementing => "implementing",
            Status::Reviewing => "reviewing",
            Status::Verifying => "verifying",
            Status::Shipping => "shipping",
            Status::Retrying => "retrying",
            Status::Done => "done",
            Status::Blocked => "blocked",
        }
    }
}

pub fn latest_task(ctx: &WorkContext, statuses: Option<&[Status]>) -> io::Result<Option<Task>> {
    let tasks = load_tasks(ctx)?;
    Ok(tasks
        .into_iter()
        .filter(|task| {
            statuses
                .map(|statuses| statuses.contains(&task.meta.status))
                .unwrap_or(true)
        })
        .max_by(|a, b| {
            let a_stamp = a.meta.updated_at.as_ref().unwrap_or(&a.meta.created_at);
            let b_stamp = b.meta.updated_at.as_ref().unwrap_or(&b.meta.created_at);
            a_stamp.cmp(b_stamp)
        }))
}

pub fn set_status(task: &mut Task, status: Status, note: Option<String>) -> io::Result<()> {
    task.meta.status = status;
    task.meta.note = note;
    task.meta.updated_at = Some(now_iso());
    write_meta(task)
}

pub fn save_meta(task: &Task) -> io::Result<()> {
    write_meta(task)
}

pub fn find_task(ctx: &WorkContext, query: &str) -> io::Result<Option<Task>> {
    let tasks = load_tasks(ctx)?;
    Ok(tasks
        .iter()
        .find(|task| task.id == query)
        .cloned()
        .or_else(|| tasks.into_iter().find(|task| task.id.contains(query))))
}

pub fn read_intent(task: &Task) -> io::Result<String> {
    Ok(fs::read_to_string(Path::new(&task.dir).join("task.md"))?
        .trim()
        .to_string())
}

pub fn ready_sharpened_task(
    task: &mut Task,
    intent: &str,
    verify: Option<String>,
) -> io::Result<()> {
    fs::write(
        Path::new(&task.dir).join("task.md"),
        format!("{}\n", intent.trim()),
    )?;
    task.meta.verify = verify;
    task.meta.sharpen = SharpenState::Done;
    task.meta.resume = false;
    task.meta.resume_note = None;
    task.meta.resume_kind = None;
    task.meta.retry_at = None;
    set_status(task, Status::Ready, None)
}

pub fn read_artifact(task: &Task, name: &str) -> io::Result<Option<String>> {
    let path = Path::new(&task.dir).join(name);
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(fs::read_to_string(path)?.trim().to_string()))
}

pub fn read_plan(task: &Task) -> io::Result<Option<String>> {
    read_artifact(task, "plan.md")
}

pub fn write_artifact(task: &Task, name: &str, content: &str) -> io::Result<()> {
    fs::write(Path::new(&task.dir).join(name), content)
}

pub fn read_live_meter(task: &Task) -> io::Result<Option<LiveMeter>> {
    let path = Path::new(&task.dir).join("meter.json");
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&text).ok())
}

pub fn write_live_meter(task: &Task, meter: &LiveMeter) -> io::Result<()> {
    let final_path = Path::new(&task.dir).join("meter.json");
    let tmp_path = Path::new(&task.dir).join(format!(
        ".meter.{}.{}.tmp",
        std::process::id(),
        ::time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    let json = serde_json::to_string_pretty(meter).map_err(io::Error::other)?;
    fs::write(&tmp_path, format!("{json}\n"))?;
    fs::rename(tmp_path, final_path)
}

pub fn read_failures(task: &Task) -> io::Result<Vec<Failure>> {
    let path = Path::new(&task.dir).join("failures.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut failures = Vec::new();
    for line in fs::read_to_string(path)?.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(failure) = serde_json::from_str::<Failure>(line) {
            failures.push(failure);
        }
    }
    Ok(failures)
}

pub fn append_failure(task: &Task, failure: &Failure) -> io::Result<()> {
    let path = Path::new(&task.dir).join("failures.jsonl");
    let mut existing = if path.exists() {
        fs::read_to_string(&path)?
    } else {
        String::new()
    };
    existing.push_str(&serde_json::to_string(failure).map_err(io::Error::other)?);
    existing.push('\n');
    fs::write(path, existing)
}

pub fn read_answers(task: &Task) -> io::Result<Option<String>> {
    read_artifact(task, "answers.md")
}

pub fn append_answer(task: &Task, text: &str) -> io::Result<()> {
    let existing = read_answers(task)?.unwrap_or_default();
    let entry = format!("## Answer ({})\n{}\n", now_iso(), text.trim());
    fs::write(
        Path::new(&task.dir).join("answers.md"),
        if existing.is_empty() {
            entry
        } else {
            format!("{existing}\n\n{entry}")
        },
    )
}

pub fn pending_feedback_count(task: &Task) -> u32 {
    task.meta
        .feedback_count
        .saturating_sub(task.meta.feedback_consumed)
}

pub fn read_feedback(task: &Task) -> io::Result<Option<String>> {
    read_artifact(task, "human-feedback.md")
}

fn feedback_entries(text: &str) -> Vec<String> {
    let marker = Regex::new(r"(?m)^## Feedback \([^)]+\)\n").expect("feedback regex compiles");
    let starts: Vec<usize> = marker.find_iter(text).map(|found| found.start()).collect();
    starts
        .iter()
        .enumerate()
        .map(|(idx, start)| {
            text[*start..starts.get(idx + 1).copied().unwrap_or(text.len())]
                .trim()
                .to_string()
        })
        .filter(|entry| !entry.is_empty())
        .collect()
}

pub fn read_pending_feedback(task: &Task) -> io::Result<Option<String>> {
    let Some(text) = read_feedback(task)? else {
        return Ok(None);
    };
    let entries: Vec<String> = feedback_entries(&text)
        .into_iter()
        .skip(task.meta.feedback_consumed as usize)
        .collect();
    if entries.is_empty() {
        Ok(None)
    } else {
        Ok(Some(entries.join("\n\n")))
    }
}

pub fn append_feedback(task: &mut Task, text: &str) -> io::Result<()> {
    let existing = read_feedback(task)?.unwrap_or_default();
    let entry = format!("## Feedback ({})\n\n{}\n", now_iso(), text.trim());
    fs::write(
        Path::new(&task.dir).join("human-feedback.md"),
        if existing.is_empty() {
            entry
        } else {
            format!("{existing}\n\n{entry}")
        },
    )?;
    task.meta.feedback_count += 1;
    task.meta.updated_at = Some(now_iso());
    write_meta(task)
}

pub fn mark_feedback_consumed(task: &mut Task, count: u32) {
    task.meta.feedback_consumed = task.meta.feedback_consumed.max(count);
}

pub fn refresh_feedback_state(task: &mut Task) -> io::Result<()> {
    let path = Path::new(&task.dir).join("meta.json");
    if !path.exists() {
        return Ok(());
    }
    let latest: Meta =
        serde_json::from_str(&fs::read_to_string(path)?).map_err(io::Error::other)?;
    task.meta.feedback_count = task.meta.feedback_count.max(latest.feedback_count);
    task.meta.feedback_consumed = task.meta.feedback_consumed.max(latest.feedback_consumed);
    Ok(())
}

fn write_meta(task: &Task) -> io::Result<()> {
    write_meta_path(Path::new(&task.dir), &task.meta)
}

fn write_meta_path(dir: &Path, meta: &Meta) -> io::Result<()> {
    let final_path = dir.join("meta.json");
    let tmp_path = dir.join(format!(
        ".meta.{}.{}.tmp",
        std::process::id(),
        ::time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    let json = serde_json::to_string_pretty(meta).map_err(io::Error::other)?;
    fs::write(&tmp_path, format!("{json}\n"))?;
    fs::rename(tmp_path, final_path)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use crate::config::{Agent, AgentCli, Config, RoleAgents, WorkContext};

    use super::*;

    fn work_context() -> (TempDir, WorkContext) {
        let root = TempDir::new().unwrap();
        let state_dir = root.path().join("state").to_string_lossy().to_string();
        let ctx = WorkContext {
            root: root.path().to_string_lossy().to_string(),
            config: Config::default(),
            state_dir: state_dir.clone(),
            tasks_dir: format!("{state_dir}/tasks"),
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
            repo_state_dir: state_dir.clone(),
            metrics_path: format!("{state_dir}/metrics.db"),
        };
        (root, ctx)
    }

    #[test]
    fn ready_tasks_take_priority_over_due_retries() {
        let (_root, ctx) = work_context();
        let mut retry = add_task(&ctx, "Retry later", None, AddTaskOptions::default()).unwrap();
        retry.meta.status = Status::Retrying;
        retry.meta.retry_at = Some("1970-01-01T00:00:01Z".to_string());
        save_meta(&retry).unwrap();
        let ready = add_task(&ctx, "Ready now", None, AddTaskOptions::default()).unwrap();

        let next = next_runnable(&ctx, 2_000).unwrap().unwrap();
        assert_eq!(next.id, ready.id);
        assert_eq!(next.meta.status, Status::Ready);
    }

    #[test]
    fn stranded_planning_restarts_instead_of_resuming() {
        let (_root, ctx) = work_context();
        let task = add_task(
            &ctx,
            "Plan from scratch",
            None,
            AddTaskOptions {
                status: Some(Status::Planning),
                ..AddTaskOptions::default()
            },
        )
        .unwrap();

        let next = next_runnable(&ctx, 2_000).unwrap().unwrap();
        assert_eq!(next.id, task.id);
        assert_eq!(next.meta.status, Status::Ready);
        assert!(!next.meta.resume);
        assert_eq!(next.meta.resume_kind, None);
        assert!(next
            .meta
            .note
            .unwrap()
            .contains("recovered after interrupted planning stage"));
    }

    #[test]
    fn stranded_later_stage_tasks_resume_from_artifacts() {
        let (_root, ctx) = work_context();
        let task = add_task(
            &ctx,
            "Resume review",
            None,
            AddTaskOptions {
                status: Some(Status::Reviewing),
                ..AddTaskOptions::default()
            },
        )
        .unwrap();

        let next = next_runnable(&ctx, 2_000).unwrap().unwrap();
        assert_eq!(next.id, task.id);
        assert_eq!(next.meta.status, Status::Ready);
        assert!(next.meta.resume);
        assert_eq!(next.meta.resume_kind, Some(ResumeKind::Stranded));
        assert!(next
            .meta
            .resume_note
            .unwrap()
            .contains("interrupted reviewing stage"));
    }

    #[test]
    fn due_retries_resume_as_auto_retry() {
        let (_root, ctx) = work_context();
        let mut task = add_task(&ctx, "Retry now", None, AddTaskOptions::default()).unwrap();
        task.meta.status = Status::Retrying;
        task.meta.retry_at = Some("1970-01-01T00:00:01Z".to_string());
        save_meta(&task).unwrap();

        let next = next_runnable(&ctx, 2_000).unwrap().unwrap();
        assert_eq!(next.id, task.id);
        assert_eq!(next.meta.status, Status::Ready);
        assert!(next.meta.resume);
        assert_eq!(next.meta.resume_kind, Some(ResumeKind::AutoRetry));
        assert_eq!(next.meta.retry_at, None);
    }

    #[test]
    fn legacy_metadata_receives_defaults() {
        let (_root, ctx) = work_context();
        let dir = Path::new(&ctx.tasks_dir).join("legacy");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("meta.json"),
            r#"{
  "id": "legacy",
  "slug": "legacy",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
"#,
        )
        .unwrap();

        let task = load_tasks(&ctx).unwrap().pop().unwrap();
        assert_eq!(task.meta.status, Status::Ready);
        assert_eq!(task.meta.verify, None);
        assert_eq!(task.meta.sharpen, SharpenState::Done);
        assert!(!task.meta.resume);
        assert_eq!(task.meta.resume_kind, None);
        assert_eq!(task.meta.auto_retries, 0);
        assert_eq!(task.meta.complexity, None);
        assert_eq!(task.meta.feedback_count, 0);
        assert_eq!(task.meta.feedback_consumed, 0);
        assert_eq!(task.meta.feedback_source_task_id, None);
    }

    #[test]
    fn parallel_like_adds_claim_distinct_ids() {
        let (_root, ctx) = work_context();
        let a = add_task(&ctx, "Same task", None, AddTaskOptions::default()).unwrap();
        let b = add_task(&ctx, "Same task", None, AddTaskOptions::default()).unwrap();
        let c = add_task(&ctx, "Same task", None, AddTaskOptions::default()).unwrap();
        let mut ids = vec![a.id, b.id, c.id];
        ids.sort();
        assert_eq!(ids, vec!["same-task", "same-task-2", "same-task-3"]);
    }

    #[test]
    fn artifact_read_trims_and_missing_returns_none() {
        let (_root, ctx) = work_context();
        let task = add_task(&ctx, "Read artifact", None, AddTaskOptions::default()).unwrap();
        assert_eq!(read_artifact(&task, "feedback.md").unwrap(), None);
        write_artifact(&task, "feedback.md", "\n\n## Summary\nDone.\n\n").unwrap();
        assert_eq!(
            read_artifact(&task, "feedback.md").unwrap(),
            Some("## Summary\nDone.".to_string())
        );
    }

    #[test]
    fn live_meter_round_trips_as_json_artifact() {
        let (_root, ctx) = work_context();
        let task = add_task(&ctx, "Track meter", None, AddTaskOptions::default()).unwrap();
        assert_eq!(read_live_meter(&task).unwrap(), None);

        let meter = LiveMeter {
            started_at: "2026-01-01T00:00:00Z".to_string(),
            input_tokens: 1200,
            output_tokens: 34,
            stages: vec![LiveMeterStage {
                stage: "plan".to_string(),
                agent: "codex".to_string(),
                in_tok: 1000,
                out_tok: 20,
                ms: 55,
            }],
        };
        write_live_meter(&task, &meter).unwrap();

        assert_eq!(read_live_meter(&task).unwrap(), Some(meter));
    }

    #[test]
    fn pending_feedback_drops_after_consumption() {
        let (_root, ctx) = work_context();
        let mut task = add_task(&ctx, "Improve layout", None, AddTaskOptions::default()).unwrap();
        append_feedback(&mut task, "First note.").unwrap();
        append_feedback(&mut task, "Second note.").unwrap();
        mark_feedback_consumed(&mut task, 1);

        assert_eq!(pending_feedback_count(&task), 1);
        let pending = read_pending_feedback(&task).unwrap().unwrap();
        assert!(pending.contains("Second note."));
        assert!(!pending.contains("First note."));
    }
}
