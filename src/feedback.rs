use std::path::{Path, PathBuf};

use crate::task::{is_stranded, pending_feedback_count, Status, Task};

const TERMINAL_FEEDBACK_MAX_LINES: usize = 40;
const TERMINAL_FEEDBACK_MAX_CHARS: usize = 6000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedbackRouteInput {
    pub status: Status,
    pub has_plan: bool,
    pub has_worktree_diff: bool,
    pub has_commit: bool,
    pub pending_feedback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedbackRoute {
    Resume,
    FollowUp,
    Reject { message: String },
}

pub fn render_terminal_feedback(feedback: &str, task_id: &str) -> Vec<String> {
    let mut text = feedback.trim().to_string();
    if text.is_empty() {
        return Vec::new();
    }

    let mut clipped = false;
    if text.len() > TERMINAL_FEEDBACK_MAX_CHARS {
        text = text
            .chars()
            .take(TERMINAL_FEEDBACK_MAX_CHARS)
            .collect::<String>()
            .trim_end()
            .to_string();
        clipped = true;
    }

    let mut lines: Vec<String> = text.lines().map(ToOwned::to_owned).collect();
    if lines.len() > TERMINAL_FEEDBACK_MAX_LINES {
        lines.truncate(TERMINAL_FEEDBACK_MAX_LINES);
        clipped = true;
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    if clipped {
        lines.push(format!(
            "[handoff clipped; run factory show {task_id} for the full artifact]"
        ));
    }
    lines.extend(["".to_string(), format!("detail: factory show {task_id}")]);
    lines
}

pub fn decide_feedback_route(input: &FeedbackRouteInput) -> FeedbackRoute {
    if input.status == Status::NeedsInput {
        return FeedbackRoute::Reject {
            message: "task is waiting for answers; use factory answer".to_string(),
        };
    }
    if input.status == Status::Done || input.has_commit {
        return FeedbackRoute::FollowUp;
    }
    let has_progress = input.has_plan || input.has_worktree_diff || input.pending_feedback;
    if input.status == Status::Ready {
        return if has_progress {
            FeedbackRoute::Resume
        } else {
            FeedbackRoute::Reject {
                message: "task has no progress to give feedback on; use factory add for new work"
                    .to_string(),
            }
        };
    }
    if input.status == Status::Blocked || input.status == Status::Retrying {
        return if has_progress {
            FeedbackRoute::Resume
        } else {
            FeedbackRoute::Reject {
                message: "task has no resumable progress to give feedback on".to_string(),
            }
        };
    }
    if input.status == Status::Sharpening || input.status == Status::Planning {
        return FeedbackRoute::Reject {
            message: format!(
                "task is still {}; wait for progress or use factory add for new work",
                input.status.as_str()
            ),
        };
    }
    if is_stranded(input.status) {
        return FeedbackRoute::Reject {
            message: format!(
                "task was interrupted during {}; use factory resume first",
                input.status.as_str()
            ),
        };
    }
    FeedbackRoute::Reject {
        message: format!(
            "task status {} cannot receive feedback yet",
            input.status.as_str()
        ),
    }
}

pub fn is_default_feedback_target(input: &FeedbackRouteInput) -> bool {
    !matches!(decide_feedback_route(input), FeedbackRoute::Reject { .. })
}

pub fn latest_feedback_target(
    tasks: &[Task],
    facts: impl Fn(&Task) -> FeedbackRouteInput,
) -> Option<Task> {
    tasks
        .iter()
        .filter(|task| is_default_feedback_target(&facts(task)))
        .max_by(|a, b| {
            let a_stamp = a.meta.updated_at.as_ref().unwrap_or(&a.meta.created_at);
            let b_stamp = b.meta.updated_at.as_ref().unwrap_or(&b.meta.created_at);
            a_stamp.cmp(b_stamp)
        })
        .cloned()
}

pub fn feedback_route_input(
    task: &Task,
    has_plan: bool,
    has_worktree_diff: bool,
) -> FeedbackRouteInput {
    FeedbackRouteInput {
        status: task.meta.status,
        has_plan,
        has_worktree_diff,
        has_commit: task.meta.commit.is_some(),
        pending_feedback: pending_feedback_count(task) > 0,
    }
}

pub fn follow_up_intent(source: &Task, feedback: &str) -> String {
    [
        format!("Address feedback on {}", source.id),
        String::new(),
        "## Source task".to_string(),
        format!("- id: {}", source.id),
        format!(
            "- commit: {}",
            source.meta.commit.as_deref().unwrap_or("(none)")
        ),
        format!("- task dir: {}", absolute_path(&source.dir)),
        format!("- inspect: factory show {}", source.id),
        format!(
            "- verify: {}",
            source.meta.verify.as_deref().unwrap_or("(none)")
        ),
        String::new(),
        "## Human feedback".to_string(),
        feedback.trim().to_string(),
    ]
    .join("\n")
}

fn absolute_path(path: impl AsRef<Path>) -> String {
    path.as_ref()
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path.as_ref()))
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use crate::task::{Meta, ResumeKind, SharpenState};

    use super::*;

    fn route(input: FeedbackRouteInput) -> FeedbackRoute {
        decide_feedback_route(&input)
    }

    fn base(status: Status) -> FeedbackRouteInput {
        FeedbackRouteInput {
            status,
            has_plan: false,
            has_worktree_diff: false,
            has_commit: false,
            pending_feedback: false,
        }
    }

    fn task(id: &str, status: Status, updated_at: &str) -> Task {
        Task {
            id: id.to_string(),
            dir: format!("/tmp/{id}"),
            meta: Meta {
                id: id.to_string(),
                slug: id.to_string(),
                status,
                verify: None,
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                updated_at: Some(updated_at.to_string()),
                commit: None,
                note: None,
                sharpen: SharpenState::Done,
                resume: false,
                resume_note: None,
                resume_kind: None::<ResumeKind>,
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
    fn render_terminal_feedback_preserves_handoff_and_pointer() {
        assert_eq!(
            render_terminal_feedback("done\n", "task-1"),
            vec!["done", "", "detail: factory show task-1"]
        );
    }

    #[test]
    fn done_routes_to_follow_up() {
        assert_eq!(route(base(Status::Done)), FeedbackRoute::FollowUp);
    }

    #[test]
    fn committed_task_routes_to_follow_up() {
        assert_eq!(
            route(FeedbackRouteInput {
                has_commit: true,
                ..base(Status::Ready)
            }),
            FeedbackRoute::FollowUp
        );
    }

    #[test]
    fn needs_input_rejects_with_answer_guidance() {
        assert_eq!(
            route(base(Status::NeedsInput)),
            FeedbackRoute::Reject {
                message: "task is waiting for answers; use factory answer".to_string()
            }
        );
    }

    #[test]
    fn fresh_ready_rejects_with_add_guidance() {
        assert_eq!(
            route(base(Status::Ready)),
            FeedbackRoute::Reject {
                message: "task has no progress to give feedback on; use factory add for new work"
                    .to_string()
            }
        );
    }

    #[test]
    fn ready_with_diff_routes_to_resume() {
        assert_eq!(
            route(FeedbackRouteInput {
                has_worktree_diff: true,
                ..base(Status::Ready)
            }),
            FeedbackRoute::Resume
        );
    }

    #[test]
    fn blocked_with_plan_routes_to_resume() {
        assert_eq!(
            route(FeedbackRouteInput {
                has_plan: true,
                ..base(Status::Blocked)
            }),
            FeedbackRoute::Resume
        );
    }

    #[test]
    fn retrying_with_diff_routes_to_resume() {
        assert_eq!(
            route(FeedbackRouteInput {
                has_worktree_diff: true,
                ..base(Status::Retrying)
            }),
            FeedbackRoute::Resume
        );
    }

    #[test]
    fn default_target_excludes_fresh_needs_input_and_live_pre_plan() {
        assert!(!is_default_feedback_target(&base(Status::Ready)));
        assert!(!is_default_feedback_target(&base(Status::NeedsInput)));
        assert!(!is_default_feedback_target(&base(Status::Planning)));
        assert!(is_default_feedback_target(&base(Status::Done)));
    }

    #[test]
    fn latest_feedback_target_uses_filtered_eligible_set() {
        let tasks = vec![
            task("fresh", Status::Ready, "2026-01-03T00:00:00.000Z"),
            task("done-old", Status::Done, "2026-01-01T00:00:00.000Z"),
            task("done-new", Status::Done, "2026-01-02T00:00:00.000Z"),
        ];
        let target = latest_feedback_target(&tasks, |task| base(task.meta.status)).unwrap();
        assert_eq!(target.id, "done-new");
    }

    #[test]
    fn follow_up_intent_includes_source_details_and_feedback() {
        let mut source = task("source-task", Status::Done, "2026-01-02T00:00:00.000Z");
        source.meta.commit = Some("abc1234".to_string());
        source.meta.verify = Some("cargo test".to_string());
        let intent = follow_up_intent(&source, "Fix the label.");
        assert!(intent.contains("Address feedback on source-task"));
        assert!(intent.contains("- commit: abc1234"));
        assert!(intent.contains("- verify: cargo test"));
        assert!(intent.contains("Fix the label."));
    }
}
