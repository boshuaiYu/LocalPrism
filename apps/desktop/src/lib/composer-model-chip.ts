import { chatStripLabelPx } from "@/lib/chat-tab-strip";

/** px-2.5 on the model chip. Spacing, not a measured word. */
export const COMPOSER_MODEL_CHIP_PAD_PX = 20;
/** gap-1.5 between the name, the effort, and the chevron. */
export const COMPOSER_MODEL_CHIP_GAP_PX = 6;
/** size-3.5 chevron. */
export const COMPOSER_MODEL_CHIP_CHEVRON_PX = 14;
/** size-3.5 provider mark. */
export const COMPOSER_MODEL_CHIP_ICON_PX = 14;

export type ComposerModelChipForm = "full" | "icon" | "effort";

/** Tooltip and accessible name. The chip never shows a slice of this string. */
export function composerModelChipFullLabel(
  modelLabel: string,
  effortLabel: string | null | undefined,
): string {
  const model = modelLabel.trim();
  const effort = effortLabel?.trim() ?? "";
  if (model && effort) return `${model} · ${effort}`;
  return model || effort;
}

function effortText(effortLabel: string): string {
  return ` · ${effortLabel.trim()}`;
}

function rowWidth(parts: number[]): number {
  const gaps = Math.max(0, parts.length - 1) * COMPOSER_MODEL_CHIP_GAP_PX;
  return (
    COMPOSER_MODEL_CHIP_PAD_PX +
    parts.reduce((sum, part) => sum + part, 0) +
    gaps
  );
}

/**
 * Full model name when the slot can hold it. Otherwise the provider mark
 * plus the effort, or the effort alone. An unmeasured slot stays on the
 * full name; the layout effect measures before paint.
 */
export function composerModelChipPlan(input: {
  slotPx: number;
  modelLabel: string;
  effortLabel: string | null;
  hasIcon: boolean;
  textPx?: { model?: number; effort?: number };
}): ComposerModelChipForm {
  const model = input.modelLabel.trim();
  const effort = input.effortLabel?.trim() || null;
  const modelPx = model ? chatStripLabelPx(model, input.textPx?.model) : 0;
  const effortWordPx = effort
    ? chatStripLabelPx(effort, input.textPx?.effort)
    : 0;
  const effortSepPx = effort ? chatStripLabelPx(effortText(effort)) : 0;
  const chevron = COMPOSER_MODEL_CHIP_CHEVRON_PX;
  const full = rowWidth(
    effort ? [modelPx, effortSepPx, chevron] : [modelPx, chevron],
  );
  const icon = rowWidth(
    effort
      ? [COMPOSER_MODEL_CHIP_ICON_PX, effortWordPx, chevron]
      : [COMPOSER_MODEL_CHIP_ICON_PX, chevron],
  );
  const effortOnly = effort
    ? rowWidth([effortWordPx, chevron])
    : Number.POSITIVE_INFINITY;
  const slot = Number.isFinite(input.slotPx) ? input.slotPx : 0;
  if (slot <= 0 || full <= slot) return "full";
  if (input.hasIcon && icon <= slot) return "icon";
  if (effort && effortOnly <= slot) return "effort";
  if (effort) return "effort";
  if (input.hasIcon) return "icon";
  return "full";
}
