import { Button } from "@/components/ui/button";
import type { RuntimeKind, SkillScope, SkillTarget } from "@/runtime/types";

const OPTIONS: Array<{
  runtime: RuntimeKind;
  scope: SkillScope;
  label: string;
}> = [
  { runtime: "claude", scope: "user", label: "LocalPrism / user" },
  { runtime: "claude", scope: "project", label: "LocalPrism / project" },
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
                : option.label
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
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
