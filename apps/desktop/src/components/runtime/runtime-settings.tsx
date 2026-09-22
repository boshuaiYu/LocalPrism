import { ProviderPathGuidance } from "@/components/providers/provider-path-guidance";
import { ProviderSettings } from "@/components/providers/provider-settings";

export interface RuntimeSettingsProps {
  refreshOnMount?: boolean;
  showEngine?: boolean;
  officialOpenDefault?: boolean;
}

/** Settings → Providers. Kept as RuntimeSettings so existing hosts keep working. */
export function RuntimeSettings({
  refreshOnMount = true,
  showEngine = true,
  officialOpenDefault = false,
}: RuntimeSettingsProps) {
  return (
    <div className="space-y-2">
      <div className="px-4 pt-4">
        <ProviderPathGuidance />
      </div>
      <ProviderSettings
        refreshOnMount={refreshOnMount}
        showEngine={showEngine}
        officialOpenDefault={officialOpenDefault}
      />
    </div>
  );
}
