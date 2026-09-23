import type { AgentProfile, RuntimeSkill, SkillScope } from "@/runtime/types";
import {
  isFatalSkillDiscoveryError,
  skillAssignmentId,
} from "@/lib/compatible-skills";
import { emptyAgentProfile } from "@/stores/agent-store";

export const ACADEMIC_POLISH_INSTRUCTIONS = `你是一个学术 LaTeX 论文润色的智能体。你主要负责对中文或英文研究论文做行级修改：提高清晰度、准确性、简洁性和学术语气。不扩展科学内容，不编造论断。

你有这些工具和能力：
- 已挂载的润色与写作技能，包括 nature-polishing、nature-writing、academic-paper，以及名称中含 polish 或 writing 的已启用技能。
- 不使用引用、BibTeX 或 Zotero 技能。

工作规则：
- 保持原意、术语、数字、单位、统计量和论断强度。
- 原样保留 LaTeX：命令、环境、公式、标签、\\cite/\\citet/\\citep、BibTeX 键和路径。
- 不编造引用、数据、结果或参考文献。
- 用户选中了片段时，只修改该片段。

输出：
- 可直接粘贴的修订文本，LaTeX 保持完整。
- 简短列出值得注意的修改。`;

export const DE_AI_INSTRUCTIONS = `你是一个学术文本去模板化的智能体。你主要负责处理中文或英文论文中的模板化表述，使其更接近人工学术写作。不改变科学内容，不改变 LaTeX。

你有这些工具和能力：
- 已挂载的人类化技能，包括 paper-humanizer、paper-humanizer-skill，以及名称中含 humanizer 或 de-ai 的已启用技能。
- 不使用 nature-polishing，也不使用引用、BibTeX 或 Zotero 技能。

工作规则：
- 保持原意、术语、数字、数据、引用和 LaTeX 不变。
- 保持正式学术语体。
- 不编造事实，不改动结果，不改动 \\cite 键，不报告检测分数。

需要削弱的模式：
- 夸大意义的套话（crucial、pivotal、landscape、underscore、此外、值得注意的是、综上所述、具有重要意义）
- 不自然的机械枚举（First/Second/Third；首先/其次/再次）
- 空泛过渡，以及没有来源的“研究表明”“专家认为”

输出：
- 可直接粘贴的修订文本。
- 简短列出已处理的模板化表述。不报告检测分数。`;

// Critique only. Review skills may be attached. Citation, BibTeX, and Zotero skills are not.
export const PEER_REVIEW_INSTRUCTIONS = `你是一个论文审稿的智能体。你主要负责在投稿前给出严谨、公正、可执行的审阅意见，结构为两份独立审稿和一份编辑综述。

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
3) 编辑综述：一段总结，然后是按优先级排列的修改清单。`;

/**
 * Bump when builtin display copy, instructions, or skill attachments should
 * be written onto the three preset files once.
 * 6 = objective Chinese role, responsibilities, and tools.
 * 5 = AI消除器 attaches paper-humanizer.
 * 4 = shorter prompts; de-ai attaches only humanizer/de-ai skills.
 */
export const BUILTIN_AGENT_PRESET_SEED_VERSION = 6;

/**
 * Shipped skill folders from the default packs (nature-skills,
 * academic-research-skills, paper-humanizer-skill). Citation folders are
 * intentionally absent. AI消除器 attaches paper-humanizer, plus a dynamic
 * humanizer/de-ai match. 毒舌审稿官 stays critique-only: review skills, never
 * cite/BibTeX/Zotero. nature-polishing stays on 论文抛光机.
 */
export const BUILTIN_AGENT_SKILL_FOLDERS: Record<
  BuiltinAgentPresetId,
  readonly string[]
> = {
  "academic-polish": ["nature-polishing", "nature-writing", "academic-paper"],
  "de-ai": ["paper-humanizer", "paper-humanizer-skill"],
  "peer-review": ["academic-paper-reviewer", "peer-review", "nature-reader"],
};

export type BuiltinAgentPresetId = "academic-polish" | "de-ai" | "peer-review";

export interface BuiltinAgentPreset {
  id: BuiltinAgentPresetId;
  name: string;
  titleSecondary: string;
  description: string;
  instructions: string;
}

