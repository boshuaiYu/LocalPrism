import { CheckIcon } from "lucide-react";
import {
  ONBOARDING_STEPS,
  onboardingStepIndex,
  type OnboardingStepId,
} from "@/lib/onboarding-flow";
import { cn } from "@/lib/utils";

export function OnboardingStepper({ active }: { active: OnboardingStepId }) {
  const activeIndex = onboardingStepIndex(active);

  return (
    <ol
      data-testid="onboarding-stepper"
      className="flex items-center gap-2"
      aria-label="Project setup progress"
    >
      {ONBOARDING_STEPS.map((step, index) => {
        const complete = index < activeIndex;
        const current = index === activeIndex;
        return (
          <li key={step.id} className="flex min-w-0 items-center gap-2">
            {index > 0 && <span aria-hidden className="h-px w-4 bg-border" />}
            <span
              className={cn(
                "flex min-w-0 items-center gap-2",
                current ? "text-foreground" : "text-(--lp-meta)",
              )}
              aria-current={current ? "step" : undefined}
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                  complete && "border-foreground bg-foreground text-background",
                  current && "border-foreground",
                  !complete && !current && "border-border",
                )}
              >
                {complete ? <CheckIcon className="size-3" /> : index + 1}
              </span>
              <span
                className={cn(
                  "truncate text-xs",
                  current ? "font-semibold" : "font-medium",
                )}
              >
                {step.label}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
