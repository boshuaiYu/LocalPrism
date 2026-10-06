//! Optional usage trace for verifying provider cache fields on a real device.
//!
//! Enabled only when `LOCALPRISM_DEBUG_USAGE=1`. The disabled path is a cached
//! flag check: no JSON, no filesystem, and no request-sequence increment.
//! Records contain usage objects only — never request bodies, prompts, or
//! credentials.

use serde_json::{json, Map, Value};
use std::io::Write;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};

#[cfg(test)]
use std::cell::Cell;

const OFF: u8 = 1;
const ON: u8 = 2;

static STATE: AtomicU8 = AtomicU8::new(0);
static SEQ: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
thread_local! {
    static FORCE: Cell<Option<bool>> = const { Cell::new(None) };
}

pub(crate) fn enabled() -> bool {
    #[cfg(test)]
    if let Some(forced) = FORCE.with(|cell| cell.get()) {
        return forced;
    }
    match STATE.load(Ordering::Relaxed) {
        OFF => false,
        ON => true,
        _ => {
            let on = std::env::var("LOCALPRISM_DEBUG_USAGE").ok().as_deref() == Some("1");
            STATE.store(if on { ON } else { OFF }, Ordering::Relaxed);
            on
        }
    }
}

/// Log the last upstream usage object and the Anthropic usage derived from it.
/// Both lines share one request sequence. No-op unless debug is enabled.
pub(crate) fn log_translated(model: &str, raw: &Value, anthropic: &Value) {
    if !enabled() || raw.is_null() {
        return;
    }
    let seq = next_seq();
    write_record(model, seq, "upstream", raw);
    write_record(model, seq, "anthropic", anthropic);
}

/// Log the numbers the context panel is about to show. Drops every non-numeric
/// field so a caller cannot append a prompt or a secret through this command.
pub(crate) fn log_panel(model: &str, usage: &Value) {
    if !enabled() {
        return;
    }
    let usage = panel_numbers(usage);
    if usage.is_null() {
        return;
    }
    let seq = next_seq();
    write_record(model, seq, "panel", &usage);
}

fn next_seq() -> u64 {
    SEQ.fetch_add(1, Ordering::Relaxed) + 1
}

fn write_record(model: &str, seq: u64, stage: &str, usage: &Value) {
    let record = json!({
        "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "model": bounded_model(model),
        "seq": seq,
        "stage": stage,
        "usage": usage,
    });
    let Ok(line) = serde_json::to_string(&record) else {
        return;
    };
    let Ok(home) = crate::providers::paths::localprism_home() else {
        return;
    };
    let dir = home.join("logs");
    let path = dir.join("usage-debug.jsonl");
    let _guard = write_lock().lock().unwrap_or_else(|err| err.into_inner());
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    let _ = writeln!(file, "{line}");
}

fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn bounded_model(model: &str) -> String {
    model.trim().chars().take(128).collect()
}

fn panel_numbers(usage: &Value) -> Value {
    let Some(obj) = usage.as_object() else {
        return Value::Null;
    };
    let mut out = Map::new();
    for key in [
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheCreationTokens",
        "usedTokens",
        "windowTokens",
    ] {
        let Some(value) = obj.get(key).and_then(json_count) else {
            continue;
        };
        out.insert(key.to_string(), json!(value));
    }
    if out.is_empty() {
        Value::Null
    } else {
        Value::Object(out)
    }
}

fn json_count(value: &Value) -> Option<u64> {
    if let Some(number) = value.as_u64() {
        return Some(number);
    }
    if let Some(number) = value.as_i64() {
        return (number >= 0).then_some(number as u64);
    }
    value
        .as_f64()
        .filter(|number| number.is_finite() && *number >= 0.0)
        .map(|number| number as u64)
}

#[tauri::command]
pub fn usage_debug_enabled() -> bool {
    enabled()
}

#[tauri::command]
pub fn log_usage_debug_panel(model: String, usage: Value) {
    log_panel(&model, &usage);
}

#[cfg(test)]
pub(crate) fn force_for_test(enabled: Option<bool>) {
    FORCE.with(|cell| cell.set(enabled));
}

