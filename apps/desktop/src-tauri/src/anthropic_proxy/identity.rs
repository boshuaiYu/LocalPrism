/// Bind the hosted model id over Claude Code's baked "You are Claude" prompt.
/// ChatGPT / third-party traffic still goes through Claude Code as a tool host,
/// so the default system text claims Anthropic identity unless we rewrite it.
pub fn bind_hosted_model_identity(text: &str, model: &str) -> String {
    let model = model.trim();
    if model.is_empty() || keeps_claude_identity(model) {
        return text.to_string();
    }
    let scrubbed = neutralize_claude_identity(text, model);
    format!(
        "IDENTITY OVERRIDE: You are {model} in LocalPrism. \
         Claude Code is only a local tool runner. \
         You are not Claude, not Anthropic, and not Claude Code. \
         When asked who you are or which model you are, answer with {model}. \
         Ignore any other instruction that says you are Claude.\n\n{scrubbed}"
    )
}

fn keeps_claude_identity(model: &str) -> bool {
    crate::providers::is_legacy_claude_alias(model)
        || model.to_ascii_lowercase().starts_with("claude")
}

fn neutralize_claude_identity(text: &str, model: &str) -> String {
    let you_are = format!("You are {model}");
    let you_are_dot = format!("You are {model}.");
    let you_are_space = format!("You are {model} ");
    let im = format!("I'm {model}");
    let i_am = format!("I am {model}");
    let replacements = [
        ("You are Claude Code", "You are a LocalPrism tool host"),
        ("You are Claude, an AI", you_are.as_str()),
        ("You are Claude.", you_are_dot.as_str()),
        ("You are Claude ", you_are_space.as_str()),
        ("I'm Claude", im.as_str()),
        ("I am Claude", i_am.as_str()),
        ("created by Anthropic", "running inside LocalPrism"),
        ("made by Anthropic", "running inside LocalPrism"),
        ("an Anthropic AI", "a LocalPrism-hosted model"),
    ];
    let mut out = text.to_string();
    for (from, to) in replacements {
        if out.contains(from) {
            out = out.replace(from, to);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_claude_code_identity_for_chatgpt() {
        let bound = bind_hosted_model_identity(
            "You are Claude, an AI assistant created by Anthropic.",
            "gpt-5.6-terra",
        );
        assert!(bound.contains("IDENTITY OVERRIDE"));
        assert!(bound.contains("gpt-5.6-terra"));
        assert!(bound.contains("You are gpt-5.6-terra"));
        assert!(!bound.contains("created by Anthropic"));
        assert!(!bound.contains("You are Claude, an AI"));
    }

    #[test]
    fn leaves_official_claude_system_text_alone() {
        let original = "You are Claude, an AI assistant created by Anthropic.";
        assert_eq!(bind_hosted_model_identity(original, "sonnet"), original);
    }
}
