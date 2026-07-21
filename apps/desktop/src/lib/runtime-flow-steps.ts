export type StepStatus = "pending" | "active" | "complete" | "error";

export interface StepInfo {
  id: string;
  label: string;
  status: StepStatus;
}

export const CODEX_INSTALL_STEPS: Omit<StepInfo, "status">[] = [
  { id: "downloading", label: "Downloading Codex" },
  { id: "installing", label: "Installing CLI" },
  { id: "verifying", label: "Verifying installation" },
  { id: "complete", label: "Codex ready" },
];

export const CODEX_LOGIN_STEPS: Omit<StepInfo, "status">[] = [
  { id: "opening-browser", label: "Opening browser" },
  { id: "waiting-auth", label: "Waiting for ChatGPT sign-in" },
  { id: "complete", label: "Authenticated" },
];

export const STEP_ORDER_CODEX_INSTALL = CODEX_INSTALL_STEPS.map((s) => s.id);
export const STEP_ORDER_CODEX_LOGIN = CODEX_LOGIN_STEPS.map((s) => s.id);

export function createPendingSteps(
  defs: Omit<StepInfo, "status">[],
): StepInfo[] {
  return defs.map((step) => ({ ...step, status: "pending" as const }));
}

export function advanceSteps(
  steps: StepInfo[],
  targetId: string,
  order: string[],
): StepInfo[] {
  const targetIdx = order.indexOf(targetId);
  return steps.map((step) => {
    const thisIdx = order.indexOf(step.id);
    if (thisIdx < targetIdx && step.status !== "error") {
      return { ...step, status: "complete" as const };
    }
    if (step.id === targetId) {
      return { ...step, status: "active" as const };
    }
    return step;
  });
}

export function failActiveStep(
  steps: StepInfo[],
  errorLabel?: string,
): StepInfo[] {
  return steps.map((step) =>
    step.status === "active"
      ? {
          ...step,
          status: "error" as const,
          label: errorLabel ? `${step.label}: ${errorLabel}` : step.label,
        }
      : step,
  );
}

export function completeAllSteps(steps: StepInfo[]): StepInfo[] {
  return steps.map((step) =>
    step.status === "error" ? step : { ...step, status: "complete" as const },
  );
}
