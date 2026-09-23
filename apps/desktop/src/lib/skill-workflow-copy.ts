import {
  DEFAULT_SKILL_PACKS,
  skillPackDisplayName,
} from "@/lib/default-skill-packs";
import { translate } from "@/lib/i18n";
import { useSettingsStore } from "@/stores/settings-store";

function formatEnglishList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Light helper copy. Names come from the default skill packs in this repo. */
export function skillPaperWorkflowGuidance(): string {
  const language = useSettingsStore.getState().uiLanguage;
  const names = DEFAULT_SKILL_PACKS.map((pack) =>
    skillPackDisplayName(pack.id),
  );
  const packs = language === "zh" ? names.join("、") : formatEnglishList(names);
  return translate(language, "env.workflow", { packs });
}