export const BUILTIN_AGENT_PRESETS: readonly BuiltinAgentPreset[] = [
  {
    id: "academic-polish",
    name: "论文抛光机",
    titleSecondary: "Polish Lab",
    description:
      "你是一个学术 LaTeX 文本润色的智能体。你主要负责在不改变原意、数据和引用的前提下，提高表述的清晰度、准确性和学术语气。你有 nature-polishing、nature-writing、academic-paper 等润色与写作技能。",
    instructions: ACADEMIC_POLISH_INSTRUCTIONS,
  },
  {
    id: "de-ai",
    name: "AI消除器",
    titleSecondary: "De-AI",
    description:
      "你是一个学术文本去模板化的智能体。你主要负责削弱套话和模板化表述，同时保持事实、数据、引用和 LaTeX 不变。你有 paper-humanizer 等人类化写作技能。",
    instructions: DE_AI_INSTRUCTIONS,
  },
  {
    id: "peer-review",
    name: "毒舌审稿官",
    titleSecondary: "Review Duo",
    description:
      "你是一个论文审稿的智能体。你主要负责在投稿前给出具体、可执行的审阅意见，不默认改写正文。你有 academic-paper-reviewer、peer-review、nature-reader 等审稿技能。",
    instructions: PEER_REVIEW_INSTRUCTIONS,
  },
];

const CITATION_TOKENS = new Set([
  "bib",
  "bibtex",
  "cite",
  "citing",
  "citation",
  "citations",
  "zotero",
]);

