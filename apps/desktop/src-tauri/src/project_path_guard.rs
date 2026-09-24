//! Bind agent file-tool paths to the open project.
//!
//! Claude Code's working directory is already the open paper. Models still
//! sometimes pass an absolute path under a placeholder home (`C:\Users\user\…`,
//! `/Users/user/…`, `/home/user/…`). Those absolute paths skip the working
//! directory, so Read looks in the wrong place. This module remaps that class
//! of path onto the project root and refuses other locations outside the project.

use std::path::Path;

use serde_json::{json, Value};

const DENY_MESSAGE: &str =
    "This path is outside the open project. Use a relative path such as main.tex.";

#[derive(Debug, PartialEq)]
pub enum ToolPathDecision {
    Keep(Value),
    Rewrite(Value),
    Deny(String),
}

#[derive(Debug, PartialEq)]
enum PathBind {
    Inside(String),
    Deny,
}

struct ProjectRoot {
    /// Drive prefix such as `C:` or empty for a POSIX absolute path.
    prefix: String,
    /// Original drive text, preserving letter case (`C:`).
    prefix_display: String,
    parts: Vec<String>,
    sep: char,
}

pub fn bind_tool_input(project_root: &str, tool_name: &str, input: Value) -> ToolPathDecision {
    let Some(root) = ProjectRoot::parse(project_root) else {
        return ToolPathDecision::Keep(input);
    };
    if tool_name.trim().eq_ignore_ascii_case("bash") {
        return bind_bash(&root, input);
    }

    let Value::Object(mut map) = input else {
        return ToolPathDecision::Keep(input);
    };
    let mut changed = false;
    for key in path_keys(tool_name) {
        let Some(raw) = map.get(*key).and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        if raw.trim().is_empty() {
            continue;
        }
        match bind_path(&root, &raw) {
            PathBind::Inside(next) => {
                if next != raw {
                    map.insert((*key).to_string(), Value::String(next));
                    changed = true;
                }
            }
            PathBind::Deny => {
                return ToolPathDecision::Deny(DENY_MESSAGE.to_string());
            }
        }
    }
    let value = Value::Object(map);
    if changed {
        ToolPathDecision::Rewrite(value)
    } else {
        ToolPathDecision::Keep(value)
    }
}

/// Claude Code PreToolUse hook. Empty stdout means "leave the tool input alone".
pub fn bind_project_path_hook(project_hint: Option<&str>, payload: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(payload) else {
        return String::new();
    };
    let tool_name = value.get("tool_name").and_then(Value::as_str).unwrap_or("");
    let cwd = value.get("cwd").and_then(Value::as_str).unwrap_or("");
    let hinted = project_hint.unwrap_or("").trim();
    let root = if hinted.is_empty() { cwd } else { hinted };
    if root.trim().is_empty() {
        return String::new();
    }
    let input = value
        .get("tool_input")
        .cloned()
        .unwrap_or_else(|| json!({}));
    match bind_tool_input(root, tool_name, input) {
        ToolPathDecision::Keep(_) => String::new(),
        ToolPathDecision::Rewrite(updated) => json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": updated
            }
        })
        .to_string(),
        ToolPathDecision::Deny(message) => json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": message
            }
        })
        .to_string(),
    }
}

pub fn install_path_guard_hook(config_dir: &Path, project_root: &Path) -> Result<(), String> {
    let Some(command) = path_guard_hook_command(project_root) else {
        return Ok(());
    };
    let settings_path = config_dir.join("settings.json");
    let mut settings = if settings_path.exists() {
        let raw = std::fs::read_to_string(&settings_path)
            .map_err(|error| format!("read settings: {error}"))?;
        serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };
    if !settings.is_object() {
        settings = json!({});
    }
    settings["hooks"] = json!({
        "PreToolUse": [{
            "matcher": "Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|Bash",
            "hooks": [{
                "type": "command",
                "command": command,
                "timeout": 10
            }]
        }]
    });
    std::fs::create_dir_all(config_dir).map_err(|error| format!("create config dir: {error}"))?;
    std::fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("write settings: {error}"))?;
    Ok(())
}

fn path_guard_hook_command(project_root: &Path) -> Option<String> {
    if !project_root.is_absolute() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    Some(format!(
        "{} --bind-project-path {}",
        quote_cmd(&exe.to_string_lossy()),
        quote_cmd(&project_root.to_string_lossy()),
    ))
}

