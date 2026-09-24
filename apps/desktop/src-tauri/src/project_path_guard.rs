//! Bind agent file-tool paths to the open project.
//!
//! Claude Code's working directory is already the open paper. Models still
//! sometimes pass an absolute path under a placeholder home (`C:\Users\user\…`,
//! `/Users/user/…`, `/home/user/…`). Those absolute paths skip the working
//! directory, so Read looks in the wrong place. This module remaps that class
//! of path onto the project root and refuses other locations outside the project.
//!
//! Real home directories are not remapped — only the placeholder account
//! `user`. App-owned trees (LocalPrism home, the turn's Claude config dir)
//! can be allow-listed so skill/reference Reads keep working. `..` in an
//! absolute path is normalized before the inside-project check.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

const DENY_MESSAGE: &str =
    "This path is outside the open project. Use a relative path such as main.tex.";
const PLACEHOLDER_USER: &str = "user";
const GUARD_SPEC_FILENAME: &str = "path-guard.json";

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

#[derive(Clone)]
struct ProjectRoot {
    /// Drive prefix such as `c:` / UNC `\\host\share`, or empty for POSIX.
    prefix: String,
    /// Original drive/UNC text, preserving letter case.
    prefix_display: String,
    parts: Vec<String>,
    sep: char,
}

impl ProjectRoot {
    fn ignore_case(&self) -> bool {
        !self.prefix.is_empty() || self.sep == '\\'
    }
}

pub fn bind_tool_input(project_root: &str, tool_name: &str, input: Value) -> ToolPathDecision {
    bind_tool_input_with_allows(project_root, &[], tool_name, input)
}

pub fn bind_tool_input_with_allows(
    project_root: &str,
    allow_roots: &[String],
    tool_name: &str,
    input: Value,
) -> ToolPathDecision {
    let parsed_root = ProjectRoot::parse(project_root);
    let allow: Vec<ProjectRoot> = if is_read_tool(tool_name) {
        allow_roots
            .iter()
            .filter_map(|root| ProjectRoot::parse(root))
            .collect()
    } else {
        Vec::new()
    };

    if is_shell_tool(tool_name) {
        let Some(root) = parsed_root.as_ref() else {
            return ToolPathDecision::Keep(input);
        };
        return bind_bash(root, input);
    }

    let Some(keys) = path_keys(tool_name) else {
        return ToolPathDecision::Keep(input);
    };

    let Some(root) = parsed_root.as_ref() else {
        return deny_absolute_file_paths(input, keys);
    };

    let Value::Object(mut map) = input else {
        return ToolPathDecision::Keep(input);
    };
    let mut changed = false;
    for key in keys {
        let Some(raw) = map.get(*key).and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        if raw.trim().is_empty() {
            continue;
        }
        match bind_path(root, &allow, &raw) {
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
///
/// `spec_or_project` is either a `path-guard.json` written by
/// [`install_path_guard_hook`] or a raw project path (tests / older callers).
pub fn bind_project_path_hook(spec_or_project: Option<&str>, payload: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(payload) else {
        return hook_deny_output(DENY_MESSAGE);
    };
    let tool_name = value.get("tool_name").and_then(Value::as_str).unwrap_or("");
    let cwd = value.get("cwd").and_then(Value::as_str).unwrap_or("");
    let (hint, allow_roots) = resolve_guard_spec(spec_or_project);
    let hinted = hint.as_deref().unwrap_or("").trim();
    let root = if hinted.is_empty() { cwd } else { hinted };
    if root.trim().is_empty() {
        return hook_deny_output(DENY_MESSAGE);
    }
    let input = value
        .get("tool_input")
        .cloned()
        .unwrap_or_else(|| json!({}));
    match bind_tool_input_with_allows(root, &allow_roots, tool_name, input) {
        ToolPathDecision::Keep(_) => String::new(),
        ToolPathDecision::Rewrite(updated) => {
            let (decision, reason) = rewrite_permission(tool_name);
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": decision,
                    "permissionDecisionReason": reason,
                    "updatedInput": updated
                }
            })
            .to_string()
        }
        ToolPathDecision::Deny(message) => hook_deny_output(&message),
    }
}

