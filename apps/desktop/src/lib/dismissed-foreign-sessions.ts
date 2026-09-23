export const DISMISSED_FOREIGN_SESSIONS_KEY =
  "claude-prism:dismissed-foreign-sessions";

function dismissalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Sessions the current login could not archive, hidden so the row can still be closed. */
export function loadDismissedForeignSessionKeys(
  storage: Storage | null = dismissalStorage(),
): string[] {
  try {
    const raw = storage?.getItem(DISMISSED_FOREIGN_SESSIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
  } catch {
    return [];
  }
}

export function rememberDismissedForeignSession(
  key: string,
  storage: Storage | null = dismissalStorage(),
): void {
  const trimmed = key.trim();
  if (!trimmed || !storage) return;
  const keys = new Set(loadDismissedForeignSessionKeys(storage));
  keys.add(trimmed);
  try {
    storage.setItem(DISMISSED_FOREIGN_SESSIONS_KEY, JSON.stringify([...keys]));
  } catch {
    // Remembering a dismissal must not block closing the session.
  }
}
