//! LocalPrism's context window, and the model id Claude Code must see for
//! auto-compact to use that window.
//!
//! Claude Code compacts from its own detected window, not from the ring
//! LocalPrism draws. Unknown model ids (gpt-6-luna, deepseek-chat, …) detect
//! as 200_000. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` can only shrink that number
//! (`min(detected, env)`). A larger LocalPrism window is visible to Claude
//! Code only after the spawn model opts into the `[1m]` detector (1_000_000),
//! which the env var then shrinks back down. Claude Code strips `[1m]` before
//! the provider request; the passthrough proxy also drops the 1M beta header.

/// Claude Code's fallback when it does not recognize the model.
pub const CLAUDE_CODE_UNKNOWN_MODEL_WINDOW: u64 = 200_000;

/// Moonshot / Kimi's documented 256k window. The old spawn path hardcoded this
/// only for the native Moonshot route, where the 200k cap still ignored it.
const MOONSHOT_CONTEXT_WINDOW: u64 = 262_144;

/// Resolve the window Claude Code should compact against.
///
/// A positive catalog value wins. Otherwise the id is matched the same way the
/// context ring estimates a window when the catalog has none.
pub fn window_for_model(model: &str, catalog: Option<u64>, hint: Option<&str>) -> u64 {
    if let Some(window) = catalog.filter(|window| *window > 0) {
        return window;
    }
    if let Some(window) = known_context_window(model) {
        return window;
    }
    match hint {
        Some("moonshot") => MOONSHOT_CONTEXT_WINDOW,
        _ => CLAUDE_CODE_UNKNOWN_MODEL_WINDOW,
    }
}

/// Model id passed to Claude Code. Windows above the 200k default need the
/// `[1m]` suffix so `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is not capped at 200k.
pub fn model_id_for_claude_context(model: &str, window: u64) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if window > CLAUDE_CODE_UNKNOWN_MODEL_WINDOW && !has_1m_suffix(trimmed) {
        format!("{trimmed}[1m]")
    } else {
        trimmed.to_string()
    }
}

fn known_context_window(model: &str) -> Option<u64> {
    let trimmed = model.trim();
    let raw = trimmed.to_ascii_lowercase();
    // Strip `[1m]` before family matching so `gpt-6-luna[1m]` stays a 272k GPT
    // id. The suffix itself is what marks a Claude model as the 1M window.
    let id = strip_1m_suffix(trimmed).to_ascii_lowercase();
    if id.is_empty() {
        return None;
    }
    if id.contains("gpt-4.1") {
        return Some(1_047_576);
    }
    if id.contains("gpt-") {
        return Some(272_000);
    }
    if id.contains("kimi") || id.contains("moonshot") {
        return Some(MOONSHOT_CONTEXT_WINDOW);
    }
    if id.contains("deepseek") {
        return Some(CLAUDE_CODE_UNKNOWN_MODEL_WINDOW);
    }
    if raw.contains("1m")
        && (raw.contains("claude") || raw.contains("opus") || raw.contains("sonnet"))
    {
        return Some(1_000_000);
    }
    if id.contains("claude") || id.contains("opus") || id.contains("sonnet") || id.contains("haiku")
    {
        return Some(CLAUDE_CODE_UNKNOWN_MODEL_WINDOW);
    }
    None
}

fn has_1m_suffix(model: &str) -> bool {
    strip_1m_suffix(model).len() != model.trim().len()
}

fn strip_1m_suffix(model: &str) -> &str {
    let trimmed = model.trim();
    let lower = trimmed.to_ascii_lowercase();
    let Some(stripped) = lower.strip_suffix("[1m]") else {
        return trimmed;
    };
    trimmed[..stripped.len()].trim()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_window_wins_over_the_model_heuristic() {
        assert_eq!(
            window_for_model("gpt-5.6-luna", Some(400_000), None),
            400_000
        );
        assert_eq!(
            window_for_model("deepseek-chat", Some(128_000), None),
            128_000
        );
    }

    #[test]
    fn heuristics_match_the_windows_localprism_shows() {
        assert_eq!(window_for_model("gpt-6-luna", None, None), 272_000);
        assert_eq!(window_for_model("gpt-5.6-terra", None, None), 272_000);
        assert_eq!(window_for_model("gpt-4.1", None, None), 1_047_576);
        assert_eq!(window_for_model("deepseek-chat", None, None), 200_000);
        assert_eq!(window_for_model("deepseek-v4-pro", None, None), 200_000);
        assert_eq!(window_for_model("kimi-k2.5", None, None), 262_144);
        assert_eq!(window_for_model("moonshot-v1-128k", None, None), 262_144);
        assert_eq!(window_for_model("claude-sonnet-4-6", None, None), 200_000);
        assert_eq!(
            window_for_model("claude-opus-4-6[1m]", None, None),
            1_000_000
        );
        assert_eq!(window_for_model("llama3.2", None, None), 200_000);
        assert_eq!(
            window_for_model("custom-model", None, Some("moonshot")),
            262_144
        );
    }

    #[test]
    fn larger_windows_opt_into_the_1m_detector_without_doubling_the_suffix() {
        assert_eq!(
            model_id_for_claude_context("gpt-6-luna", 272_000),
            "gpt-6-luna[1m]"
        );
        assert_eq!(model_id_for_claude_context("sonnet", 272_000), "sonnet[1m]");
        assert_eq!(
            model_id_for_claude_context("deepseek-chat", 200_000),
            "deepseek-chat"
        );
        assert_eq!(model_id_for_claude_context("sonnet", 200_000), "sonnet");
        assert_eq!(
            model_id_for_claude_context("gpt-6-luna[1m]", 272_000),
            "gpt-6-luna[1m]"
        );
        assert_eq!(
            model_id_for_claude_context("  kimi-k2.5  ", 262_144),
            "kimi-k2.5[1m]"
        );
    }
}
