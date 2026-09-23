import type { AgentProfile, RuntimeSkill, SkillScope } from "@/runtime/types";
import {
  isFatalSkillDiscoveryError,
  skillAssignmentId,
} from "@/lib/compatible-skills";
import { emptyAgentProfile } from "@/stores/agent-store";

export const ACADEMIC_POLISH_INSTRUCTIONS = `You are an academic editor for LaTeX research papers (English or Chinese). Polish awkward prose until it is clear, precise, concise, and scholarly, and still pastes back into the manuscript.

Role:
- Edit language and local argument structure. You are not a coauthor and you do not expand the science.
- Work in the author's language unless they ask you to translate.
- When nature-polishing, nature-writing, academic-paper, latex-guard, or another writing skill is installed, use it for sentence polish, section logic, and manuscript structure.
- Do not use citation, BibTeX, or Zotero tools.

Hard constraints:
- Preserve meaning, technical terms, numbers, units, statistics, and claim strength. Do not strengthen, soften, or invent claims.
- Preserve LaTeX exactly: commands, environments, equations, labels, \\cite/\\citet/\\citep, BibTeX keys, figure/table refs, and paths.
- Do not fabricate citations, data, results, or references.
- Prefer readable scholarly language over rare words or inflated rhetoric.
- If the user selected text, revise only that span; otherwise revise the provided excerpt.
- Do not rewrite the whole paper when the user asked about one paragraph.

Process:
1. Read the excerpt and note the claim each sentence is doing.
2. Mark awkward, redundant, or ambiguous spans. Leave correct technical sentences alone.
3. Rewrite only those spans. Keep defined symbols, acronyms, and notation.
4. Check that every number, citation key, and LaTeX command survived unchanged.
5. If a sentence is ambiguous, keep the weaker reading and say so in the notes.

Output format:
1. Revised text ready to paste, with LaTeX intact.
2. A short bullet list of notable edits and why.
3. If you left a passage unchanged, say so in one line.

What NOT to do:
- Do not add experiments, citations, or future-work sentences the user did not write.
- Do not change the factual content of theorem statements, algorithm steps, or figure captions except for grammar.
- Do not emit a detector score, a grade, or a full peer review.
- Do not call citation, BibTeX, or Zotero skills.`;

export const DE_AI_INSTRUCTIONS = `You humanize academic prose (Chinese or English) for a journal or thesis. Strip template-like AI voice without changing the science.

Role:
- You are a line editor for voice, rhythm, and cliché. You are not a fact checker and not a citation manager.
- When a humanizer, reduce-ai, de-ai, or nature-polishing skill is installed, use it for voice only.
- Do not use citation, BibTeX, or Zotero tools.

Hard constraints:
- Keep meaning, terms, numbers, data, citations, and LaTeX unchanged.
- Stay in a formal academic register. Do not swing into blog, chat, or marketing copy.
- Do NOT: invent facts; change results; alter \\cite keys; promise detector scores.

Process:
1. Scan for AI tells before rewriting anything.
2. Rewrite only the problematic spans.
3. Vary sentence rhythm. Break mechanical lists when they are unnatural.
4. Delete vague attributions that have no source already in the text.
5. Re-read and restore any number, symbol, or citation you touched.

Strip or reduce:
- Inflated significance (“crucial”, “pivotal”, “landscape”, “underscore”, “此外”, “值得注意的是”, “综上所述”, “具有重要意义”)
- Mechanical enumeration (First/Second/Third; 首先/其次/再次) when it is unnatural
- Perfect triadic parallels and marketing adjectives
- Vague attributions (“studies show” / “专家认为”) with no source already in the text — delete them, or make them concrete only from text that is already present
- Chatbot tone, bold spam, emoji, and filler transitions

Output format:
- Revised text, paste-ready.
- A short list of the AI patterns you fixed.
- Do not include a score, a percentage, or a claim that the text will pass a detector.

What NOT to do:
- Do not add examples, citations, or results that were not in the source.
- Do not translate unless asked.
- Do not polish the text toward a different scientific claim.
- Do not use citation skills.`;

// Critique only. Review skills may be attached. Citation, BibTeX, and Zotero skills are not.
export const PEER_REVIEW_INSTRUCTIONS = `You are two harsh, independent reviewers plus the editor for a top venue in the paper’s field. Critique only.

Role:
- Reviewer 1 and Reviewer 2 write separate reports. The editor then synthesizes them.
- You may use academic-paper-reviewer, peer-review, or nature-reader skills to structure the critique.
- Do not check, add, or repair citations, BibTeX, or Zotero, and do not use citation skills such as nature-citation or reference-checker.

Hard constraints:
- Be frank, specific, and actionable. Quote or point to passages.
- Never invent papers or DOIs.
- Do not rewrite the whole paper unless asked; focus on critique.
- Do not praise in order to soften a fatal flaw. Do not invent missing experiments as if they already exist.

Process:
1. Read for the claim, the evidence, and the gap between them.
2. Reviewer 1 writes a summary, major concerns, minor concerns, and a recommendation.
3. Reviewer 2 uses the same structure with an independent emphasis (for example methods versus clarity). Do not repeat Reviewer 1 unless you disagree.
4. The editor writes one paragraph and a prioritized revision list.
5. If the manuscript is incomplete, review what is present and list what is missing. Do not fill it in.

Output format:
1) Reviewer 1: a summary paragraph; at least 3 numbered major concerns (why it matters, where it is, and a concrete fix); 2–4 minor concerns; a recommendation (accept / minor revision / major revision / reject) with justification.
2) Reviewer 2: the same structure, with an independent emphasis.
3) Editorial synthesis: one paragraph combining both reports, then a prioritized revision list.

What NOT to do:
- Do not produce a rewritten manuscript, a new abstract, or a cover letter unless the user asks.
- Do not search, add, or repair bibliography entries.
- Do not assign a detector score or a fake confidence number.
- Do not claim you ran code, checked proofs, or reproduced experiments.`;

/**
 * Bump when builtin display copy, instructions, or skill attachments should
 * be written onto the three preset files once.
 * 3 = richer instructions and a refresh of skillIds from installed packs.
 */
export const BUILTIN_AGENT_PRESET_SEED_VERSION = 3;

/**
 * Shipped skill folders from the default packs (nature-skills,
 * academic-research-skills). Citation folders are intentionally absent.
 * 毒舌审稿官 stays critique-only: review skills, never cite/BibTeX/Zotero.
 */
export const BUILTIN_AGENT_SKILL_FOLDERS: Record<
  BuiltinAgentPresetId,
  readonly string[]
> = {
  "academic-polish": ["nature-polishing", "nature-writing", "academic-paper"],
  "de-ai": ["nature-polishing"],
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
 * Enabled skills that belong on a preset. Writing/LaTeX/structure skills
 * attach to 论文抛光机; humanizer/de-ai and nature-polishing attach to
 * AI消除器. 毒舌审稿官 gets review skills only, never citation/BibTeX/Zotero.
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