function normalizedIdentity(skill: RuntimeSkill): string {
  return [skill.id, skill.folder, skill.name]
    .join(" ")
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

function identityTokens(skill: RuntimeSkill): string[] {
  return normalizedIdentity(skill)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Citation, BibTeX, and Zotero skills are never auto-attached to presets. */
function isCitationBibOrZoteroSkill(skill: RuntimeSkill): boolean {
  return identityTokens(skill).some((token) => CITATION_TOKENS.has(token));
}

function hasBoundedPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
}

function matchesWritingOrPolish(skill: RuntimeSkill): boolean {
  if (isCitationBibOrZoteroSkill(skill)) return false;
  const text = normalizedIdentity(skill);
  const tokens = identityTokens(skill);
  return (
    tokens.some((token) => token.startsWith("polish")) ||
    hasBoundedPhrase(text, "latex-guard") ||
    tokens.includes("writing")
  );
}

function matchesHumanizerOrDeAi(skill: RuntimeSkill): boolean {
  if (isCitationBibOrZoteroSkill(skill)) return false;
  const text = normalizedIdentity(skill);
  const tokens = identityTokens(skill);
  return (
    tokens.some((token) => token.startsWith("humaniz")) ||
    hasBoundedPhrase(text, "reduce-ai") ||
    hasBoundedPhrase(text, "de-ai") ||
    tokens.some((token) => token === "deai" || token.startsWith("deai"))
  );
}

function isShippedPresetSkill(
  presetId: BuiltinAgentPresetId,
  skill: RuntimeSkill,
): boolean {
  const folder = skill.folder.trim().toLowerCase();
  return BUILTIN_AGENT_SKILL_FOLDERS[presetId].some(
    (name) => name.toLowerCase() === folder,
  );
}

function presetMatchesSkill(
  presetId: BuiltinAgentPresetId,
  skill: RuntimeSkill,
): boolean {
  if (isCitationBibOrZoteroSkill(skill)) return false;
  if (isShippedPresetSkill(presetId, skill)) return true;
  if (presetId === "peer-review") return false;
  if (presetId === "academic-polish") return matchesWritingOrPolish(skill);
  if (presetId === "de-ai") return matchesHumanizerOrDeAi(skill);
  return false;
}

function isInstalledForScope(
  skill: RuntimeSkill,
  scope: SkillScope,
  projectPath?: string | null,
): boolean {
  if (!skill.enabled) return false;
  if (scope === "project" && !projectPath) return false;
  if (isFatalSkillDiscoveryError(skill.discoveryError)) return false;
  return skill.targets.some(
    (target) => target.runtime === "claude" && target.scope === scope,
  );
}

function uniqueAssignmentIds(skills: RuntimeSkill[]): string[] {
  const ids: string[] = [];
  for (const skill of skills) {
    const id = skillAssignmentId(skill);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** User-scope preset ids that are not already saved. Existing ids are left alone. */
export function builtinPresetIdsToSeed(
  agents: readonly { id: string; scope?: string }[],
): BuiltinAgentPresetId[] {
  const installed = new Set(
    agents.filter((agent) => agent.scope === "user").map((agent) => agent.id),
  );
  return BUILTIN_AGENT_PRESETS.map((preset) => preset.id).filter(
    (id) => !installed.has(id),
  );
}

/**
 * Profiles to create on first seed. No project path, so presets stay user-scoped
 * and only already-installed user skills are attached. Peer Review stays
 * critique-only. Citation, BibTeX, and Zotero skills are never attached.
 */
export function builtinPresetProfilesToSeed(
  agents: readonly { id: string; scope?: string }[],
  skills: RuntimeSkill[],
): AgentProfile[] {
  return builtinPresetIdsToSeed(agents).map((id) =>
    buildPresetAgentProfile(id, skills),
  );
}

export function isBuiltinAgentPresetId(id: string): id is BuiltinAgentPresetId {
  return BUILTIN_AGENT_PRESETS.some((preset) => preset.id === id);
}

function sameSkillIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

/**
 * Copy upgrade for an existing user-scope builtin. Refreshes name,
 * description, instructions, and skillIds from the current install.
 * Scope, model, and other fields stay. Returns null when nothing changed
 * or the agent is not one of the three builtins. Custom agents are ignored.
 */
export function builtinPresetContentUpdate(
  agent: AgentProfile,
  skills: RuntimeSkill[] = [],
): AgentProfile | null {
  if (agent.runtime !== "claude" || agent.scope !== "user") return null;
  if (!isBuiltinAgentPresetId(agent.id)) return null;
  const preset = builtinAgentPreset(agent.id);
  const skillIds = presetSkillAttachment(agent.id, skills).skillIds;
  if (
    agent.name === preset.name &&
    agent.description === preset.description &&
    agent.instructions === preset.instructions &&
    sameSkillIds(agent.skillIds, skillIds)
  ) {
    return null;
  }
  return {
    ...agent,
    name: preset.name,
    description: preset.description,
    instructions: preset.instructions,
    skillIds,
  };
}

export function builtinAgentPreset(
  id: BuiltinAgentPresetId,
): BuiltinAgentPreset {
  const preset = BUILTIN_AGENT_PRESETS.find((item) => item.id === id);
  if (!preset) {
    throw new Error(`Unknown agent preset: ${id}`);
  }
  return preset;
}

/**
 * Enabled skills that belong on a preset. Writing/polish skills attach to
 * 论文抛光机. AI消除器 gets only a dynamic humanizer/de-ai match, never
 * nature-polishing. 毒舌审稿官 gets review skills only, never citation/BibTeX/Zotero.
 * An agent has one scope, so user-scope matches win when both are installed.
 */
function presetSkillAttachment(
  id: BuiltinAgentPresetId,
  skills: RuntimeSkill[],
  options?: { projectPath?: string | null },
): { scope: SkillScope; skillIds: string[] } {
  const projectPath = options?.projectPath;
  const userSkills = skills.filter(
    (skill) =>
      isInstalledForScope(skill, "user", projectPath) &&
      presetMatchesSkill(id, skill),
  );
  const projectSkills = skills.filter(
    (skill) =>
      isInstalledForScope(skill, "project", projectPath) &&
      presetMatchesSkill(id, skill),
  );
  const scope: SkillScope =
    userSkills.length > 0 || projectSkills.length === 0 ? "user" : "project";
  const chosen = scope === "project" ? projectSkills : userSkills;
  return { scope, skillIds: uniqueAssignmentIds(chosen) };
}

export function buildPresetAgentProfile(
  id: BuiltinAgentPresetId,
  skills: RuntimeSkill[],
  options?: { projectPath?: string | null },
): AgentProfile {
  const preset = builtinAgentPreset(id);
  const attached = presetSkillAttachment(id, skills, options);
  return {
    ...emptyAgentProfile("claude", attached.scope),
    id: preset.id,
    name: preset.name,
    description: preset.description,
    instructions: preset.instructions,
    skillIds: attached.skillIds,
  };
}
