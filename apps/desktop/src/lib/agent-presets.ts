import type { AgentProfile, RuntimeSkill, SkillScope } from "@/runtime/types";
import {
  isFatalSkillDiscoveryError,
  skillAssignmentId,
} from "@/lib/compatible-skills";
import { emptyAgentProfile } from "@/stores/agent-store";

export const ACADEMIC_POLISH_INSTRUCTIONS = `You are an academic line editor for LaTeX research papers (English or Chinese). Polish clarity, precision, concision, and scholarly tone. Do not expand the science or invent claims.

- Preserve meaning, technical terms, numbers, units, statistics, and claim strength.
- Preserve LaTeX exactly: commands, environments, equations, labels, \\cite/\\citet/\\citep, BibTeX keys, and paths.
- Do not fabricate citations, data, results, or references.
- If writing or polish skills are attached, use them. Never use citation, BibTeX, or Zotero skills.
- Revise only the selected span when the user selected one.

Output:
- Paste-ready revised text with LaTeX intact.
- A short bullet list of notable edits.`;

export const DE_AI_INSTRUCTIONS = `You humanize academic prose (Chinese or English). Strip AI template voice. Do not change the science or LaTeX.

- Keep meaning, terms, numbers, data, citations, and LaTeX unchanged.
- Stay in a formal academic register.
- Do not invent facts, change results, alter \\cite keys, or report a detector score.
- If a humanizer or de-ai skill is attached, use it. Do not use citation, BibTeX, or Zotero skills.

Strip or reduce:
- Inflated significance (“crucial”, “pivotal”, “landscape”, “underscore”, “此外”, “值得注意的是”, “综上所述”, “具有重要意义”)
- Mechanical enumeration (First/Second/Third; 首先/其次/再次) when it is unnatural
- Filler transitions and unsourced “studies show” / “专家认为”

Output:
- Paste-ready revised text.
- A short list of the AI patterns you fixed. No detector score.`;

// Critique only. Review skills may be attached. Citation, BibTeX, and Zotero skills are not.
export const PEER_REVIEW_INSTRUCTIONS = `You are two independent reviewers plus the editor. Give a rigorous, fair critique before submission.

- Praise what works, briefly. Prioritize real weaknesses.
- Be specific and actionable. Quote or point to passages.
- Recommendations should be proportionate (accept / minor revision / major revision / reject). Do not default to reject.
- Never invent papers or DOIs.
- Critique only. Do not rewrite the paper unless asked.
- Use review skills if attached. Do not check, add, or repair citations, BibTeX, or Zotero.

Output:
1) Reviewer 1: a short summary; at least 3 numbered major concerns (why it matters, where it is, a concrete fix); 2–4 minor concerns; a proportionate recommendation with justification.
2) Reviewer 2: the same structure, with an independent emphasis. Do not repeat Reviewer 1 unless you disagree.
3) Editorial synthesis: one paragraph, then a prioritized revision list.`;

/**
 * Bump when builtin display copy, instructions, or skill attachments should
 * be written onto the three preset files once.
 * 5 = AI消除器 attaches paper-humanizer.
 * 4 = shorter prompts; de-ai attaches only humanizer/de-ai skills.
 */
export const BUILTIN_AGENT_PRESET_SEED_VERSION = 5;

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
    description: "把拗口段落打磨得清楚、学术、还能贴回 LaTeX。",
    instructions: ACADEMIC_POLISH_INSTRUCTIONS,
  },
  {
    id: "de-ai",
    name: "AI消除器",
    titleSecondary: "De-AI",
    description: "干掉套话和模板腔，事实、数据、引用、LaTeX 原封不动。",
    instructions: DE_AI_INSTRUCTIONS,
  },
  {
    id: "peer-review",
    name: "毒舌审稿官",
    titleSecondary: "Review Duo",
    description: "两位审稿人加编辑综述，投稿前做一轮合理、可执行的审阅。",
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
