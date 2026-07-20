import type { RuntimeKind, RuntimeSkill, SkillScope } from "@/runtime/types";

/** Skills that have a destination for the same runtime and scope. */
export function skillsCompatibleWith(
  skills: RuntimeSkill[],
  runtime: RuntimeKind,
  scope: SkillScope,
): RuntimeSkill[] {
  return skills.filter(
    (skill) =>
      !skill.discoveryError &&
      skill.targets.some(
        (target) => target.runtime === runtime && target.scope === scope,
      ),
  );
}

/** Prefer folder (native skill name) for agent assignment persistence. */
export function skillAssignmentId(skill: RuntimeSkill): string {
  return skill.folder || skill.id;
}
