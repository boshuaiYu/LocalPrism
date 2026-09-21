use std::path::{Path, PathBuf};

/// Folders that must not be exposed to Claude Code as auto-invoked skills.
///
/// PaperSpine's SKILL.md is a host orchestrator (`launch --no-open`, `host wait`,
/// `paperspine_open_task`). Overlaying a project leftover into
/// `CLAUDE_CONFIG_DIR/skills` makes Claude Code inject that protocol on
/// `/paper-spine` or via the Skill tool, which frequently kills the `-p` CLI
/// process. LocalPrism keeps the files in `claude-home/skills` and sends a
/// bounded writing prompt instead.
pub fn is_host_bound_skill_folder(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    let stem = lower
        .strip_suffix(".md")
        .or_else(|| lower.strip_suffix(".markdown"))
        .unwrap_or(&lower);
    stem.contains("paper-spine") || stem.contains("paperspine")
}

/// Rewrite `/paper-spine` (including after a LocalPrism file-context prefix)
/// into a LocalPrism-safe prompt that does not trigger Claude Code's Skill tool.
pub fn adapt_host_bound_skill_prompt(prompt: &str) -> String {
    let intent = user_intent_from_prompt(prompt);
    let Some((command, args)) = parse_slash_command(intent) else {
        return prompt.to_string();
    };
    if !is_host_bound_skill_folder(&command) {
        return prompt.to_string();
    }
    replace_user_intent(prompt, intent, &paperspine_localprism_prompt(&args))
}

pub fn paperspine_skill_dir() -> Option<PathBuf> {
    let root = crate::providers::paths::user_skills_dir().ok()?;
    first_paperspine_dir(&root)
}

fn first_paperspine_dir(root: &Path) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    let preferred = root.join("paper-spine");
    if preferred.join("SKILL.md").is_file() {
        return Some(preferred);
    }
    let mut matches = Vec::new();
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if is_host_bound_skill_folder(&name) && path.join("SKILL.md").is_file() {
            matches.push(path);
        }
    }
    matches.sort();
    matches.into_iter().next()
}

fn user_intent_from_prompt(prompt: &str) -> &str {
    if prompt.starts_with("[Currently open file:") {
        if let Some(idx) = prompt.rfind("\n\n") {
            return &prompt[idx + 2..];
        }
    }
    prompt
}

fn parse_slash_command(text: &str) -> Option<(String, String)> {
    let trimmed = text.trim();
    let rest = trimmed.strip_prefix('/')?;
    let mut parts = rest.splitn(2, |ch: char| ch.is_whitespace());
    let command = parts.next()?.trim();
    if command.is_empty() {
        return None;
    }
    let args = parts.next().unwrap_or("").trim().to_string();
    Some((command.to_string(), args))
}

fn replace_user_intent(prompt: &str, intent: &str, replacement: &str) -> String {
    if prompt == intent {
        return replacement.to_string();
    }
    if let Some(prefix) = prompt.strip_suffix(intent) {
        return format!("{prefix}{replacement}");
    }
    replacement.to_string()
}

fn paperspine_localprism_prompt(user_notes: &str) -> String {
    let trimmed = user_notes.trim();
    let skill_hint = match paperspine_skill_dir() {
        Some(dir) => format!(
            "Playbooks live at {}. Read only the one file needed for this goal.",
            dir.display()
        ),
        None => "Playbooks live in the LocalPrism `claude-home/skills/paper-spine`. Read only the one file needed for this goal.".to_string(),
    };
    let guard = "You are inside LocalPrism, a local academic writing app. The user invoked PaperSpine.\n\
         \n\
         LocalPrism is not the PaperSpine web host. Do not invoke the Skill tool for paper-spine. \
         Do not run launch --no-open, launch_paperspine_ui, intake_wizard, host tools, host wait, \
         or paperspine_open_task. Do not start a web server or wait for a browser form. \
         Do not read every PaperSpine reference file up front.\n\
         \n";
    if trimmed.is_empty() {
        return format!(
            "{guard}\
             Work in the current project folder. Reply in the user's language. {skill_hint} \
             Ask what they want to do with the current paper (intake, outline, write, cite, figures, review, LaTeX, or revise).\n"
        );
    }
    format!(
        "{guard}\
         Work in the current project folder. Reply in the user's language. \
         The user already stated the goal. Do not confirm it and do not interview them about those notes. \
         Start the work now. {skill_hint} \
         Use LocalPrism editor files with small Edit/Write steps. Ask only if a required file or fact is missing.\n\
         \n\
         User request:\n{trimmed}\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_paperspine_folders() {
        assert!(is_host_bound_skill_folder("paper-spine"));
        assert!(is_host_bound_skill_folder("PaperSpine"));
        assert!(is_host_bound_skill_folder("paper-spine-intake"));
        assert!(!is_host_bound_skill_folder("scanpy"));
        assert!(!is_host_bound_skill_folder("writer"));
    }

    #[test]
    fn leaves_ordinary_prompts_unchanged() {
        assert_eq!(
            adapt_host_bound_skill_prompt("Please revise the abstract"),
            "Please revise the abstract"
        );
        assert_eq!(
            adapt_host_bound_skill_prompt("/scanpy plot this"),
            "/scanpy plot this"
        );
    }

    #[test]
    fn rewrites_paperspine_slash_and_keeps_file_context() {
        let rewritten = adapt_host_bound_skill_prompt("/paper-spine outline the results");
        assert!(
            !rewritten
                .lines()
                .any(|line| line.trim().starts_with("/paper-spine")),
            "{rewritten}"
        );
        assert!(rewritten.contains("not the PaperSpine web host"));
        assert!(rewritten.contains("Do not invoke the Skill tool"));
        assert!(rewritten.contains("outline the results"));
        assert!(
            !rewritten.contains("Confirm the user's goal first"),
            "{rewritten}"
        );
        assert!(
            rewritten.contains("Do not confirm it"),
            "{rewritten}"
        );
        assert!(rewritten.len() < 2_500, "adapter itself must stay small");

        let with_context = adapt_host_bound_skill_prompt(
            "[Currently open file: main.tex]\n\n/paper-spine write the intro",
        );
        assert!(with_context.starts_with("[Currently open file: main.tex]"));
        assert!(with_context.contains("write the intro"));
        assert!(!with_context
            .lines()
            .any(|line| line.trim().starts_with("/paper-spine")));
    }

    #[test]
    fn empty_paperspine_slash_may_ask_what_to_do() {
        let rewritten = adapt_host_bound_skill_prompt("/paper-spine");
        assert!(rewritten.contains("Ask what they want to do"));
        assert!(!rewritten.contains("User request:"));
    }
}