fn quote_cmd(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

fn path_keys(tool_name: &str) -> &'static [&'static str] {
    match tool_name.trim().to_ascii_lowercase().as_str() {
        "read" | "write" | "edit" | "multiedit" => &["file_path"],
        "notebookedit" => &["notebook_path", "file_path"],
        "glob" | "grep" | "ls" => &["path"],
        _ => &["file_path", "path", "notebook_path"],
    }
}

fn bind_bash(root: &ProjectRoot, input: Value) -> ToolPathDecision {
    let Value::Object(mut map) = input else {
        return ToolPathDecision::Keep(input);
    };
    let Some(command) = map
        .get("command")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return ToolPathDecision::Keep(Value::Object(map));
    };
    let rewritten = replace_placeholder_homes(root, &command);
    if rewritten == command {
        return ToolPathDecision::Keep(Value::Object(map));
    }
    map.insert("command".into(), Value::String(rewritten));
    ToolPathDecision::Rewrite(Value::Object(map))
}

fn bind_path(root: &ProjectRoot, raw: &str) -> PathBind {
    let trimmed = raw.trim().trim_matches('"');
    if trimmed.is_empty() {
        return PathBind::Inside(raw.to_string());
    }
    if is_tilde(trimmed) {
        let rest = trimmed
            .trim_start_matches('~')
            .trim_start_matches(['/', '\\']);
        return render_joined(root, &split_parts(rest));
    }
    match parse_absolute(trimmed) {
        Some((prefix, prefix_display, parts)) => {
            if same_prefix(&root.prefix, &prefix) && starts_with_parts(&parts, &root.parts) {
                return PathBind::Inside(display_absolute(
                    &root.sep.to_string(),
                    if root.prefix_display.is_empty() {
                        &prefix_display
                    } else {
                        &root.prefix_display
                    },
                    &parts,
                ));
            }
            match strip_home(&prefix, &parts) {
                Some(rest) => render_joined(root, &trim_copied_project_leaf(&root.parts, &rest)),
                None => PathBind::Deny,
            }
        }
        None => render_joined(root, &split_parts(&trimmed.replace('\\', "/"))),
    }
}

fn render_joined(root: &ProjectRoot, extra: &[String]) -> PathBind {
    let Some(parts) = join_parts(&root.parts, extra) else {
        return PathBind::Deny;
    };
    PathBind::Inside(display_absolute(
        &root.sep.to_string(),
        &root.prefix_display,
        &parts,
    ))
}

fn is_tilde(value: &str) -> bool {
    value == "~" || value.starts_with("~/") || value.starts_with("~\\")
}

fn replace_placeholder_homes(root: &ProjectRoot, command: &str) -> String {
    let replacement = display_absolute(&root.sep.to_string(), &root.prefix_display, &root.parts);
    let chars: Vec<char> = command.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        if let Some(len) = placeholder_prefix_len(&chars[index..]) {
            out.push_str(&replacement);
            index += len;
        } else {
            out.push(chars[index]);
            index += 1;
        }
    }
    out
}

fn placeholder_prefix_len(chars: &[char]) -> Option<usize> {
    if chars.len() >= 3
        && chars[0].is_ascii_alphabetic()
        && chars[1] == ':'
        && (chars[2] == '\\' || chars[2] == '/')
    {
        let rest = &chars[3..];
        if let Some(users_len) = starts_with_ignore(rest, "users") {
            let after_users = &rest[users_len..];
            if matches!(after_users.first(), Some('\\' | '/')) {
                if let Some(user_len) = starts_with_ignore(&after_users[1..], "user") {
                    let end = 3 + users_len + 1 + user_len;
                    if is_path_boundary(chars.get(end).copied()) {
                        return Some(end);
                    }
                }
            }
        }
    }
    for root in ["/Users/user", "/home/user", "\\Users\\user", "\\home\\user"] {
        if let Some(len) = starts_with_ignore(chars, root) {
            if is_path_boundary(chars.get(len).copied()) {
                return Some(len);
            }
        }
    }
    None
}

fn starts_with_ignore(chars: &[char], literal: &str) -> Option<usize> {
    let literal: Vec<char> = literal.chars().collect();
    if chars.len() < literal.len() {
        return None;
    }
    let matches = chars[..literal.len()]
        .iter()
        .zip(literal.iter())
        .all(|(left, right)| left.eq_ignore_ascii_case(right));
    matches.then_some(literal.len())
}

fn is_path_boundary(next: Option<char>) -> bool {
    match next {
        None => true,
        Some(ch) => !ch.is_ascii_alphanumeric() && ch != '_' && ch != '.',
    }
}

