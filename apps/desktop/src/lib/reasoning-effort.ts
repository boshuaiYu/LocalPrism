export const FALLBACK_REASONING_EFFORTS = ["low", "medium", "high"] as const;

const EFFORT_ALIASES: Record<string, string> = {
  max: "xhigh",
  ultra: "xhigh",
};

const UNSUPPORTED_WIRE_EFFORTS = new Set(["minimal"]);

const EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
};

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

const EFFORT_SHORT_LABELS: Record<string, string> = {
  none: "Off",
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "Max",
};

export function aliasReasoningEffort(
  value: string | null | undefined,
): string | null {
  const raw = value?.trim().toLowerCase() || null;
  if (!raw) return null;
  return EFFORT_ALIASES[raw] ?? raw;
}

export function normalizeReasoningEffortOptions(
  efforts: readonly string[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const known: string[] = [];
  const unknown: string[] = [];

  for (const effort of efforts ?? []) {
    const aliased = aliasReasoningEffort(effort);
    if (
      !aliased ||
      UNSUPPORTED_WIRE_EFFORTS.has(aliased) ||
      seen.has(aliased)
    ) {
      continue;
    }
    seen.add(aliased);
    if (aliased in EFFORT_RANK) {
      known.push(aliased);
    } else {
      unknown.push(aliased);
    }
  }

  known.sort((left, right) => EFFORT_RANK[left] - EFFORT_RANK[right]);
  return [...known, ...unknown];
}

export function resolveReasoningEffort(
  current: string | null | undefined,
  options: readonly string[],
  fallback?: string | null,
): string | null {
  if (options.length === 0) return null;

  const aliasedCurrent = aliasReasoningEffort(current);
  if (aliasedCurrent && options.includes(aliasedCurrent)) {
    return aliasedCurrent;
  }

  const currentRank =
    aliasedCurrent && aliasedCurrent in EFFORT_RANK
      ? EFFORT_RANK[aliasedCurrent]
      : null;
  if (currentRank !== null) {
    return options.reduce((best, option) => {
      const bestDistance = Math.abs(
        (EFFORT_RANK[best] ?? Number.POSITIVE_INFINITY) - currentRank,
      );
      const optionDistance = Math.abs(
        (EFFORT_RANK[option] ?? Number.POSITIVE_INFINITY) - currentRank,
      );
      return optionDistance < bestDistance ? option : best;
    });
  }

  const aliasedFallback = aliasReasoningEffort(fallback);
  if (aliasedFallback && options.includes(aliasedFallback)) {
    return aliasedFallback;
  }

  if (options.includes("medium")) return "medium";
  return options[Math.floor((options.length - 1) / 2)] ?? options[0] ?? null;
}

export function reasoningEffortSliderIndex(
  current: string | null | undefined,
  options: readonly string[],
): number {
  if (options.length === 0) return 0;
  const resolved = resolveReasoningEffort(current, options);
  if (!resolved) return 0;
  const index = options.indexOf(resolved);
  return index >= 0 ? index : 0;
}

export function formatReasoningEffortLabel(
  value: string | null | undefined,
): string {
  const aliased = aliasReasoningEffort(value);
  if (!aliased) return "";
  return EFFORT_LABELS[aliased] ?? aliased;
}

export function formatReasoningEffortShortLabel(
  value: string | null | undefined,
): string {
  const aliased = aliasReasoningEffort(value);
  if (!aliased) return "";
  return EFFORT_SHORT_LABELS[aliased] ?? aliased;
}
