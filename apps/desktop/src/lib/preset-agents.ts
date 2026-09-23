import {
  isFatalSkillDiscoveryError,
  skillAssignmentId,
} from "@/lib/compatible-skills";
import {
  collectCitekeysFromProjectFiles,
  isBibliographyFile,
} from "@/lib/zotero-citekeys";
import type { AgentProfile, RuntimeSkill, SkillScope } from "@/runtime/types";

export type PresetAgentId = "academic-polish" | "de-ai" | "peer-review";

export interface PresetAgentDefinition {
  id: PresetAgentId;
  name: string;
  summaryZh: string;
  summaryEn: string;
  instructions: string;
}

const ACADEMIC_POLISH_INSTRUCTIONS = `You are an expert academic editor for LaTeX research papers (English or Chinese).
Goals: clarity, precision, concision, scholarly tone, coherent paragraph flow.
Hard rules:
- Preserve meaning, technical terms, numbers, units, statistics, and claim strength (do not strengthen or invent claims).
- Preserve LaTeX exactly: commands, environments, equations, labels, \\cite/\\citet/\\citep, BibTeX keys, figure/table refs, paths.
- Do not fabricate citations, data, results, or references.
- Prefer readable scholarly language over rare words or inflated rhetoric.
- If the user selected text, revise only that span; otherwise revise the provided excerpt.
- Output: (1) revised text ready to paste; (2) brief bullet list of notable edits (why).
When a latex-guard / academic-polish / citation skill is available, use it.`;