impl ProjectRoot {
    fn parse(raw: &str) -> Option<Self> {
        let trimmed = raw.trim().trim_end_matches(['/', '\\']);
        if trimmed.is_empty() {
            return None;
        }
        let (prefix, prefix_display, parts) = parse_absolute(trimmed)?;
        let sep = if raw.contains('\\') { '\\' } else { '/' };
        Some(Self {
            prefix,
            prefix_display,
            parts,
            sep,
        })
    }
}

fn parse_absolute(raw: &str) -> Option<(String, String, Vec<String>)> {
    let forward = raw.replace('\\', "/");
    let bytes = forward.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let prefix_display = forward[..2].to_string();
        let prefix = prefix_display.to_ascii_lowercase();
        let rest = forward[2..].trim_start_matches('/');
        return Some((prefix, prefix_display, split_parts(rest)));
    }
    if forward.starts_with('/') && !forward.starts_with("//") {
        let rest = forward.trim_start_matches('/');
        return Some((String::new(), String::new(), split_parts(rest)));
    }
    None
}

fn split_parts(value: &str) -> Vec<String> {
    value
        .split(['/', '\\'])
        .filter(|part| !part.is_empty() && *part != ".")
        .map(str::to_string)
        .collect()
}

fn trim_copied_project_leaf(root_parts: &[String], extra: &[String]) -> Vec<String> {
    let Some(leaf) = root_parts.last() else {
        return extra.to_vec();
    };
    if is_generic_directory_name(leaf) {
        return extra.to_vec();
    }
    match extra
        .iter()
        .rposition(|part| part.eq_ignore_ascii_case(leaf))
    {
        Some(index) => extra[index + 1..].to_vec(),
        None => extra.to_vec(),
    }
}

fn is_generic_directory_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "src"
            | "bin"
            | "lib"
            | "user"
            | "users"
            | "documents"
            | "desktop"
            | "home"
            | "tmp"
            | "temp"
            | "windows"
            | "system32"
    )
}

fn strip_home(prefix: &str, parts: &[String]) -> Option<Vec<String>> {
    let head = parts.first().map(|part| part.to_ascii_lowercase());
    let drive = prefix.len() == 2 && prefix.as_bytes().get(1) == Some(&b':');
    let unix = prefix.is_empty();
    if drive && head.as_deref() == Some("users") && parts.len() >= 2 {
        return Some(parts[2..].to_vec());
    }
    if unix && matches!(head.as_deref(), Some("users" | "home")) && parts.len() >= 2 {
        return Some(parts[2..].to_vec());
    }
    None
}

fn join_parts(base: &[String], extra: &[String]) -> Option<Vec<String>> {
    let mut out = base.to_vec();
    for part in extra {
        if part == ".." {
            if out.len() <= base.len() {
                return None;
            }
            out.pop();
            continue;
        }
        if part.contains(':') || part.starts_with('/') || part.starts_with('\\') {
            return None;
        }
        out.push(part.clone());
    }
    Some(out)
}

