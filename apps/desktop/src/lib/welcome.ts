export const WELCOME_COMPLETED_KEY = "localprism-welcome-v1";

export function isWelcomeCompleted(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(WELCOME_COMPLETED_KEY) === "true";
}

export function markWelcomeCompleted(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(WELCOME_COMPLETED_KEY, "true");
}

export function resetWelcomeCompletedForTests(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(WELCOME_COMPLETED_KEY);
}
