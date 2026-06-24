use std::fs;
use std::io;
use std::path::Path;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::clock::now_iso;
use crate::config::RepoContext;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BacklogEntry {
    pub id: String,
    pub intent: String,
    #[serde(default)]
    pub verify: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoveBacklogResult {
    Removed(BacklogEntry),
    Ambiguous(Vec<BacklogEntry>),
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

fn entry_files(dir: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.ends_with(".json"))
        .collect();
    files.sort();
    files
}

pub fn add_backlog(
    ctx: &RepoContext,
    intent: &str,
    verify: Option<String>,
) -> io::Result<BacklogEntry> {
    fs::create_dir_all(&ctx.backlog_dir)?;
    let slug = slugify(intent.trim().lines().next().unwrap_or_default());
    let files = entry_files(&ctx.backlog_dir);
    let mut id = slug.clone();
    for n in 2.. {
        if !files.contains(&format!("{id}.json")) {
            break;
        }
        id = format!("{slug}-{n}");
    }
    let entry = BacklogEntry {
        id: id.clone(),
        intent: intent.trim().to_string(),
        verify,
        created_at: now_iso(),
    };
    let json = serde_json::to_string_pretty(&entry).map_err(io::Error::other)?;
    fs::write(
        Path::new(&ctx.backlog_dir).join(format!("{id}.json")),
        format!("{json}\n"),
    )?;
    Ok(entry)
}

pub fn load_backlog(ctx: &RepoContext) -> io::Result<Vec<BacklogEntry>> {
    let mut entries = Vec::new();
    for file in entry_files(&ctx.backlog_dir) {
        let path = Path::new(&ctx.backlog_dir).join(file);
        let text = fs::read_to_string(path)?;
        if let Ok(entry) = serde_json::from_str::<BacklogEntry>(&text) {
            entries.push(entry);
        }
    }
    entries.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(entries)
}

pub fn remove_backlog(ctx: &RepoContext, query: &str) -> io::Result<Option<RemoveBacklogResult>> {
    let entries = load_backlog(ctx)?;
    let exact = entries.iter().find(|entry| entry.id == query).cloned();
    let matches: Vec<BacklogEntry> = exact.map(|entry| vec![entry]).unwrap_or_else(|| {
        entries
            .into_iter()
            .filter(|entry| entry.id.contains(query))
            .collect()
    });
    let Some(entry) = matches.first() else {
        return Ok(None);
    };
    if matches.len() > 1 {
        return Ok(Some(RemoveBacklogResult::Ambiguous(matches)));
    }
    fs::remove_file(Path::new(&ctx.backlog_dir).join(format!("{}.json", entry.id))).ok();
    Ok(Some(RemoveBacklogResult::Removed(entry.clone())))
}
