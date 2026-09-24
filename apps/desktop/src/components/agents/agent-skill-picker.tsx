import { useMemo, useState } from "react";
import type { RuntimeSkill } from "@/runtime/types";
import {
  skillAssignmentId,
  skillMatchesAssignmentId,
} from "@/lib/compatible-skills";
import { groupItemsBySkillCategory } from "@/lib/skill-categories";
import { useI18n } from "@/lib/use-i18n";
import { Input } from "@/components/ui/input";

export function isSkillAssigned(
  skill: RuntimeSkill,
  selectedIds: readonly string[],
): boolean {
  return selectedIds.some((skillId) =>
    skillMatchesAssignmentId(skill, skillId),
  );
}

function skillSearchText(skill: RuntimeSkill): string {
  return [
    skill.name,
    skill.folder,
    skill.id,
    skill.description,
    skill.category ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

export function AgentSkillPicker({
  skills,
  selectedIds,
  onToggle,
}: {
  skills: RuntimeSkill[];
  selectedIds: readonly string[];
  onToggle: (skillId: string, enabled: boolean) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const visible = useMemo(() => {
    if (!needle) return skills;
    return skills.filter((skill) => skillSearchText(skill).includes(needle));
  }, [needle, skills]);

  const selected = visible.filter((skill) =>
    isSkillAssigned(skill, selectedIds),
  );
  const unselected = visible.filter(
    (skill) => !isSkillAssigned(skill, selectedIds),
  );
  const groups = useMemo(
    () =>
      groupItemsBySkillCategory(
        unselected,
        (skill) => ({
          folder: skill.folder,
          name: skill.name,
          category: skill.category,
          sourceUrl: skill.sourceUrl,
        }),
        { categories: [], assignments: {} },
        [],
      ),
    [unselected],
  );

  return (
    <div
      className="space-y-2"
      data-testid="agent-skill-picker"
      data-tour="tour-agent-skills"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Input
        id="agent-skill-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("skills.searchPlaceholder")}
        aria-label={t("skills.searchLabel")}
      />
      <p className="text-muted-foreground text-xs">
        {t("skills.selectedShown", {
          selected: selectedIds.length,
          shown: visible.length,
        })}
      </p>
      <div className="space-y-3 rounded-md border border-border p-2">
        {selected.length > 0 && (
          <SkillGroup
            title={t("skills.selectedGroup")}
            skills={selected}
            selectedIds={selectedIds}
            onToggle={onToggle}
          />
        )}
        {groups.map((group) => (
          <SkillGroup
            key={group.id}
            title={
              group.id === "imported" ? t("skills.uncategorized") : group.name
            }
            skills={group.items}
            selectedIds={selectedIds}
            onToggle={onToggle}
          />
        ))}
        {visible.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No skills match this search.
          </p>
        )}
      </div>
    </div>
  );
}

function SkillGroup({
  title,
  skills,
  selectedIds,
  onToggle,
}: {
  title: string;
  skills: RuntimeSkill[];
  selectedIds: readonly string[];
  onToggle: (skillId: string, enabled: boolean) => void;
}) {
  return (
    <section>
      <h3 className="font-medium text-muted-foreground text-xs">
        {title}
        <span className="font-normal"> · {skills.length}</span>
      </h3>
      <ul className="mt-1 space-y-1">
        {skills.map((skill) => {
          const id = skillAssignmentId(skill);
          const checked = isSkillAssigned(skill, selectedIds);
          return (
            <li key={`${skill.id}:${skill.sourcePath}`}>
              <label
                className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted/60"
                title={skill.description || undefined}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={checked}
                  onPointerDown={(event) => event.stopPropagation()}
                  onChange={(event) => onToggle(id, event.target.checked)}
                />
                <span className="min-w-0">
                  <span className="font-medium">{skill.name}</span>
                  {skill.description ? (
                    <span className="mt-0.5 line-clamp-3 block break-words text-muted-foreground text-xs leading-snug">
                      {skill.description}
                    </span>
                  ) : (
                    <span className="mt-0.5 block text-muted-foreground text-xs">
                      {id}
                    </span>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
