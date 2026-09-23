import {
  DEFAULT_SKILL_PACKS,
  skillPackDisplayName,
} from "@/lib/default-skill-packs";

function formatEnglishList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Light helper copy. Names come from the default skill packs in this repo. */
export function skillPaperWorkflowGuidance(): string {
  const names = DEFAULT_SKILL_PACKS.map((pack) =>
    skillPackDisplayName(pack.id),
  );
  return `Skills help paper workflows. Default packs such as ${formatEnglishList(names)} include PaperSpine-style helpers the agent can use while drafting and revising a paper.`;
}
