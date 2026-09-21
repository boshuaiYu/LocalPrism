import type { RuntimeKind, RuntimeSkill, SkillScope } from "@/runtime/types";

/** Legacy frontmatter notes are warnings, not broken skills. */
export function isFatalSkillDiscoveryError(
  error: string | null | undefined,
): boolean {
  if (!error?.trim()) return false;
  return !/legacy claude skill is missing/i.test(error);
}

/** Skills that have a destination for the same runtime and scope. */
export function skillsCompatibleWith(
  skills: RuntimeSkill[],
  runtime: RuntimeKind,
  scope: SkillScope,
): RuntimeSkill[] {
  if (runtime === "codex") {
    return [];
  }
  return skills.filter(
    (skill) =>
      !isFatalSkillDiscoveryError(skill.discoveryError) &&
      skill.targets.some(
        (target) => target.runtime === runtime && target.scope === scope,
      ),
  );
}

/** Prefer folder (native skill name) for agent assignment persistence. */
export function skillAssignmentId(skill: RuntimeSkill): string {
  return skill.folder || skill.id;
}

export function skillMatchesAssignmentId(
  skill: RuntimeSkill,
  skillId: string,
): boolean {
  return (
    skillAssignmentId(skill) === skillId ||
    skill.id === skillId ||
    skill.folder === skillId
  );
}

export function skillAssignmentAliases(skill: RuntimeSkill): string[] {
  return [
    ...new Set(
      [skillAssignmentId(skill), skill.id, skill.folder].filter(Boolean),
    ),
  ];
}
