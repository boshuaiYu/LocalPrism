import { Button } from "@/components/ui/button";
import type { MessageKey } from "@/lib/i18n";
import { useI18n } from "@/lib/use-i18n";
import type { RuntimeKind, SkillScope, SkillTarget } from "@/runtime/types";

const OPTIONS: Array<{
  runtime: RuntimeKind;
  scope: SkillScope;
  labelKey: MessageKey;
}> = [
  { runtime: "claude", scope: "user", labelKey: "skills.userTarget" },
  { runtime: "claude", scope: "project", labelKey: "skills.projectTarget" },
];

export interface SkillTargetPickerProps {
  value: SkillTarget[];
  projectPath?: string | null;
  onChange: (targets: SkillTarget[]) => void;
}

export function SkillTargetPicker({
  value,
  projectPath = null,
  onChange,
}: SkillTargetPickerProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-2" data-testid="skill-target-picker">
      {OPTIONS.map((option) => {
        const disabled = option.scope === "project" && !projectPath;
        const active = value.some(
          (target) =>
            target.runtime === option.runtime && target.scope === option.scope,
        );
        return (
          <Button
            key={`${option.runtime}:${option.scope}`}
            type="button"
            size="sm"
            variant={active ? "default" : "outline"}
            disabled={disabled}
            title={
              disabled
                ? "Open a project to use project-scoped skills"
                : t(option.labelKey)
            }
            onClick={() => {
              if (active) {
                onChange(
                  value.filter(
                    (target) =>
                      !(
                        target.runtime === option.runtime &&
                        target.scope === option.scope
                      ),
                  ),
                );
                return;
              }
              onChange([
                ...value,
                { runtime: option.runtime, scope: option.scope },
              ]);
            }}
          >
            {t(option.labelKey)}
          </Button>
        );
      })}
    </div>
  );
}
