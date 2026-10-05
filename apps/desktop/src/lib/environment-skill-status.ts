const INLINE_ERROR_LIMIT = 72;

/** Join a status-check failure and a pack-download failure into one message. */
export function environmentSkillProblem(
  checkError: string | null | undefined,
  skillError: string | null | undefined,
): string | null {
  const parts = [checkError, skillError]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
  return parts.length > 0 ? parts.join("\n") : null;
}

/** One visible line for the environment row. The title keeps the full text. */
export function environmentSkillInline(problem: string): string {
  const line =
    problem
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? problem.trim();
  if (line.length <= INLINE_ERROR_LIMIT) return line;
  return `${line.slice(0, INLINE_ERROR_LIMIT - 1)}…`;
}

/**
 * Retry while nothing is installed, and also when a later pack failed after
 * some skills were already counted.
 */
export function environmentSkillShowRetry(
  installed: boolean,
  problem: string | null,
): boolean {
  return !installed || problem !== null;
}