fn same_prefix(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn starts_with_parts(path: &[String], root: &[String]) -> bool {
    path.len() >= root.len()
        && path
            .iter()
            .zip(root.iter())
            .all(|(part, root_part)| part.eq_ignore_ascii_case(root_part))
}

fn display_absolute(sep: &str, prefix_display: &str, parts: &[String]) -> String {
    let body = parts.join(sep);
    if prefix_display.is_empty() {
        format!("/{body}")
    } else if body.is_empty() {
        format!("{prefix_display}{sep}")
    } else {
        format!("{prefix_display}{sep}{body}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT: &str = r"C:\Users\23873\Documents\LocalPrism\1111";

    #[test]
    fn remaps_placeholder_windows_home_onto_the_open_project() {
        let decision = bind_tool_input(
            PROJECT,
            "Read",
            json!({ "file_path": r"C:\Users\user\main.tex" }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Rewrite(json!({
                "file_path": r"C:\Users\23873\Documents\LocalPrism\1111\main.tex"
            }))
        );
    }

    #[test]
    fn drops_a_copied_project_leaf_from_a_placeholder_home() {
        let decision = bind_tool_input(
            PROJECT,
            "Read",
            json!({ "file_path": r"C:\Users\user\Documents\LocalPrism\1111\main.tex" }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Rewrite(json!({
                "file_path": r"C:\Users\23873\Documents\LocalPrism\1111\main.tex"
            }))
        );
    }

    #[test]
    fn remaps_forward_slash_placeholder_home() {
        let decision = bind_tool_input(
            PROJECT,
            "Edit",
            json!({ "file_path": "C:/Users/user/sections/intro.tex" }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Rewrite(json!({
                "file_path": r"C:\Users\23873\Documents\LocalPrism\1111\sections\intro.tex"
            }))
        );
    }

    #[test]
    fn binds_relative_main_tex_under_the_project() {
        let decision = bind_tool_input(PROJECT, "Read", json!({ "file_path": "main.tex" }));
        assert_eq!(
            decision,
            ToolPathDecision::Rewrite(json!({
                "file_path": r"C:\Users\23873\Documents\LocalPrism\1111\main.tex"
            }))
        );
    }

    #[test]
    fn keeps_a_path_already_inside_the_project() {
        let path = r"C:\Users\23873\Documents\LocalPrism\1111\main.tex";
        let decision = bind_tool_input(PROJECT, "Read", json!({ "file_path": path }));
        assert_eq!(
            decision,
            ToolPathDecision::Keep(json!({ "file_path": path }))
        );
    }

    #[test]
    fn remaps_posix_placeholder_homes() {
        let root = "/Users/23873/Documents/LocalPrism/1111";
        let decision =
            bind_tool_input(root, "Read", json!({ "file_path": "/Users/user/main.tex" }));
        assert_eq!(
            decision,
            ToolPathDecision::Rewrite(json!({
                "file_path": "/Users/23873/Documents/LocalPrism/1111/main.tex"
            }))
        );
        let decision = bind_tool_input(
            "/home/23873/paper",
            "Read",
            json!({ "file_path": "/home/user/main.tex" }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Rewrite(json!({
                "file_path": "/home/23873/paper/main.tex"
            }))
        );
    }

    #[test]
    fn binds_tilde_paths_to_the_project_not_the_real_home() {
        let decision = bind_tool_input(PROJECT, "Read", json!({ "file_path": "~/main.tex" }));
        assert_eq!(
            decision,
            ToolPathDecision::Rewrite(json!({
                "file_path": r"C:\Users\23873\Documents\LocalPrism\1111\main.tex"
            }))
        );
    }

    #[test]
    fn denies_paths_outside_the_project_that_are_not_a_home_alias() {
        let decision = bind_tool_input(
            PROJECT,
            "Read",
            json!({ "file_path": r"C:\Windows\System32\drivers\etc\hosts" }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));
        let decision = bind_tool_input(
            "/Users/23873/paper",
            "Read",
            json!({ "file_path": "/etc/passwd" }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));
    }

    #[test]
    fn denies_relative_escape_above_the_project() {
        let decision = bind_tool_input(
            PROJECT,
            "Write",
            json!({ "file_path": r"..\..\secret.txt" }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));
    }

    #[test]
    fn remaps_only_the_placeholder_user_inside_bash() {
        let decision = bind_tool_input(
            PROJECT,
            "Bash",
            json!({ "command": r"Get-Content C:\Users\user\main.tex" }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Rewrite(json!({
                "command": r"Get-Content C:\Users\23873\Documents\LocalPrism\1111\main.tex"
            }))
        );
        let keep = bind_tool_input(PROJECT, "Bash", json!({ "command": r"cd C:\Users\23873" }));
        assert_eq!(
            keep,
            ToolPathDecision::Keep(json!({ "command": r"cd C:\Users\23873" }))
        );
    }

    #[test]
    fn hook_rewrites_read_and_denies_unrelated_absolute_paths() {
        let payload = json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "Read",
            "cwd": PROJECT,
            "tool_input": { "file_path": r"C:\Users\user\main.tex" }
        })
        .to_string();
        let rewritten = bind_project_path_hook(Some(PROJECT), &payload);
        let parsed: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(
            parsed["hookSpecificOutput"]["updatedInput"]["file_path"],
            r"C:\Users\23873\Documents\LocalPrism\1111\main.tex"
        );

        let denied = bind_project_path_hook(
            Some(PROJECT),
            &json!({
                "tool_name": "Read",
                "tool_input": { "file_path": r"D:\other\notes.tex" }
            })
            .to_string(),
        );
        let parsed: Value = serde_json::from_str(&denied).unwrap();
        assert_eq!(parsed["hookSpecificOutput"]["permissionDecision"], "deny");
    }

    #[test]
    fn hook_uses_payload_cwd_when_no_hint_is_passed() {
        let payload = json!({
            "tool_name": "Glob",
            "cwd": PROJECT,
            "tool_input": { "path": r"C:\Users\user" }
        })
        .to_string();
        let rewritten = bind_project_path_hook(None, &payload);
        let parsed: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(
            parsed["hookSpecificOutput"]["updatedInput"]["path"],
            r"C:\Users\23873\Documents\LocalPrism\1111"
        );
    }
}
