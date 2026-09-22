export function normalizeProjectName(name: string): string {
  return name.trim();
}

/** Accordion toggles that must not count as leaving the project name field. */
export const PROJECT_FORM_CHROME_ATTR = "data-project-form-chrome";

export function isProjectFormChromeTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest(`[${PROJECT_FORM_CHROME_ATTR}]`))
  );
}

/**
 * Mark the next name-field blur as an accordion toggle.
 * The flag is cleared in a microtask when the click does not actually blur.
 */
export function deferProjectNameBlur(flag: { current: boolean }): void {
  flag.current = true;
  queueMicrotask(() => {
    flag.current = false;
  });
}

/**
 * `undefined` means this blur should leave the current error unchanged.
 * Submit still uses {@link getProjectNameError} directly.
 */
export function projectNameErrorFromBlur(
  name: string,
  relatedTarget: EventTarget | null,
  deferred = false,
): string | null | undefined {
  if (deferred || isProjectFormChromeTarget(relatedTarget)) return undefined;
  return getProjectNameError(name);
}

export function getProjectNameError(name: string): string | null {
  const trimmed = normalizeProjectName(name);
  if (!trimmed) return "Enter a project name";
  if (trimmed === "." || trimmed === "..") {
    return "Project name cannot be . or ..";
  }
  const hasControlCharacter = Array.from(trimmed).some(
    (char) => char.charCodeAt(0) < 32,
  );
  if (
    hasControlCharacter ||
    /[\\/<>:"|?*]/.test(trimmed) ||
    /[\s.]$/.test(trimmed)
  ) {
    return "Project name contains characters Windows cannot use";
  }
  return null;
}