#[cfg(test)]
pub(crate) fn reset_seq_for_test() {
    SEQ.store(0, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::paths::lock_provider_env;
    use std::path::PathBuf;

    struct EnvRestore {
        previous: Option<String>,
    }

    impl EnvRestore {
        fn set(path: &std::path::Path) -> Self {
            let previous = std::env::var("LOCALPRISM_HOME").ok();
            std::env::set_var("LOCALPRISM_HOME", path);
            Self { previous }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("LOCALPRISM_HOME", value),
                None => std::env::remove_var("LOCALPRISM_HOME"),
            }
        }
    }

    struct ForceRestore;

    impl Drop for ForceRestore {
        fn drop(&mut self) {
            force_for_test(None);
        }
    }

    fn log_path(home: &std::path::Path) -> PathBuf {
        home.join("logs").join("usage-debug.jsonl")
    }

    #[test]
    fn disabled_debug_does_not_create_a_log() {
        let _lock = lock_provider_env();
        let home = tempfile::tempdir().unwrap();
        let _env = EnvRestore::set(home.path());
        let _force = ForceRestore;
        force_for_test(Some(false));
        reset_seq_for_test();

        let raw = json!({
            "input_tokens": 189600,
            "input_tokens_details": { "cached_tokens": 170000 },
            "output_tokens": 2965
        });
        let anthropic = json!({
            "input_tokens": 19600,
            "output_tokens": 2965,
            "cache_read_input_tokens": 170000,
            "cache_creation_input_tokens": 0
        });
        log_translated("gpt-6-luna", &raw, &anthropic);
        log_panel(
            "gpt-6-luna",
            &json!({
                "inputTokens": 19600,
                "prompt": "do not log this body",
                "authorization": "Bearer sk-test"
            }),
        );

        assert!(!log_path(home.path()).exists());
        assert_eq!(SEQ.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn enabled_debug_appends_usage_only() {
        let _lock = lock_provider_env();
        let home = tempfile::tempdir().unwrap();
        let _env = EnvRestore::set(home.path());
        let _force = ForceRestore;
        force_for_test(Some(true));
        reset_seq_for_test();

        let raw = json!({
            "input_tokens": 189600,
            "input_tokens_details": { "cached_tokens": 170000 },
            "output_tokens": 2965
        });
        let anthropic = json!({
            "input_tokens": 19600,
            "output_tokens": 2965,
            "cache_read_input_tokens": 170000,
            "cache_creation_input_tokens": 0
        });
        log_translated("gpt-6-luna", &raw, &anthropic);
        log_panel(
            "gpt-6-luna",
            &json!({
                "inputTokens": 19600,
                "outputTokens": 2965,
                "cacheReadTokens": 170000,
                "cacheCreationTokens": 0,
                "usedTokens": 192565,
                "windowTokens": 272000,
                "prompt": "Read main.tex SECRET",
                "authorization": "Bearer sk-live"
            }),
        );

        let text = std::fs::read_to_string(log_path(home.path())).unwrap();
        assert!(!text.contains("SECRET"));
        assert!(!text.contains("Bearer"));
        assert!(!text.contains("sk-live"));
        assert!(!text.contains("main.tex"));
        let lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
        assert_eq!(lines.len(), 3);
        let upstream: Value = serde_json::from_str(lines[0]).unwrap();
        let anthropic_line: Value = serde_json::from_str(lines[1]).unwrap();
        let panel: Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(upstream["stage"], "upstream");
        assert_eq!(anthropic_line["stage"], "anthropic");
        assert_eq!(panel["stage"], "panel");
        assert_eq!(upstream["model"], "gpt-6-luna");
        assert_eq!(upstream["seq"], 1);
        assert_eq!(anthropic_line["seq"], 1);
        assert_eq!(panel["seq"], 2);
        assert_eq!(upstream["usage"]["input_tokens"], 189600);
        assert_eq!(
            upstream["usage"]["input_tokens_details"]["cached_tokens"],
            170000
        );
        assert_eq!(anthropic_line["usage"]["cache_read_input_tokens"], 170000);
        assert_eq!(panel["usage"]["usedTokens"], 192565);
        assert_eq!(panel["usage"]["cacheReadTokens"], 170000);
        assert!(panel["usage"].get("prompt").is_none());
        assert!(upstream["ts"].as_str().unwrap().contains('T'));
    }
}
