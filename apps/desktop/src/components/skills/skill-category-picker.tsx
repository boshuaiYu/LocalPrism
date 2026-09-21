import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSkillCategoryStore } from "@/stores/skill-category-store";
import { cn } from "@/lib/utils";

export function SkillCategoryPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const categories = useSkillCategoryStore((state) => state.categories);
  const addCategory = useSkillCategoryStore((state) => state.addCategory);
  const [draft, setDraft] = useState("");

  return (
    <div className="space-y-2" data-testid="skill-category-picker">
      <div className="flex flex-wrap gap-1.5">
        {categories.map((category) => (
          <button
            key={category.id}
            type="button"
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors",
              value === category.id
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:bg-muted/60",
            )}
            onClick={() => onChange(category.id)}
          >
            {category.name}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="New category name"
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const created = addCategory(draft);
            if (created) {
              onChange(created.id);
              setDraft("");
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!draft.trim()}
          onClick={() => {
            const created = addCategory(draft);
            if (created) {
              onChange(created.id);
              setDraft("");
            }
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
