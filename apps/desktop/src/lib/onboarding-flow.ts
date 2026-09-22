export const ONBOARDING_STEPS = [
  { id: "template", label: "Template" },
  { id: "details", label: "Details" },
  { id: "references", label: "References" },
  { id: "create", label: "Create" },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];

export function resolveOnboardingStep(input: {
  mode: "template" | "scratch";
  phase: "gallery" | "preview" | "details";
  referencesOpen: boolean;
  creating: boolean;
}): OnboardingStepId {
  if (input.creating) return "create";
  if (input.mode === "template" && input.phase !== "details") return "template";
  if (input.referencesOpen) return "references";
  return "details";
}

export function onboardingStepIndex(step: OnboardingStepId): number {
  return ONBOARDING_STEPS.findIndex((item) => item.id === step);
}

export type OnboardingDismiss =
  | { type: "clear-search" }
  | { type: "blur-field" }
  | { type: "close-section"; section: "references" | "location" }
  | { type: "back-to-preview" }
  | { type: "close-preview" }
  | { type: "exit" }
  | { type: "block-exit" };

export function onboardingEscape(input: {
  surface: "gallery" | "preview" | "details" | "scratch";
  searchQuery: string;
  fieldFocused: boolean;
  referencesOpen: boolean;
  locationOpen: boolean;
  hasDraft: boolean;
}): OnboardingDismiss {
  if (input.surface === "gallery") {
    if (input.searchQuery.trim()) return { type: "clear-search" };
    return { type: "exit" };
  }
  if (input.surface === "preview") {
    if (input.fieldFocused) return { type: "blur-field" };
    return { type: "close-preview" };
  }
  if (input.fieldFocused) return { type: "blur-field" };
  if (input.referencesOpen) {
    return { type: "close-section", section: "references" };
  }
  if (input.locationOpen) {
    return { type: "close-section", section: "location" };
  }
  if (input.surface === "details") return { type: "back-to-preview" };
  if (input.hasDraft) return { type: "block-exit" };
  return { type: "exit" };
}

export function onboardingHasDraft(input: {
  projectName: string;
  purpose: string;
  attachmentCount: number;
}): boolean {
  return Boolean(
    input.projectName.trim() ||
      input.purpose.trim() ||
      input.attachmentCount > 0,
  );
}

export function isOnboardingTextField(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined") return false;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  );
}
