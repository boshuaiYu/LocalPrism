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

/// User text after a LocalPrism file-context prefix.
///
/// The host writes `[Currently open file: …]`, then optional `[Selection: …]`
/// and `[Selected text: … ]`, then a blank line and the user prompt. Citations
/// in that prompt (`[1]` followed by a blank line) must stay in the user text.
/// Compression carryover may precede the prefix; the current prefix is the last
/// host file marker.
pub(crate) fn user_intent_from_prompt(prompt: &str) -> &str {
    let Some(marker_at) = prompt
        .rfind("[Currently open file:")
        .or_else(|| prompt.rfind("[File:"))
    else {
        return prompt;
    };
    let after = &prompt[marker_at..];
    let Some(mut rest) = consume_bracket_line(after, "[Currently open file:")
        .or_else(|| consume_bracket_line(after, "[File:"))
    else {
        return prompt;
    };
    if rest.starts_with("[Selection:") {
        let Some(next) = consume_bracket_line(rest, "[Selection:") else {
            return prompt;
        };
        rest = next;
    }
    if rest.starts_with("[Selected text:") {
        let Some(next) = skip_selected_text_block(rest) else {
            return prompt;
        };
        rest = next;
    }
    rest
}

fn has_line_break(text: &str) -> bool {
    text.contains('\n') || text.contains('\r')
}

/// Drop one single-line `[Prefix …]` host header and return the suffix.
fn consume_bracket_line<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = text.strip_prefix(prefix)?;
    let (end, width) = if let Some(index) = rest.find("]\r\n") {
        (index, 3)
    } else if let Some(index) = rest.find("]\n") {
        (index, 2)
    } else if rest.ends_with(']') && !has_line_break(&rest[..rest.len() - 1]) {
        return Some("");
    } else {
        return None;
    };
    if has_line_break(&rest[..end]) {
        return None;
    }
    Some(&rest[end + width..])
}

/// Drop `[Selected text:\n…\n]` and return the suffix after that closing line.
fn skip_selected_text_block(text: &str) -> Option<&str> {
    let body = text
        .strip_prefix("[Selected text:\r\n")
        .or_else(|| text.strip_prefix("[Selected text:\n"))?;
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        let content = line.trim_end_matches(['\n', '\r']);
        offset += line.len();
        if content == "]" {
            return Some(&body[offset..]);
        }
    }
    None
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
    let guard =
        "You are inside LocalPrism, a local academic writing app. The user invoked PaperSpine.\n\
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
        assert!(rewritten.contains("Do not confirm it"), "{rewritten}");
        assert!(rewritten.len() < 2_500, "adapter itself must stay small");

        let with_context = adapt_host_bound_skill_prompt(
            "[Currently open file: main.tex]\n\n/paper-spine write the intro",
        );
        assert!(with_context.starts_with("[Currently open file: main.tex]"));
        assert!(with_context.contains("write the intro"));
        assert!(!with_context
            .lines()
            .any(|line| line.trim().starts_with("/paper-spine")));

        let with_notes = adapt_host_bound_skill_prompt(
            "[Currently open file: main.tex]\n\n/paper-spine outline\n\nKeep the citations.",
        );
        assert!(with_notes.contains("outline"));
        assert!(with_notes.contains("Keep the citations."));
        assert!(!with_notes
            .lines()
            .any(|line| line.trim().starts_with("/paper-spine")));

        let with_carryover = adapt_host_bound_skill_prompt(
            "Summary:\nEarlier draft.\n\n[Currently open file: main.tex]\n\n/paper-spine revise",
        );
        assert!(with_carryover.contains("Summary:"));
        assert!(with_carryover.contains("revise"));
        assert!(!with_carryover
            .lines()
            .any(|line| line.trim().starts_with("/paper-spine")));
    }

    #[test]
    fn citation_brackets_do_not_hide_paperspine_or_paperspine_alias() {
        let prompt = "\
[Currently open file: main.tex]

/paper-spine revise the claim

See Smith [1]

Keep the citation.";
        let rewritten = adapt_host_bound_skill_prompt(prompt);
        assert!(rewritten.starts_with("[Currently open file: main.tex]"));
        assert!(rewritten.contains("See Smith [1]"));
        assert!(rewritten.contains("Keep the citation."));
        assert!(rewritten.contains("revise the claim"));
        assert!(!rewritten
            .lines()
            .any(|line| line.trim().starts_with("/paper-spine")));

        let with_selection = "\
Summary:\nEarlier draft.

[Currently open file: main.tex]
[Selection: @main.tex:1:1-1:8]
[Selected text:
claim [1]
]

/paperspine outline

Next [1]

still here";
        let rewritten = adapt_host_bound_skill_prompt(with_selection);
        assert!(rewritten.contains("Summary:"));
        assert!(rewritten.contains("[Selected text:"));
        assert!(rewritten.contains("Next [1]"));
        assert!(rewritten.contains("still here"));
        assert!(rewritten.contains("outline"));
        assert!(!rewritten
            .lines()
            .any(|line| line.trim().starts_with("/paperspine")));
        assert_eq!(
            user_intent_from_prompt(with_selection).trim(),
            "/paperspine outline\n\nNext [1]\n\nstill here"
        );
    }

    #[test]
    fn empty_paperspine_slash_may_ask_what_to_do() {
        let rewritten = adapt_host_bound_skill_prompt("/paper-spine");
        assert!(rewritten.contains("Ask what they want to do"));
        assert!(!rewritten.contains("User request:"));
    }
}
