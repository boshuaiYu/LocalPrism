const FAST_SUFFIXES = ["-fast"] as const;

export interface FastModelPair {
  baseId: string;
  fastId: string;
}

function normalizeModelId(id: string): string {
  return id.trim().toLowerCase();
}

export function stripFastModelSuffix(id: string): string {
  const normalized = normalizeModelId(id);
  for (const suffix of FAST_SUFFIXES) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
      return normalized.slice(0, -suffix.length);
    }
  }
  return normalized;
}

export function isFastModelId(id: string): boolean {
  const normalized = normalizeModelId(id);
  return FAST_SUFFIXES.some(
    (suffix) =>
      normalized.endsWith(suffix) && normalized.length > suffix.length,
  );
}

export function resolveFastModelPair(
  modelId: string | null | undefined,
  catalog: readonly { id: string }[],
): FastModelPair | null {
  const currentNorm = modelId ? normalizeModelId(modelId) : "";
  if (!currentNorm || catalog.length === 0) return null;

  const byNorm = new Map<string, string>();
  for (const model of catalog) {
    const norm = normalizeModelId(model.id);
    if (norm && !byNorm.has(norm)) {
      byNorm.set(norm, model.id);
    }
  }

  if (!byNorm.has(currentNorm)) return null;

  const baseNorm = stripFastModelSuffix(currentNorm);
  const baseId = byNorm.get(baseNorm);
  if (!baseId) return null;

  let fastId: string | undefined;
  for (const suffix of FAST_SUFFIXES) {
    const found = byNorm.get(`${baseNorm}${suffix}`);
    if (found) {
      fastId = found;
      break;
    }
  }

  if (!fastId || fastId === baseId) return null;
  return { baseId, fastId };
}
