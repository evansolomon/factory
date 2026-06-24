use std::collections::HashSet;
use std::io::{self, Write};
use std::thread;
use std::time::Duration;

use crate::config::WorkContext;
use crate::editor::compose_in_editor;
use crate::sharpen::{
    parse_formatted_questions, render_agent_markdown, style_sharpen_markdown_line, Question, BOLD,
    RESET,
};
use crate::task::{append_answer, load_tasks, read_artifact, set_status, Status, Task};

const POLL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Answer {
    Defer,
    Text(String),
}

pub fn start_prompt_worker(ctx: WorkContext) {
    thread::spawn(move || {
        let mut deferred = HashSet::new();
        loop {
            let task = match next_needs_input(&ctx, &deferred) {
                Ok(Some(task)) => task,
                Ok(None) => {
                    thread::sleep(POLL);
                    continue;
                }
                Err(err) => {
                    eprintln!("prompt worker: {err}");
                    thread::sleep(POLL);
                    continue;
                }
            };
            if let Err(err) = prompt_task(task, &mut deferred) {
                eprintln!("prompt worker: {err}");
            }
        }
    });
}

fn next_needs_input(ctx: &WorkContext, deferred: &HashSet<String>) -> io::Result<Option<Task>> {
    Ok(load_tasks(ctx)?
        .into_iter()
        .find(|task| task.meta.status == Status::NeedsInput && !deferred.contains(&task.id)))
}

fn prompt_task(task: Task, deferred: &mut HashSet<String>) -> io::Result<()> {
    let questions_text = read_artifact(&task, "questions.md")?.unwrap_or_default();
    let parsed = if questions_text.trim().is_empty() {
        None
    } else {
        Some(parse_formatted_questions(&questions_text))
    };

    println!();
    eprintln!("{} needs input:", task.id);
    if let Some(parsed) = &parsed {
        if !parsed.questions.is_empty() {
            if !parsed.preamble.is_empty() {
                println!("{}", render_agent_markdown(&parsed.preamble));
            }
            eprintln!(
                "  Enter accepts a recommendation · /skip a question · /edit for a long reply"
            );
            eprintln!("  /defer to answer later with `factory answer`");
        } else if !questions_text.trim().is_empty() {
            println!("{}", questions_text.trim());
            eprintln!(
                "  type your answer · /edit for a long reply · /skip to defer to `factory answer`"
            );
        } else {
            eprintln!(
                "  type your answer · /edit for a long reply · /skip to defer to `factory answer`"
            );
        }
    } else {
        eprintln!(
            "  type your answer · /edit for a long reply · /skip to defer to `factory answer`"
        );
    }

    let reply = if let Some(parsed) = parsed {
        if parsed.questions.is_empty() {
            read_answer(
                &format!("answer {}> ", task.id),
                prompt_line,
                compose_in_editor,
            )?
        } else {
            read_question_answers(&task.id, &parsed.questions, prompt_line, compose_in_editor)?
        }
    } else {
        read_answer(
            &format!("answer {}> ", task.id),
            prompt_line,
            compose_in_editor,
        )?
    };

    match reply {
        Answer::Defer => {
            deferred.insert(task.id.clone());
            eprintln!(
                "  deferred - answer later with: factory answer {} \"...\"",
                task.id
            );
        }
        Answer::Text(text) => {
            append_answer(&task, &text)?;
            let mut task = task;
            set_status(&mut task, Status::Ready, None)?;
            eprintln!("{}: answered, back in queue", task.id);
        }
    }
    Ok(())
}

fn prompt_line(label: &str) -> io::Result<String> {
    print!("{label}");
    io::stdout().flush()?;
    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    Ok(input.trim().to_string())
}

