//! Offline copies of the three built-in Claude agents.
//!
//! These files are the same presets as `src/lib/agent-presets.ts`
//! (`academic-polish`, `de-ai`, `peer-review`). They are written into the
//! data home so a fresh macOS/Linux/Windows home does not depend on GitHub
//! or on the webview settings seed.

use super::claude;
use super::{AgentError, AgentProfile};
use crate::runtime::RuntimeKind;
use crate::skills::domain::SkillScope;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_AGENT_IDS: &[&str] = &["academic-polish", "de-ai", "peer-review"];

const SEEDED_MARKER: &str = ".default-agents-seeded";
const SEEDING_MARKER: &str = ".default-agents-seeding";

const ACADEMIC_POLISH_INSTRUCTIONS: &str = r#"你是一个学术 LaTeX 论文润色的智能体。你主要负责对中文或英文研究论文做行级修改：提高清晰度、准确性、简洁性和学术语气。不扩展科学内容，不编造论断。

你有这些工具和能力：
- 已挂载的润色与写作技能，包括 nature-polishing、nature-writing、academic-paper，以及名称中含 polish 或 writing 的已启用技能。
- 不使用引用、BibTeX 或 Zotero 技能。

工作规则：
- 保持原意、术语、数字、单位、统计量和论断强度。
- 原样保留 LaTeX：命令、环境、公式、标签、\cite/\citet/\citep、BibTeX 键和路径。
- 不编造引用、数据、结果或参考文献。
- 用户选中了片段时，只修改该片段。

输出：
- 可直接粘贴的修订文本，LaTeX 保持完整。
- 简短列出值得注意的修改。"#;

const DE_AI_INSTRUCTIONS: &str = r#"你是一个学术文本去模板化的智能体。你主要负责处理中文或英文论文中的模板化表述，使其更接近人工学术写作。不改变科学内容，不改变 LaTeX。

你有这些工具和能力：
- 已挂载的人类化技能，包括 paper-humanizer、paper-humanizer-skill，以及名称中含 humanizer 或 de-ai 的已启用技能。
- 不使用 nature-polishing，也不使用引用、BibTeX 或 Zotero 技能。

工作规则：
- 保持原意、术语、数字、数据、引用和 LaTeX 不变。
- 保持正式学术语体。
- 不编造事实，不改动结果，不改动 \cite 键，不报告检测分数。

需要削弱的模式：
- 夸大意义的套话（crucial、pivotal、landscape、underscore、此外、值得注意的是、综上所述、具有重要意义）
- 不自然的机械枚举（First/Second/Third；首先/其次/再次）
- 空泛过渡，以及没有来源的“研究表明”“专家认为”

输出：
- 可直接粘贴的修订文本。
- 简短列出已处理的模板化表述。不报告检测分数。"#;

const PEER_REVIEW_INSTRUCTIONS: &str = r#"你是一个论文审稿的智能体。你主要负责在投稿前给出严谨、公正、可执行的审阅意见，结构为两份独立审稿和一份编辑综述。

你有这些工具和能力：
- 已挂载的审稿技能，包括 academic-paper-reviewer、peer-review、nature-reader。
- 只做审阅。不检查、不添加、不修复引用、BibTeX 或 Zotero。

工作规则：
- 简要肯定有效部分，优先指出真实弱点。
- 意见要具体、可执行，并指向相应段落。
- 建议与稿件质量相称（接收 / 小修 / 大修 / 拒稿），不以拒稿为默认结论。
- 不编造论文或 DOI。
- 除非用户要求，否则不改写论文。

输出：
1) 审稿人 1：简短摘要；至少 3 条编号的主要问题（为何重要、位于何处、具体改法）；2–4 条次要问题；与稿件相称的建议及理由。
2) 审稿人 2：同样结构，侧重点独立。除非不同意，否则不重复审稿人 1。
3) 编辑综述：一段总结，然后是按优先级排列的修改清单。"#;

fn empty_profile(id: &str, name: &str, description: &str, instructions: &str) -> AgentProfile {
    AgentProfile {
        id: id.to_string(),
        runtime: RuntimeKind::Claude,
        scope: SkillScope::User,
        name: name.to_string(),
        description: description.to_string(),
        instructions: instructions.to_string(),
        model: None,
        reasoning_effort: None,
        sandbox_mode: None,
        permission_mode: None,
        tools: Vec::new(),
        nickname_candidates: Vec::new(),
        skill_ids: Vec::new(),
        source_path: String::new(),
        unknown_fields: BTreeMap::new(),
    }
}

pub(super) fn default_agent_profiles() -> Vec<AgentProfile> {
    vec![
        empty_profile(
            "academic-polish",
            "论文抛光机",
            "你是一个学术 LaTeX 文本润色的智能体。你主要负责在不改变原意、数据和引用的前提下，提高表述的清晰度、准确性和学术语气。你有 nature-polishing、nature-writing、academic-paper 等润色与写作技能。",
            ACADEMIC_POLISH_INSTRUCTIONS,
        ),
        empty_profile(
            "de-ai",
            "AI消除器",
            "你是一个学术文本去模板化的智能体。你主要负责削弱套话和模板化表述，同时保持事实、数据、引用和 LaTeX 不变。你有 paper-humanizer 等人类化写作技能。",
            DE_AI_INSTRUCTIONS,
        ),
        empty_profile(
            "peer-review",
            "毒舌审稿官",
            "你是一个论文审稿的智能体。你主要负责在投稿前给出具体、可执行的审阅意见，不默认改写正文。你有 academic-paper-reviewer、peer-review、nature-reader 等审稿技能。",
            PEER_REVIEW_INSTRUCTIONS,
        ),
    ]
}

fn agent_file(agents_dir: &Path, id: &str) -> PathBuf {
    agents_dir.join(format!("{id}.md"))
}

fn write_marker(path: &Path) -> Result<(), AgentError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            AgentError::from(format!("Failed to create {}: {error}", parent.display()))
        })?;
    }
    fs::write(path, b"1\n")
        .map_err(|error| AgentError::from(format!("Failed to write {}: {error}", path.display())))
}

/// Install the three built-in agents into `claude-home/agents` when this data
/// home has never had them. Existing files are left alone. After the home is
/// marked seeded, deleted presets stay deleted.
pub fn ensure_default_user_agents() -> Result<(), AgentError> {
    let agents_dir = crate::providers::paths::user_agents_dir().map_err(AgentError::from)?;
    fs::create_dir_all(&agents_dir).map_err(|error| {
        AgentError::from(format!(
            "Failed to create {}: {error}",
            agents_dir.display()
        ))
    })?;
    let claude_home = agents_dir
        .parent()
        .ok_or_else(|| AgentError::from("User agents directory is missing a parent directory"))?;
    let seeded = claude_home.join(SEEDED_MARKER);
    if seeded.is_file() {
        return Ok(());
    }
    let seeding = claude_home.join(SEEDING_MARKER);
    let resume = seeding.is_file();
    if !resume
        && DEFAULT_AGENT_IDS
            .iter()
            .any(|id| agent_file(&agents_dir, id).is_file())
    {
        return write_marker(&seeded);
    }
    if !resume {
        write_marker(&seeding)?;
    }
    for profile in default_agent_profiles() {
        let path = agent_file(&agents_dir, &profile.id);
        if path.exists() {
            continue;
        }
        claude::write_claude_agent(&path, &profile)?;
    }
    write_marker(&seeded)?;
    let _ = fs::remove_file(&seeding);
    Ok(())
}
