import {
  AlertCircleIcon,
  CheckIcon,
  CircleIcon,
  LoaderIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { StepInfo } from "@/lib/runtime-flow-steps";

export function RuntimeFlowSteps({ steps }: { steps: StepInfo[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="space-y-0.5 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      {steps.map((step) => (
        <RuntimeFlowStepRow key={step.id} step={step} />
      ))}
    </div>
  );
}

function RuntimeFlowStepRow({ step }: { step: StepInfo }) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      {step.status === "complete" && (
        <CheckIcon className="size-3.5 text-green-600" />
      )}
      {step.status === "active" && (
        <LoaderIcon className="size-3.5 animate-spin text-foreground" />
      )}
      {step.status === "pending" && (
        <CircleIcon className="size-3.5 text-muted-foreground/30" />
      )}
      {step.status === "error" && (
        <AlertCircleIcon className="size-3.5 text-destructive" />
      )}
      <span
        className={cn(
          "text-sm",
          step.status === "complete" && "text-green-600",
          step.status === "active" && "font-medium text-foreground",
          step.status === "pending" && "text-muted-foreground/60",
          step.status === "error" && "text-destructive",
        )}
      >
        {step.label}
      </span>
    </div>
  );
}