const DE_AI_INSTRUCTIONS = `You humanize academic prose (Chinese or English) for journal/thesis style.
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

const PEER_REVIEW_INSTRUCTIONS = `You are a senior peer reviewer for a top venue in the paper’s field.
Produce:
1) Reviewer 1 report: summary paragraph; major concerns (≥3, numbered, with why + where + concrete fix); minor concerns (2–4); recommendation (accept / minor / major / reject) with justification.
2) Reviewer 2 report: same structure, independent emphasis (e.g. methods vs clarity).
3) Editorial synthesis: one paragraph combining both; prioritized revision list.
Be frank, specific, actionable; quote or point to passages when possible.
If citation/bib/Zotero skills or project .bib are available, flag missing/unused/inconsistent citations.
Do not rewrite the whole paper unless asked; focus on critique.
Never invent papers or DOIs.`;

export const PRESET_AGENTS: readonly PresetAgentDefinition[] = [
  {
    id: "academic-polish",
    name: "润色",
    summaryZh: "提升清晰度、语法与学术语气，保留原意、LaTeX 与引用。",
    summaryEn:
      "Improve clarity, grammar, and academic tone while preserving meaning, LaTeX, and citations.",
    instructions: ACADEMIC_POLISH_INSTRUCTIONS,
  },
  {
    id: "de-ai",
    name: "去AI",
    summaryZh: "减弱模板化 AI 文风，不改动事实、数据与引用。",
    summaryEn:
      "Reduce template-like AI writing patterns without changing facts, data, or citations.",
    instructions: DE_AI_INSTRUCTIONS,
  },
  {
    id: "peer-review",
    name: "Peer Review",
    summaryZh: "投稿前的双审稿人模拟，并给出优先修改清单。",
    summaryEn:
      "Simulated dual peer review with a prioritized revision list before submission.",
    instructions: PEER_REVIEW_INSTRUCTIONS,
  },
];

export const PEER_REVIEW_AGENT_ID: PresetAgentId = "peer-review";

const BIBLIOGRAPHY_HEADING = "Project bibliography context:";

const PRESET_SKILL_PATTERNS: Record<PresetAgentId, readonly RegExp[]> = {
  "academic-polish": [
    /academic-polish/,
    /latex-guard/,
    /(?:^|[^a-z0-9])writing[-_]/,
    /(?:^|[^a-z0-9])citation/,
    /(?:^|[^a-z0-9])polish/,
  ],
  "de-ai": [
    /(?:^|[^a-z0-9])humanizer/,
    /(?:^|[^a-z0-9])reduce[-_]?ai/,
    /(?:^|[^a-z0-9])de[-_]?ai/,
  ],
  "peer-review": [
    /(?:^|[^a-z0-9])peer-review(?:[^a-z0-9]|$)/,
    /(?:^|[^a-z0-9])reviewer(?:[^a-z0-9]|$)/,
    /(?:^|[^a-z0-9])citation/,
    /(?:^|[^a-z0-9])bib/,
    /(?:^|[^a-z0-9])zotero/,
  ],
};

export interface ProjectTextFile {
  name?: string;
  relativePath?: string;
  type?: string;
  content?: string;
}

export interface BuildPresetAgentOptions {
  projectPath?: string | null;
}

function presetById(id: PresetAgentId): PresetAgentDefinition {
  const preset = PRESET_AGENTS.find((item) => item.id === id);
  if (!preset) {
    throw new Error(`Unknown agent preset: ${id}`);
  }
  return preset;
}

function skillIdentity(
  skill: Pick<RuntimeSkill, "id" | "name" | "folder">,
): string {
  return [skill.folder, skill.name, skill.id].join("\n").toLowerCase();
}

export function skillMatchesPreset(
  presetId: PresetAgentId,
  skill: Pick<RuntimeSkill, "id" | "name" | "folder">,
): boolean {
  const identity = skillIdentity(skill);
  return PRESET_SKILL_PATTERNS[presetId].some((pattern) =>
    pattern.test(identity),
  );
}

function isInstalledClaudeSkill(skill: RuntimeSkill): boolean {
  if (isFatalSkillDiscoveryError(skill.discoveryError)) return false;
  return skill.targets.some((target) => target.runtime === "claude");
}

function installedClaudeSkills(
  skills: readonly RuntimeSkill[],
): RuntimeSkill[] {
  return skills.filter(isInstalledClaudeSkill);
}

function hasClaudeScope(skill: RuntimeSkill, scope: SkillScope): boolean {
  return skill.targets.some(
    (target) => target.runtime === "claude" && target.scope === scope,
  );
}

export function presetSkillIds(
  presetId: PresetAgentId,
  skills: readonly RuntimeSkill[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const skill of installedClaudeSkills(skills)) {
    if (!skillMatchesPreset(presetId, skill)) continue;
    const id = skillAssignmentId(skill);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function bibliographyFileName(file: ProjectTextFile): string {
  return (
    file.name?.trim() ||
    file.relativePath?.split(/[\\/]/).pop()?.trim() ||
    "references.bib"
  );
}

export function projectBibliographyContext(
  files: readonly ProjectTextFile[] | null | undefined,
): string | null {
  if (!files?.length) return null;
  const bibFiles = files.filter((file) => isBibliographyFile(file));
  if (bibFiles.length === 0) return null;

  const keysByFile = new Map<string, string[]>();
  for (const file of bibFiles) {
    const name = bibliographyFileName(file);
    if (!keysByFile.has(name)) keysByFile.set(name, []);
  }
  for (const entry of collectCitekeysFromProjectFiles(files)) {
    const list = keysByFile.get(entry.bibFileName) ?? [];
    list.push(entry.citekey);
    keysByFile.set(entry.bibFileName, list);
  }

  const lines = [...keysByFile.entries()].map(([name, citekeys]) => {
    if (citekeys.length === 0) {
      return `- ${name} (read this file in the project; citekeys were not loaded)`;
    }
    const shown = citekeys.slice(0, 40);
    const extra =
      citekeys.length > shown.length
        ? ` (+${citekeys.length - shown.length} more)`
        : "";
    return `- ${name}: ${shown.join(", ")}${extra}`;
  });
  return [BIBLIOGRAPHY_HEADING, ...lines].join("\n");
}

export function appendPeerReviewBibliography(
  prompt: string,
  agentId: string | null | undefined,
  files: readonly ProjectTextFile[] | null | undefined,
): string {
  if (agentId?.trim() !== PEER_REVIEW_AGENT_ID) return prompt;
  const context = projectBibliographyContext(files);
  if (!context || prompt.includes(context)) return prompt;
  return `${prompt}\n\n${context}`;
}

export function buildPresetAgentProfile(
  presetId: PresetAgentId,
  skills: readonly RuntimeSkill[],
  options: BuildPresetAgentOptions = {},
): AgentProfile {
  const preset = presetById(presetId);
  const projectPath = options.projectPath?.trim() || "";
  const matched = installedClaudeSkills(skills).filter(
    (skill) =>
      skillMatchesPreset(presetId, skill) &&
      (hasClaudeScope(skill, "user") ||
        (Boolean(projectPath) && hasClaudeScope(skill, "project"))),
  );

  const skillIds: string[] = [];
  const seenIds = new Set<string>();
  for (const skill of matched) {
    const id = skillAssignmentId(skill);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    skillIds.push(id);
  }

  return {
    id: preset.id,
    runtime: "claude",
    scope: "user",
    name: preset.name,
    description: `${preset.summaryZh} ${preset.summaryEn}`,
    instructions: preset.instructions,
    model: null,
    reasoningEffort: null,
    sandboxMode: null,
    permissionMode: null,
    tools: [],
    nicknameCandidates: [],
    skillIds,
    sourcePath: "",
    unknownFields: {},
  };
}
