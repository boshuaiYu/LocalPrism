import type { RuntimeSkill } from "@/runtime/types";

export interface SkillReplacePreview {
  folder: string;
  oldName: string;
  oldDescription: string;
  newName: string;
  newDescription: string;
}

export interface SkillImportPreview {
  conflicts: SkillReplacePreview[];
  added: string[];
}

export interface SkillImportOutcome {
  skills: RuntimeSkill[];
  added: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  errors: string[];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Accept the new outcome object and older mocks that still return a skill array. */
export function normalizeSkillImportOutcome(
  value: unknown,
): SkillImportOutcome {
  if (Array.isArray(value)) {
    const skills = value as RuntimeSkill[];
    return {
      skills,
      added: skills.map((skill) => skill.name).filter((name) => name.trim()),
      updated: [],
      unchanged: [],
      removed: [],
      errors: [],
    };
  }
  if (value && typeof value === "object") {
    const record = value as Partial<SkillImportOutcome>;
    return {
      skills: Array.isArray(record.skills) ? record.skills : [],
      added: stringList(record.added),
      updated: stringList(record.updated),
      unchanged: stringList(record.unchanged),
      removed: stringList(record.removed),
      errors: stringList(record.errors),
    };
  }
  return {
    skills: [],
    added: [],
    updated: [],
    unchanged: [],
    removed: [],
    errors: [],
  };
}

export function normalizeSkillImportPreview(
  value: unknown,
): SkillImportPreview {
  if (!value || typeof value !== "object") {
    return { conflicts: [], added: [] };
  }
  const record = value as {
    conflicts?: unknown;
    added?: unknown;
  };
  const conflicts = Array.isArray(record.conflicts)
    ? record.conflicts.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Partial<SkillReplacePreview>;
        return [
          {
            folder: typeof row.folder === "string" ? row.folder : "",
            oldName: typeof row.oldName === "string" ? row.oldName : "",
            oldDescription:
              typeof row.oldDescription === "string" ? row.oldDescription : "",
            newName: typeof row.newName === "string" ? row.newName : "",
            newDescription:
              typeof row.newDescription === "string" ? row.newDescription : "",
          },
        ];
      })
    : [];
  return { conflicts, added: stringList(record.added) };
}

export type ImportFeedback =
  | { kind: "latest" }
  | { kind: "updated"; names: string[] }
  | { kind: "imported"; names: string[] }
  | { kind: "error"; errors: string[] };

export function describeImportOutcome(
  outcome: SkillImportOutcome,
): ImportFeedback {
  const changed =
    outcome.added.length + outcome.updated.length + outcome.removed.length;
  if (
    outcome.errors.length > 0 &&
    changed === 0 &&
    outcome.unchanged.length === 0
  ) {
    return { kind: "error", errors: outcome.errors };
  }
  if (
    outcome.added.length === 0 &&
    outcome.updated.length === 0 &&
    outcome.removed.length === 0 &&
    outcome.unchanged.length > 0
  ) {
    return { kind: "latest" };
  }
  if (outcome.updated.length > 0 || outcome.removed.length > 0) {
    return {
      kind: "updated",
      names: [...outcome.updated, ...outcome.added],
    };
  }
  return { kind: "imported", names: outcome.added };
}
