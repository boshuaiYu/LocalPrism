import {
  aliasReasoningEffort,
  formatReasoningEffortLabel,
  normalizeReasoningEffortOptions,
  resolveReasoningEffort,
} from "@/lib/reasoning-effort";

export interface ReasoningStrengthOption {
  value: string;
  label: string;
}

export type ReasoningStrengthControl =
  | {
      kind: "discrete";
      options: ReasoningStrengthOption[];
      value: string;
    }
  | {
      kind: "continuous";
      min: number;
      max: number;
      step: number;
      value: number;
    }
  | {
      kind: "unavailable";
      reason: string;
      /** Sole advertised effort, when the model cannot be adjusted. */
      value: string | null;
    };

export interface ReasoningStrengthModel {
  id?: string | null;
  reasoningEfforts?: readonly string[] | null;
  metadata?: unknown;
  defaultReasoningEffort?: string | null;
}

const STRENGTH_NODE_KEYS = new Set([
  "reasoning",
  "reasoning-effort",
  "reasoning-efforts",
  "reasoning-budget",
  "thinking",
  "thinking-budget",
  "thinking-budgets",
  "effort",
  "efforts",
]);

const DISCRETE_KEYS = new Set([
  "supported-reasoning-levels",
  "supported-reasoning-efforts",
  "reasoning-efforts",
  "reasoning-levels",
  "reasoningefforts",
]);

const NESTED_DISCRETE_KEYS = new Set(["efforts", "levels", "options"]);

const UNAVAILABLE_REASON = "This model does not adjust reasoning strength";

interface RawOption {
  value: string;
  label?: string;
}