fn read_answer(
    label: &str,
    mut read_line: impl FnMut(&str) -> io::Result<String>,
    mut edit: impl FnMut(&str) -> io::Result<String>,
) -> io::Result<Answer> {
    loop {
        let input = read_line(label)?.trim().to_string();
        if input == "/skip" || input == "/defer" {
            return Ok(Answer::Defer);
        }
        if input == "/edit" {
            let edited = edit("")?;
            if edited.trim().is_empty() {
                eprintln!("  (nothing entered)");
                continue;
            }
            return Ok(Answer::Text(edited.trim().to_string()));
        }
        if input.is_empty() {
            continue;
        }
        return Ok(Answer::Text(input));
    }
}

fn read_question_answers(
    task_id: &str,
    questions: &[Question],
    mut read_line: impl FnMut(&str) -> io::Result<String>,
    mut edit: impl FnMut(&str) -> io::Result<String>,
) -> io::Result<Answer> {
    let mut answered = Vec::new();
    for (index, question) in questions.iter().enumerate() {
        println!(
            "\n{BOLD}({}/{}){RESET} {}",
            index + 1,
            questions.len(),
            style_sharpen_markdown_line(&question.q)
        );
        if !question.rec.is_empty() {
            eprintln!("  recommend: {}", question.rec);
        }
        let label = format!("answer {task_id} ({}/{})> ", index + 1, questions.len());
        let reply = read_question_answer(&label, &question.rec, &mut read_line, &mut edit)?;
        match reply {
            Answer::Defer => return Ok(Answer::Defer),
            Answer::Text(text) => answered.push(format!("Q: {}\nA: {}", question.q, text)),
        }
    }
    Ok(Answer::Text(answered.join("\n\n")))
}

fn read_question_answer(
    label: &str,
    recommendation: &str,
    read_line: &mut impl FnMut(&str) -> io::Result<String>,
    edit: &mut impl FnMut(&str) -> io::Result<String>,
) -> io::Result<Answer> {
    loop {
        let input = read_line(label)?.trim().to_string();
        if input == "/defer" {
            return Ok(Answer::Defer);
        }
        if input == "/skip" {
            return Ok(Answer::Text("(skipped)".to_string()));
        }
        if input == "/edit" {
            let edited = edit("")?;
            if edited.trim().is_empty() {
                eprintln!("  (nothing entered)");
                continue;
            }
            return Ok(Answer::Text(edited.trim().to_string()));
        }
        return Ok(Answer::Text(if input.is_empty() {
            if recommendation.is_empty() {
                "(no preference)".to_string()
            } else {
                recommendation.to_string()
            }
        } else {
            input
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_reader(inputs: Vec<&str>) -> impl FnMut(&str) -> io::Result<String> {
        let mut inputs = inputs
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
            .into_iter();
        move |_| Ok(inputs.next().unwrap_or_default().to_string())
    }

    #[test]
    fn plain_answer_skips_empty_lines_and_accepts_text() {
        let answer = read_answer("answer> ", line_reader(vec!["", "Use sqlite"]), |_| {
            Ok(String::new())
        })
        .unwrap();
        assert_eq!(answer, Answer::Text("Use sqlite".to_string()));
    }

    #[test]
    fn plain_answer_can_defer() {
        let answer = read_answer(
            "answer> ",
            line_reader(vec!["/skip"]),
            |_| Ok(String::new()),
        )
        .unwrap();
        assert_eq!(answer, Answer::Defer);
    }

    #[test]
    fn formatted_questions_accept_defaults_skip_and_defer() {
        let questions = vec![
            Question {
                q: "Which DB?".to_string(),
                rec: "sqlite".to_string(),
            },
            Question {
                q: "Which cache?".to_string(),
                rec: String::new(),
            },
        ];
        let answer =
            read_question_answers("task", &questions, line_reader(vec!["", "/skip"]), |_| {
                Ok(String::new())
            })
            .unwrap();
        assert_eq!(
            answer,
            Answer::Text("Q: Which DB?\nA: sqlite\n\nQ: Which cache?\nA: (skipped)".to_string())
        );

        let deferred =
            read_question_answers("task", &questions, line_reader(vec!["/defer"]), |_| {
                Ok(String::new())
            })
            .unwrap();
        assert_eq!(deferred, Answer::Defer);
    }
}
