import { PROVIDER_PATH_GUIDANCE } from "@/lib/provider-path-guidance";

export function ProviderPathGuidance() {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-foreground px-2 py-0.5 font-medium text-[11px] text-background">
          {PROVIDER_PATH_GUIDANCE.badge}
        </span>
        <h3 className="lp-heading">{PROVIDER_PATH_GUIDANCE.title}</h3>
      </div>
      <p className="lp-body mt-2">{PROVIDER_PATH_GUIDANCE.body}</p>
    </div>
  );
}