fn rewrite_permission(tool_name: &str) -> (&'static str, &'static str) {
    if is_shell_tool(tool_name) {
        (
            "ask",
            "Command remapped onto the open project. Confirm before running.",
        )
    } else if is_read_tool(tool_name) {
        ("allow", "Path remapped onto the open project.")
    } else {
        (
            "ask",
            "Path remapped onto the open project. Confirm before writing.",
        )
    }
}

fn hook_deny_output(message: &str) -> String {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": message
        }
    })
    .to_string()
}

/// Write hook JSON and flush. `print!` + `process::exit` skips `Stdout` Drop,
/// so a block-buffered pipe can discard a payload under ~8KB and Claude Code
/// treats empty stdout as Keep.
pub fn write_hook_stdout(output: &str) -> std::io::Result<()> {
    write_hook_response(&mut std::io::stdout(), output)
}

fn write_hook_response<W: Write>(writer: &mut W, output: &str) -> std::io::Result<()> {
    writer.write_all(output.as_bytes())?;
    writer.flush()
}

pub fn install_path_guard_hook(config_dir: &Path, project_root: &Path) -> Result<(), String> {
    let spec_path = config_dir.join(GUARD_SPEC_FILENAME);
    write_guard_spec(&spec_path, config_dir, project_root)?;
    let command = path_guard_hook_command(&spec_path)
        .ok_or_else(|| "could not build the project path-guard hook command".to_string())?;
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
    settings["disableAllHooks"] = json!(false);
    settings["hooks"] = json!({
        "PreToolUse": [{
            "matcher": "Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|LS|Bash|PowerShell",
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

fn write_guard_spec(
    spec_path: &Path,
    config_dir: &Path,
    project_root: &Path,
) -> Result<(), String> {
    let allow = default_allow_roots(config_dir);
    let spec = json!({
        "project": project_root.to_string_lossy(),
        "allow": allow,
    });
    if let Some(parent) = spec_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("create config dir: {error}"))?;
    }
    std::fs::write(
        spec_path,
        serde_json::to_string_pretty(&spec).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("write path-guard spec: {error}"))?;
    Ok(())
}

pub fn default_allow_roots(config_dir: &Path) -> Vec<String> {
    let mut roots = Vec::new();
    if config_dir.as_os_str().is_empty() {
        // still pick up the user library folders below
    } else {
        for name in ["skills", "agents", "slash", "commands"] {
            push_unique(
                &mut roots,
                config_dir.join(name).to_string_lossy().into_owned(),
            );
        }
    }
    for resolve in [
        crate::providers::paths::user_skills_dir,
        crate::providers::paths::user_agents_dir,
        crate::providers::paths::user_slash_dir,
    ] {
        if let Ok(dir) = resolve() {
            push_unique(&mut roots, dir.to_string_lossy().into_owned());
        }
    }
    roots
}

fn push_unique(roots: &mut Vec<String>, value: String) {
    if !value.is_empty() && !roots.iter().any(|root| root == &value) {
        roots.push(value);
    }
}

fn resolve_guard_spec(spec_or_project: Option<&str>) -> (Option<String>, Vec<String>) {
    let Some(raw) = spec_or_project
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return (None, Vec::new());
    };
    if looks_like_guard_spec(raw) {
        return read_guard_spec(Path::new(raw)).unwrap_or((None, Vec::new()));
    }
    if let Some(spec) = read_guard_spec(Path::new(raw)) {
        return spec;
    }
    (Some(raw.to_string()), Vec::new())
}

fn looks_like_guard_spec(path: &str) -> bool {
    path.rsplit(['/', '\\'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case(GUARD_SPEC_FILENAME))
}

fn read_guard_spec(path: &Path) -> Option<(Option<String>, Vec<String>)> {
    if !path.is_file() {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    if !value.is_object() {
        return None;
    }
    let project = value
        .get("project")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let allow = value
        .get("allow")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if project.is_none() && allow.is_empty() {
        return None;
    }
    Some((project, allow))
}

fn path_guard_hook_command(spec_path: &Path) -> Option<String> {
    if !spec_path.is_absolute() {
        return None;
    }
    let exe = hook_executable()?;
    Some(format!(
        "{} --bind-project-path {}",
        quote_cmd(&exe.to_string_lossy()),
        quote_cmd(&spec_path.to_string_lossy()),
    ))
}

fn hook_executable() -> Option<PathBuf> {
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        let path = PathBuf::from(appimage.trim());
        if path.is_file() {
            return Some(path);
        }
    }
    std::env::current_exe().ok()
}

fn quote_cmd(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' | '\\' | '$' | '`' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn is_shell_tool(tool_name: &str) -> bool {
    matches!(
        tool_name.trim().to_ascii_lowercase().as_str(),
        "bash" | "powershell"
    )
}

fn is_read_tool(tool_name: &str) -> bool {
    matches!(
        tool_name.trim().to_ascii_lowercase().as_str(),
        "read" | "glob" | "grep" | "ls"
    )
}

fn path_keys(tool_name: &str) -> Option<&'static [&'static str]> {
    match tool_name.trim().to_ascii_lowercase().as_str() {
        "read" | "write" | "edit" | "multiedit" => Some(&["file_path"]),
        "notebookedit" => Some(&["notebook_path", "file_path"]),
        "glob" | "grep" | "ls" => Some(&["path"]),
        _ => None,
    }
}

fn deny_absolute_file_paths(input: Value, keys: &[&str]) -> ToolPathDecision {
    let Value::Object(ref map) = input else {
        return ToolPathDecision::Keep(input);
    };
    for key in keys {
        let Some(raw) = map.get(*key).and_then(Value::as_str) else {
            continue;
        };
        let trimmed = raw.trim().trim_matches('"');
        if trimmed.is_empty() {
            continue;
        }
        if is_tilde(trimmed) || parse_absolute(trimmed).is_some() {
            return ToolPathDecision::Deny(DENY_MESSAGE.to_string());
        }
    }
    ToolPathDecision::Keep(input)
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
    match replace_placeholder_homes(root, &command) {
        CommandRewrite::Keep => ToolPathDecision::Keep(Value::Object(map)),
        CommandRewrite::Rewrite(rewritten) => {
            map.insert("command".into(), Value::String(rewritten));
            ToolPathDecision::Rewrite(Value::Object(map))
        }
        CommandRewrite::Deny => ToolPathDecision::Deny(DENY_MESSAGE.to_string()),
    }
}

enum CommandRewrite {
    Keep,
    Rewrite(String),
    Deny,
}

fn bind_path(root: &ProjectRoot, allow: &[ProjectRoot], raw: &str) -> PathBind {
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
            let Some(normalized) = normalize_parts(&parts) else {
                return PathBind::Deny;
            };
            if prefixes_match(&root.prefix, &prefix)
                && starts_with_parts(&normalized, &root.parts, root.ignore_case())
            {
                let displayed = display_absolute(
                    &root.sep.to_string(),
                    if root.prefix_display.is_empty() {
                        &prefix_display
                    } else {
                        &root.prefix_display
                    },
                    &normalized,
                );
                if same_location(raw, &displayed, root.ignore_case()) {
                    return PathBind::Inside(raw.to_string());
                }
                return PathBind::Inside(displayed);
            }
            for allowed in allow {
                if prefixes_match(&allowed.prefix, &prefix)
                    && starts_with_parts(&normalized, &allowed.parts, allowed.ignore_case())
                {
                    return PathBind::Inside(display_absolute(
                        &allowed.sep.to_string(),
                        if allowed.prefix_display.is_empty() {
                            &prefix_display
                        } else {
                            &allowed.prefix_display
                        },
                        &normalized,
                    ));
                }
            }
            match strip_placeholder_home(&prefix, &normalized) {
                Some(rest) => render_joined(root, &trim_copied_project_prefix(&root.parts, &rest)),
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

fn replace_placeholder_homes(root: &ProjectRoot, command: &str) -> CommandRewrite {
    let chars: Vec<char> = command.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    let mut changed = false;
    while index < chars.len() {
        let prev = if index == 0 {
            None
        } else {
            Some(chars[index - 1])
        };
        if is_token_start(prev) {
            if let Some(prefix_len) = placeholder_prefix_len(&chars[index..]) {
                let token_end = path_token_end(&chars, index);
                let remainder = &chars[index + prefix_len..token_end];
                if remainder.iter().any(|ch| matches!(ch, '*' | '?')) {
                    out.extend(chars[index..token_end].iter());
                    index = token_end;
                    continue;
                }
                let token: String = chars[index..token_end].iter().collect();
                match bind_path(root, &[], &token) {
                    PathBind::Inside(next) => {
                        if next.split(['/', '\\']).any(|part| part == "..") {
                            return CommandRewrite::Deny;
                        }
                        out.push_str(&next);
                        changed = true;
                        index = token_end;
                        continue;
                    }
                    PathBind::Deny => return CommandRewrite::Deny,
                }
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    if changed {
        CommandRewrite::Rewrite(out)
    } else {
        CommandRewrite::Keep
    }
}

fn is_token_start(prev: Option<char>) -> bool {
    match prev {
        None => true,
        Some(ch) => {
            ch.is_whitespace() || matches!(ch, '"' | '\'' | '=' | '(' | '[' | ',' | ';' | '|')
        }
    }
}

fn path_token_end(chars: &[char], start: usize) -> usize {
    let mut index = start;
    while index < chars.len() && !is_shell_token_end(chars[index]) {
        index += 1;
    }
    index
}

fn is_shell_token_end(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '"' | '\'' | ';' | '|' | '&' | '(' | ')' | '<' | '>' | '`' | ','
        )
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
                if let Some(user_len) = starts_with_ignore(&after_users[1..], PLACEHOLDER_USER) {
                    let end = 3 + users_len + 1 + user_len;
                    if is_placeholder_account_end(chars.get(end).copied()) {
                        return Some(end);
                    }
                }
            }
        }
    }
    for prefix in ["/Users/user", "/home/user", "\\Users\\user", "\\home\\user"] {
        if let Some(len) = starts_with_ignore(chars, prefix) {
            if is_placeholder_account_end(chars.get(len).copied()) {
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

fn is_placeholder_account_end(next: Option<char>) -> bool {
    match next {
        None => true,
        Some('/' | '\\') => true,
        Some(ch) => is_shell_token_end(ch),
    }
}

impl ProjectRoot {
    fn parse(raw: &str) -> Option<Self> {
        let trimmed = raw.trim().trim_end_matches(['/', '\\']);
        if trimmed.is_empty() {
            return None;
        }
        let (prefix, prefix_display, parts) = parse_absolute(trimmed)?;
        let sep = if looks_windows(raw, &prefix) {
            '\\'
        } else {
            '/'
        };
        Some(Self {
            prefix,
            prefix_display,
            parts,
            sep,
        })
    }
}

fn looks_windows(raw: &str, prefix: &str) -> bool {
    raw.contains('\\') || prefix.contains(':') || prefix.starts_with("\\\\")
}

fn strip_extended_prefix(forward: &str) -> Option<String> {
    let lowered = forward.to_ascii_lowercase();
    if let Some(rest) = lowered.strip_prefix("//?/unc/") {
        let start = forward.len() - rest.len();
        return Some(format!("//{}", &forward[start..]));
    }
    forward.strip_prefix("//?/").map(str::to_string)
}

fn parse_absolute(raw: &str) -> Option<(String, String, Vec<String>)> {
    let mut forward = raw.replace('\\', "/");
    if let Some(rest) = strip_extended_prefix(&forward) {
        forward = rest;
    } else if forward.starts_with("//./") {
        return None;
    }

    let bytes = forward.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let prefix_display = forward[..2].to_string();
        let prefix = prefix_display.to_ascii_lowercase();
        let rest = forward[2..].trim_start_matches('/');
        return Some((prefix, prefix_display, split_parts(rest)));
    }
    if forward.starts_with("//") {
        let parts = split_parts(forward.trim_start_matches('/'));
        if parts.len() < 2 {
            return None;
        }
        let prefix_display = format!("\\\\{}\\{}", parts[0], parts[1]);
        let prefix = prefix_display.to_ascii_lowercase();
        return Some((prefix, prefix_display, parts[2..].to_vec()));
    }
    if forward.starts_with('/') {
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

fn normalize_parts(parts: &[String]) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for part in parts {
        if part == ".." {
            out.pop()?;
            continue;
        }
        if part.contains(':') {
            return None;
        }
        out.push(part.clone());
    }
    Some(out)
}

fn trim_copied_project_prefix(root_parts: &[String], extra: &[String]) -> Vec<String> {
    let max = extra.len().min(root_parts.len());
    for len in (1..=max).rev() {
        let extra_prefix = &extra[..len];
        let root_suffix = &root_parts[root_parts.len() - len..];
        if extra_prefix
            .iter()
            .zip(root_suffix.iter())
            .all(|(left, right)| left.eq_ignore_ascii_case(right))
        {
            return extra[len..].to_vec();
        }
    }
    extra.to_vec()
}

fn strip_placeholder_home(prefix: &str, parts: &[String]) -> Option<Vec<String>> {
    let drive = prefix.len() == 2 && prefix.as_bytes().get(1) == Some(&b':');
    let unix = prefix.is_empty();
    let users = parts.first()?.eq_ignore_ascii_case("users");
    let home = parts.first()?.eq_ignore_ascii_case("home");
    let account = parts.get(1)?;
    if !account.eq_ignore_ascii_case(PLACEHOLDER_USER) {
        return None;
    }
    if (drive && users || unix && (users || home)) && parts.len() >= 2 {
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

fn prefixes_match(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn same_location(raw: &str, displayed: &str, ignore_case: bool) -> bool {
    if raw.split(['/', '\\']).any(|part| part == "..") {
        return false;
    }
    let Some((raw_prefix, _, raw_parts)) = parse_absolute(raw) else {
        return raw == displayed;
    };
    let Some(raw_norm) = normalize_parts(&raw_parts) else {
        return false;
    };
    let Some((disp_prefix, _, disp_parts)) = parse_absolute(displayed) else {
        return false;
    };
    prefixes_match(&raw_prefix, &disp_prefix)
        && starts_with_parts(&raw_norm, &disp_parts, ignore_case)
        && starts_with_parts(&disp_parts, &raw_norm, ignore_case)
}

fn starts_with_parts(path: &[String], root: &[String], ignore_case: bool) -> bool {
    path.len() >= root.len()
        && path.iter().zip(root.iter()).all(|(part, root_part)| {
            if ignore_case {
                part.eq_ignore_ascii_case(root_part)
            } else {
                part == root_part
            }
        })
}

fn display_absolute(sep: &str, prefix_display: &str, parts: &[String]) -> String {
    let body = parts.join(sep);
    if prefix_display.is_empty() {
        format!("/{body}")
    } else if prefix_display.starts_with("\\\\") {
        if body.is_empty() {
            format!("{prefix_display}{sep}")
        } else {
            format!("{prefix_display}{sep}{body}")
        }
    } else if body.is_empty() {
        format!("{prefix_display}{sep}")
    } else {
        format!("{prefix_display}{sep}{body}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const PROJECT: &str = r"C:\Users\23873\Documents\LocalPrism\1111";
    const LP_HOME: &str = r"C:\Users\23873\AppData\Local\LocalPrism";

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
    fn denies_absolute_dotdot_escape_from_the_project() {
        for path in [
            r"C:\Users\23873\Documents\LocalPrism\1111\..\..\..\.ssh\id_rsa",
            r"C:\Users\23873\Documents\LocalPrism\1111\sub\..\..\..\Windows\win.ini",
            r"C:/Users/23873/Documents/LocalPrism/1111/../../..",
        ] {
            let decision = bind_tool_input(PROJECT, "Read", json!({ "file_path": path }));
            assert!(
                matches!(decision, ToolPathDecision::Deny(_)),
                "expected deny for {path}, got {decision:?}"
            );
        }
        let decision = bind_tool_input(
            "/Users/alice/paper",
            "Read",
            json!({ "file_path": "/Users/alice/paper/../.ssh/id_rsa" }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));
    }

    #[test]
    fn normalizes_dotdot_that_stays_inside_the_project() {
        let decision = bind_tool_input(
            PROJECT,
            "Read",
            json!({ "file_path": r"C:\Users\23873\Documents\LocalPrism\1111\sections\..\main.tex" }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Rewrite(json!({
                "file_path": r"C:\Users\23873\Documents\LocalPrism\1111\main.tex"
            }))
        );
    }

    #[test]
    fn does_not_remap_a_real_home_directory() {
        let decision = bind_tool_input(
            PROJECT,
            "Read",
            json!({ "file_path": r"C:\Users\23873\Downloads\ref.pdf" }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));
        let decision = bind_tool_input(
            PROJECT,
            "Read",
            json!({ "file_path": r"C:\Users\Administrator\secret.txt" }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));
        let decision = bind_tool_input(
            "/Users/alice/paper",
            "Read",
            json!({
                "file_path": "/Users/alice/Library/Application Support/LocalPrism/claude-home/skills/latex/SKILL.md"
            }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));
    }

    #[test]
    fn keeps_allowlisted_app_paths() {
        let skill = r"C:\Users\23873\AppData\Local\LocalPrism\claude-home\runtimes\abc\skills\latex\SKILL.md";
        let decision = bind_tool_input_with_allows(
            PROJECT,
            &[LP_HOME.to_string()],
            "Read",
            json!({ "file_path": skill }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Keep(json!({ "file_path": skill }))
        );
    }

    #[test]
    fn denies_writes_even_under_an_allowlisted_root() {
        let settings =
            r"C:\Users\23873\AppData\Local\LocalPrism\claude-home\runtimes\abc\settings.json";
        let decision = bind_tool_input_with_allows(
            PROJECT,
            &[LP_HOME.to_string()],
            "Write",
            json!({ "file_path": settings }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));
        let decision = bind_tool_input_with_allows(
            PROJECT,
            &[LP_HOME.to_string()],
            "Edit",
            json!({ "file_path": r"C:\Users\23873\AppData\Local\LocalPrism\claude-home\skills\latex\SKILL.md" }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));
    }

    #[test]
    fn keeps_an_inside_project_path_that_only_differs_by_separators() {
        let decision = bind_tool_input(
            PROJECT,
            "Read",
            json!({ "file_path": "C:/Users/23873/Documents/LocalPrism/1111/main.tex" }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Keep(json!({
                "file_path": "C:/Users/23873/Documents/LocalPrism/1111/main.tex"
            }))
        );
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
    fn does_not_rewrite_placeholder_text_inside_urls_or_other_paths() {
        let url = "curl https://example.com/home/user/file";
        let decision = bind_tool_input(PROJECT, "Bash", json!({ "command": url }));
        assert_eq!(decision, ToolPathDecision::Keep(json!({ "command": url })));
        let nested = r"copy D:\backup\Users\user\a.tex .";
        let decision = bind_tool_input(PROJECT, "Bash", json!({ "command": nested }));
        assert_eq!(
            decision,
            ToolPathDecision::Keep(json!({ "command": nested }))
        );
    }

    #[test]
    fn does_not_rewrite_a_bash_glob_on_a_placeholder_home() {
        let command = "rm -rf /home/user/*";
        let decision = bind_tool_input(PROJECT, "Bash", json!({ "command": command }));
        assert_eq!(
            decision,
            ToolPathDecision::Keep(json!({ "command": command }))
        );
        let command = r"Remove-Item C:\Users\user\*";
        let decision = bind_tool_input(PROJECT, "Bash", json!({ "command": command }));
        assert_eq!(
            decision,
            ToolPathDecision::Keep(json!({ "command": command }))
        );
    }

    #[test]
    fn denies_a_bash_placeholder_path_that_escapes_with_dotdot() {
        let decision = bind_tool_input(
            PROJECT,
            "Bash",
            json!({ "command": r"cat C:\Users\user\..\..\..\Users\real\.ssh\id_rsa" }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));
        let decision = bind_tool_input(
            "/home/23873/paper",
            "Bash",
            json!({ "command": "cat /home/user/../../.ssh/id_rsa" }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));
    }

    #[test]
    fn does_not_treat_user_name_as_placeholder_user() {
        let command = "cat /home/user-name/notes.tex";
        let decision = bind_tool_input(PROJECT, "Bash", json!({ "command": command }));
        assert_eq!(
            decision,
            ToolPathDecision::Keep(json!({ "command": command }))
        );
        let command = r"Get-Content C:\Users\user_backup\main.tex";
        let decision = bind_tool_input(PROJECT, "Bash", json!({ "command": command }));
        assert_eq!(
            decision,
            ToolPathDecision::Keep(json!({ "command": command }))
        );
    }

    #[test]
    fn write_hook_response_flushes_before_returning() {
        struct Probe {
            bytes: Vec<u8>,
            flushes: usize,
        }
        impl Write for Probe {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.bytes.extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.flushes += 1;
                Ok(())
            }
        }
        let mut probe = Probe {
            bytes: Vec::new(),
            flushes: 0,
        };
        let payload = r#"{"hookSpecificOutput":{"permissionDecision":"allow"}}"#;
        write_hook_response(&mut probe, payload).unwrap();
        assert_eq!(probe.bytes, payload.as_bytes());
        assert_eq!(probe.flushes, 1);
    }

    #[test]
    fn leaves_mcp_and_unknown_tools_alone() {
        let decision = bind_tool_input(
            PROJECT,
            "mcp__zotero__get",
            json!({ "path": "/api/v1/items" }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Keep(json!({ "path": "/api/v1/items" }))
        );
        let decision = bind_tool_input(
            PROJECT,
            "WebSearch",
            json!({ "path": r"C:\Windows\win.ini" }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Keep(json!({ "path": r"C:\Windows\win.ini" }))
        );
    }

    #[test]
    fn binds_unc_project_roots_and_extended_length_paths() {
        let unc = r"\\server\share\paper";
        let decision = bind_tool_input(
            unc,
            "Read",
            json!({ "file_path": r"\\server\share\paper\main.tex" }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Keep(json!({ "file_path": r"\\server\share\paper\main.tex" }))
        );
        let decision = bind_tool_input(unc, "Read", json!({ "file_path": r"C:\Windows\win.ini" }));
        assert!(matches!(decision, ToolPathDecision::Deny(_)));

        let decision = bind_tool_input(
            r"\\?\C:\Users\23873\Documents\LocalPrism\1111",
            "Read",
            json!({ "file_path": r"C:\Users\user\main.tex" }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Rewrite(json!({
                "file_path": r"C:\Users\23873\Documents\LocalPrism\1111\main.tex"
            }))
        );
        let decision = bind_tool_input(
            r"\\?\C:\Users\23873\Documents\LocalPrism\1111",
            "Read",
            json!({ "file_path": r"C:\Windows\win.ini" }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));

        let decision = bind_tool_input(
            r"\\?\UNC\server\share\paper",
            "Read",
            json!({ "file_path": r"\\server\share\paper\main.tex" }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Keep(json!({ "file_path": r"\\server\share\paper\main.tex" }))
        );
    }

    #[test]
    fn fails_closed_when_the_project_root_cannot_be_parsed() {
        let decision = bind_tool_input(
            "not-absolute",
            "Read",
            json!({ "file_path": r"C:\Windows\win.ini" }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));
        let decision = bind_tool_input("not-absolute", "Read", json!({ "file_path": "main.tex" }));
        assert_eq!(
            decision,
            ToolPathDecision::Keep(json!({ "file_path": "main.tex" }))
        );
    }

    #[test]
    fn strips_copied_generic_project_leaf_from_placeholder_paths() {
        let root = r"C:\Users\23873\Documents\LocalPrism\src";
        let decision = bind_tool_input(
            root,
            "Read",
            json!({ "file_path": r"C:\Users\user\Documents\LocalPrism\src\main.tex" }),
        );
        assert_eq!(
            decision,
            ToolPathDecision::Rewrite(json!({
                "file_path": r"C:\Users\23873\Documents\LocalPrism\src\main.tex"
            }))
        );
    }

    #[test]
    fn posix_inside_check_is_case_sensitive() {
        let decision = bind_tool_input(
            "/home/alice/paper",
            "Read",
            json!({ "file_path": "/home/Alice/paper/main.tex" }),
        );
        assert!(matches!(decision, ToolPathDecision::Deny(_)));
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
        assert_eq!(parsed["hookSpecificOutput"]["permissionDecision"], "allow");

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

    #[test]
    fn hook_asks_before_a_rewritten_write() {
        let rewritten = bind_project_path_hook(
            Some(PROJECT),
            &json!({
                "tool_name": "Write",
                "tool_input": { "file_path": r"C:\Users\user\main.tex", "content": "x" }
            })
            .to_string(),
        );
        let parsed: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(parsed["hookSpecificOutput"]["permissionDecision"], "ask");
        assert_eq!(
            parsed["hookSpecificOutput"]["updatedInput"]["file_path"],
            r"C:\Users\23873\Documents\LocalPrism\1111\main.tex"
        );
    }

    #[test]
    fn hook_asks_before_running_a_rewritten_shell_command() {
        let rewritten = bind_project_path_hook(
            Some(PROJECT),
            &json!({
                "tool_name": "Bash",
                "tool_input": { "command": r"Get-Content C:\Users\user\main.tex" }
            })
            .to_string(),
        );
        let parsed: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(parsed["hookSpecificOutput"]["permissionDecision"], "ask");
        assert_eq!(
            parsed["hookSpecificOutput"]["updatedInput"]["command"],
            r"Get-Content C:\Users\23873\Documents\LocalPrism\1111\main.tex"
        );
    }

    fn scratch_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lp-path-guard-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn hook_falls_back_to_cwd_when_the_spec_file_is_missing() {
        let rewritten = bind_project_path_hook(
            Some(r"C:\missing\path-guard.json"),
            &json!({
                "tool_name": "Read",
                "cwd": PROJECT,
                "tool_input": { "file_path": r"C:\Users\user\main.tex" }
            })
            .to_string(),
        );
        let parsed: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(
            parsed["hookSpecificOutput"]["updatedInput"]["file_path"],
            r"C:\Users\23873\Documents\LocalPrism\1111\main.tex"
        );
    }

    #[test]
    fn hook_loads_allow_roots_from_spec_file() {
        let temp = scratch_dir();
        let spec_path = temp.join("path-guard.json");
        std::fs::write(
            &spec_path,
            json!({
                "project": PROJECT,
                "allow": [LP_HOME]
            })
            .to_string(),
        )
        .unwrap();
        let skill = r"C:\Users\23873\AppData\Local\LocalPrism\claude-home\skills\latex\SKILL.md";
        let kept = bind_project_path_hook(
            spec_path.to_str(),
            &json!({
                "tool_name": "Read",
                "tool_input": { "file_path": skill }
            })
            .to_string(),
        );
        assert!(
            kept.is_empty(),
            "allow-listed skill path should be kept: {kept}"
        );

        let rewritten = bind_project_path_hook(
            spec_path.to_str(),
            &json!({
                "tool_name": "Read",
                "tool_input": { "file_path": r"C:\Users\user\main.tex" }
            })
            .to_string(),
        );
        let parsed: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(
            parsed["hookSpecificOutput"]["updatedInput"]["file_path"],
            r"C:\Users\23873\Documents\LocalPrism\1111\main.tex"
        );
    }

    #[test]
    fn install_puts_the_project_path_in_a_spec_file_not_the_shell() {
        let temp = scratch_dir();
        let project = temp.join("paper$(id)");
        std::fs::create_dir_all(&project).unwrap();
        let config = temp.join("runtime");
        install_path_guard_hook(&config, &project).unwrap();

        let settings = std::fs::read_to_string(config.join("settings.json")).unwrap();
        assert!(settings.contains("--bind-project-path"));
        assert!(settings.contains("disableAllHooks"));
        assert!(!settings.contains("$(id)"));

        let spec: Value = serde_json::from_str(
            &std::fs::read_to_string(config.join(GUARD_SPEC_FILENAME)).unwrap(),
        )
        .unwrap();
        assert!(spec["project"].as_str().unwrap().contains("paper$(id)"));
    }
}
