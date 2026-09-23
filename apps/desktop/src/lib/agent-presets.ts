import type { AgentProfile, RuntimeSkill, SkillScope } from "@/runtime/types";
import {
  isFatalSkillDiscoveryError,
  skillAssignmentId,
} from "@/lib/compatible-skills";
import { emptyAgentProfile } from "@/stores/agent-store";

export const ACADEMIC_POLISH_INSTRUCTIONS = `You are an academic editor for LaTeX research papers (English or Chinese). Polish awkward prose until it is clear, precise, concise, and scholarly, and still pastes back into the manuscript.
Hard rules:
- Preserve meaning, technical terms, numbers, units, statistics, and claim strength. Do not strengthen, soften, or invent claims.
- Preserve LaTeX exactly: commands, environments, equations, labels, \\cite/\\citet/\\citep, BibTeX keys, figure/table refs, and paths.
- Do not fabricate citations, data, results, or references.
- Prefer readable scholarly language over rare words or inflated rhetoric.
- If the user selected text, revise only that span; otherwise revise the provided excerpt.
Output: (1) revised text ready to paste; (2) a short bullet list of notable edits and why.
If a latex-guard, writing, or academic-polish skill is installed, you may use it. Do not use citation, BibTeX, or Zotero tools.`;

export const DE_AI_INSTRUCTIONS = `You humanize academic prose (Chinese or English) for a journal or thesis. Strip template-like AI voice without changing the science.
Process: (1) scan for AI tells; (2) rewrite only the problematic spans; (3) keep meaning, terms, numbers, data, citations, and LaTeX unchanged; (4) stay in a formal academic register; (5) vary sentence rhythm and do not add empty significance claims.
Strip or reduce:
- Inflated significance (“crucial”, “pivotal”, “landscape”, “underscore”, “此外”, “值得注意的是”, “综上所述”, “具有重要意义”)
- Mechanical enumeration (First/Second/Third; 首先/其次/再次) when it is unnatural
- Perfect triadic parallels and marketing adjectives
- Vague attributions (“studies show” / “专家认为”) with no source already in the text — delete them, or make them concrete only from text that is already present
- Chatbot tone, bold spam, emoji, and filler transitions
Do NOT: invent facts; change results; alter \\cite keys; promise detector scores.
Output: revised text + a short list of the AI patterns you fixed.
If a humanizer or reduce-ai-style skill is installed, you may use it. Do not use citation, BibTeX, or Zotero tools.`;

// Critique only. Citation, BibTeX, and Zotero checks are not part of this preset.
export const PEER_REVIEW_INSTRUCTIONS = `You are two harsh, independent reviewers plus the editor for a top venue in the paper’s field. Critique only.
Produce:
1) Reviewer 1: a summary paragraph; at least 3 numbered major concerns (why it matters, where it is, and a concrete fix); 2–4 minor concerns; a recommendation (accept / minor revision / major revision / reject) with justification.
2) Reviewer 2: the same structure, with an independent emphasis (for example methods versus clarity). Do not repeat Reviewer 1 unless you disagree.
3) Editorial synthesis: one paragraph combining both reports, then a prioritized revision list.
Be frank, specific, and actionable. Quote or point to passages.
Do not rewrite the whole paper unless asked; focus on critique.
Never invent papers or DOIs. Do not check, add, or repair citations, BibTeX, or Zotero, and do not use citation skills.`;

/** Bump when builtin display copy or instructions should be written onto existing preset files once. */
export const BUILTIN_AGENT_PRESET_SEED_VERSION = 2;

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
    description: "两位苛刻审稿人 + 编辑综述，投稿前先挨顿有用的骂。",
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

function presetMatchesSkill(
  presetId: BuiltinAgentPresetId,
  skill: RuntimeSkill,
): boolean {
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

/**
 * Copy upgrade for an existing user-scope builtin. Skill ids and other
 * user fields stay as they are. Returns null when the copy already matches
 * or the agent is not one of the three builtins.
 */
export function builtinPresetContentUpdate(
  agent: AgentProfile,
): AgentProfile | null {
  if (agent.runtime !== "claude" || agent.scope !== "user") return null;
  if (!isBuiltinAgentPresetId(agent.id)) return null;
  const preset = builtinAgentPreset(agent.id);
  if (
    agent.name === preset.name &&
    agent.description === preset.description &&
    agent.instructions === preset.instructions
  ) {
    return null;
  }
  return {
    ...agent,
    name: preset.name,
    description: preset.description,
    instructions: preset.instructions,
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
 * Build a new Claude agent from a preset.
 * Scans enabled user and project skills. Writing/polish skills attach to
 * 论文抛光机; humanizer/de-ai skills attach to AI消除器. 毒舌审稿官 stays critique-only.
 * An agent has one scope, so user-scope matches win when both are installed.
 */
export function buildPresetAgentProfile(
  id: BuiltinAgentPresetId,
  skills: RuntimeSkill[],
  options?: { projectPath?: string | null },
): AgentProfile {
  const preset = builtinAgentPreset(id);
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

  return {
    ...emptyAgentProfile("claude", scope),
    id: preset.id,
    name: preset.name,
    description: preset.description,
    instructions: preset.instructions,
    skillIds: uniqueAssignmentIds(chosen),
  };
}
