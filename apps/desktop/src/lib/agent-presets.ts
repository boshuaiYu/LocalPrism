import type { AgentProfile, RuntimeSkill, SkillScope } from "@/runtime/types";
import {
  isFatalSkillDiscoveryError,
  skillAssignmentId,
} from "@/lib/compatible-skills";
import { emptyAgentProfile } from "@/stores/agent-store";

export const ACADEMIC_POLISH_INSTRUCTIONS = `You are an expert academic editor for LaTeX research papers (English or Chinese).
Goals: clarity, precision, concision, scholarly tone, coherent paragraph flow.
Hard rules:
- Preserve meaning, technical terms, numbers, units, statistics, and claim strength (do not strengthen or invent claims).
- Preserve LaTeX exactly: commands, environments, equations, labels, \\cite/\\citet/\\citep, BibTeX keys, figure/table refs, paths.
- Do not fabricate citations, data, results, or references.
- Prefer readable scholarly language over rare words or inflated rhetoric.
- If the user selected text, revise only that span; otherwise revise the provided excerpt.
- Output: (1) revised text ready to paste; (2) brief bullet list of notable edits (why).
When a latex-guard / academic-polish / citation skill is available, use it.`;

export const DE_AI_INSTRUCTIONS = `You humanize academic prose (Chinese or English) for journal/thesis style.
Process: (1) scan for AI patterns; (2) rewrite only problematic spans; (3) keep meaning, terms, data, citations, LaTeX; (4) keep formal academic register; (5) vary sentence rhythm; avoid empty significance claims.
Remove/reduce patterns such as:
- Inflated significance (“crucial”, “pivotal”, “landscape”, “此外/值得注意的是/综上所述/具有重要意义”)
- Mechanical enumeration (First/Second/Third; 首先/其次/再次) when unnatural
- Perfect triadic parallels and marketing adjectives
- Vague attributions (“studies show” / “专家认为”) without sources — delete or make concrete only if source already in text
- Chatbot tone, bold spam, emoji
Do NOT: invent facts; change results; alter \\cite keys; promise detector scores.
Output: revised text + short list of AI patterns you addressed.
Attach humanizer / reduce-ai-style skills if installed.`;

// Critique only. Citation, BibTeX, and Zotero checks are not part of this preset.
export const PEER_REVIEW_INSTRUCTIONS = `You are a senior peer reviewer for a top venue in the paper’s field.
Produce:
1) Reviewer 1 report: summary paragraph; major concerns (≥3, numbered, with why + where + concrete fix); minor concerns (2–4); recommendation (accept / minor / major / reject) with justification.
2) Reviewer 2 report: same structure, independent emphasis (e.g. methods vs clarity).
3) Editorial synthesis: one paragraph combining both; prioritized revision list.
Be frank, specific, actionable; quote or point to passages when possible.
Do not rewrite the whole paper unless asked; focus on critique.
Never invent papers or DOIs.`;

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
    name: "润色",
    titleSecondary: "Academic Polish",
    description:
      "提升清晰度、语法与学术语气，保留原意、LaTeX 与引用。 Improve clarity, grammar, and academic tone while preserving meaning, LaTeX, and citations.",
    instructions: ACADEMIC_POLISH_INSTRUCTIONS,
  },
  {
    id: "de-ai",
    name: "去AI",
    titleSecondary: "De-AI",
    description:
      "减弱模板化 AI 文风，不改事实、数据与引用。 Reduce template-like AI prose without changing facts, data, or citations.",
    instructions: DE_AI_INSTRUCTIONS,
  },
  {
    id: "peer-review",
    name: "Peer Review",
    titleSecondary: "审稿模拟",
    description:
      "以两位审稿人的视角给出具体、可执行的投稿前批评。 Simulate two reviewers with specific, actionable critique before submission.",
    instructions: PEER_REVIEW_INSTRUCTIONS,
  },
];

const CITATION_TOKENS = new Set([
  "bib",
  "bibtex",
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

function matchesWritingOrPolish(skill: RuntimeSkill): boolean {
  if (isCitationBibOrZoteroSkill(skill)) return false;
  const text = normalizedIdentity(skill);
  return (
    text.includes("polish") ||
    text.includes("latex-guard") ||
    identityTokens(skill).includes("writing")
  );
}

function matchesHumanizerOrDeAi(skill: RuntimeSkill): boolean {
  if (isCitationBibOrZoteroSkill(skill)) return false;
  const text = normalizedIdentity(skill);
  return (
    text.includes("humanizer") ||
    text.includes("humanize") ||
    text.includes("reduce-ai") ||
    text.includes("de-ai") ||
    /(^|[^a-z])deai([^a-z]|$)/.test(text)
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
 * 润色; humanizer/de-ai skills attach to 去AI. Peer Review stays critique-only.
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