interface ParsedRange {
  min: number;
  max: number;
  step: number | null;
  defaultValue: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function token(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function optionFromUnknown(value: unknown): RawOption | null {
  if (typeof value === "string" || typeof value === "number") {
    const raw = String(value).trim();
    return raw ? { value: raw } : null;
  }
  if (!isRecord(value)) return null;
  const raw =
    value.effort ??
    value.id ??
    value.value ??
    value.reasoningEffort ??
    value.reasoning_effort ??
    value.name;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim();
  if (!text) return null;
  const label =
    value.label ?? value.displayName ?? value.display_name ?? value.title;
  return {
    value: text,
    label: typeof label === "string" && label.trim() ? label.trim() : undefined,
  };
}

function readRange(value: unknown): ParsedRange | null {
  if (!isRecord(value)) return null;
  const min = finiteNumber(
    value.min ?? value.minimum ?? value.min_tokens ?? value.minTokens,
  );
  const max = finiteNumber(
    value.max ?? value.maximum ?? value.max_tokens ?? value.maxTokens,
  );
  if (min === null || max === null || max <= min) return null;
  const step = finiteNumber(
    value.step ?? value.step_tokens ?? value.stepTokens,
  );
  const defaultValue = finiteNumber(
    value.default ?? value.defaultValue ?? value.default_value,
  );
  return {
    min,
    max,
    step: step !== null && step > 0 ? step : null,
    defaultValue,
  };
}

function parentMarksStrength(parentKey: string | null): boolean {
  if (!parentKey) return false;
  return (
    STRENGTH_NODE_KEYS.has(parentKey) ||
    parentKey.includes("reasoning") ||
    parentKey.includes("thinking")
  );
}

function collectCapability(
  value: unknown,
  parentKey: string | null,
  depth: number,
  options: RawOption[],
  ranges: ParsedRange[],
) {
  if (depth > 5 || value == null) return;
  if (Array.isArray(value)) {
    if (
      parentKey &&
      (DISCRETE_KEYS.has(parentKey) ||
        (NESTED_DISCRETE_KEYS.has(parentKey) && parentMarksStrength(parentKey)))
    ) {
      for (const entry of value) {
        const option = optionFromUnknown(entry);
        if (option) options.push(option);
      }
    }
    return;
  }
  if (!isRecord(value)) return;

  const range = readRange(value);
  if (range && parentMarksStrength(parentKey)) {
    ranges.push(range);
  }

  for (const [key, child] of Object.entries(value)) {
    const normalized = token(key);
    const discrete =
      DISCRETE_KEYS.has(normalized) ||
      (NESTED_DISCRETE_KEYS.has(normalized) && parentMarksStrength(parentKey));
    if (discrete && Array.isArray(child)) {
      for (const entry of child) {
        const option = optionFromUnknown(entry);
        if (option) options.push(option);
      }
      continue;
    }
    const nested =
      STRENGTH_NODE_KEYS.has(normalized) ||
      normalized === "capabilities" ||
      normalized.includes("reasoning") ||
      normalized.includes("thinking");
    if (nested) {
      collectCapability(child, normalized, depth + 1, options, ranges);
    }
  }
}

function discreteOptions(raw: readonly RawOption[]): ReasoningStrengthOption[] {
  const labels = new Map<string, string>();
  const values: string[] = [];
  for (const option of raw) {
    const aliased = aliasReasoningEffort(option.value);
    if (!aliased) continue;
    values.push(aliased);
    if (option.label && !labels.has(aliased)) {
      labels.set(aliased, option.label);
    }
  }
  return normalizeReasoningEffortOptions(values).map((value) => ({
    value,
    label: labels.get(value) ?? formatReasoningEffortLabel(value),
  }));
}

function defaultStep(min: number, max: number, step: number | null): number {
  if (step !== null && step > 0 && step <= max - min) return step;
  if (Number.isInteger(min) && Number.isInteger(max)) return 1;
  const span = max - min;
  return span >= 10 ? span / 10 : span;
}

function snapToStep(
  value: number,
  min: number,
  max: number,
  step: number,
): number {
  const clamped = Math.min(max, Math.max(min, value));
  const steps = Math.round((clamped - min) / step);
  const snapped = min + steps * step;
  const digits = Math.min(6, (step.toString().split(".")[1] ?? "").length + 1);
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(digits));
}

function unavailable(
  reason: string,
  value: string | null = null,
): ReasoningStrengthControl {
  return { kind: "unavailable", reason, value };
}

export function deriveReasoningStrength(
  model: ReasoningStrengthModel | null | undefined,
  current: string | null | undefined,
): ReasoningStrengthControl {
  if (!model) {
    return unavailable("Select a model to set reasoning strength");
  }

  const metadataOptions: RawOption[] = [];
  const ranges: ParsedRange[] = [];
  collectCapability(model.metadata, null, 0, metadataOptions, ranges);

  const range = ranges[0];
  if (range) {
    const step = defaultStep(range.min, range.max, range.step);
    const numericCurrent = finiteNumber(current);
    const seed =
      numericCurrent ??
      range.defaultValue ??
      finiteNumber(model.defaultReasoningEffort) ??
      range.min;
    return {
      kind: "continuous",
      min: range.min,
      max: range.max,
      step,
      value: snapToStep(seed, range.min, range.max, step),
    };
  }

  const advertised = discreteOptions([
    ...metadataOptions,
    ...(model.reasoningEfforts ?? []).map((value) => ({ value })),
  ]);

  if (advertised.length >= 2) {
    const resolved =
      resolveReasoningEffort(
        current,
        advertised.map((option) => option.value),
        model.defaultReasoningEffort,
      ) ?? advertised[0].value;
    return {
      kind: "discrete",
      options: advertised,
      value: resolved,
    };
  }

  if (advertised.length === 1) {
    const only = advertised[0];
    return unavailable(
      `Reasoning strength is fixed at ${only.label}`,
      only.value,
    );
  }

  return unavailable(UNAVAILABLE_REASON);
}

export function reasoningStrengthWireValue(
  control: ReasoningStrengthControl,
): string | null {
  if (control.kind === "discrete") return control.value;
  if (control.kind === "continuous") return String(control.value);
  return control.value;
}

/** Model-driven effort suffix for the composer chip. Null when the catalog lists none. */
export function reasoningStrengthChipLabel(
  control: ReasoningStrengthControl,
): string | null {
  if (control.kind === "discrete") {
    const label =
      control.options.find((option) => option.value === control.value)?.label ??
      control.value;
    const trimmed = label.trim();
    return trimmed || null;
  }
  if (control.kind === "continuous") return String(control.value);
  if (!control.value) return null;
  const fixed = formatReasoningEffortLabel(control.value).trim();
  return fixed || null;
}
