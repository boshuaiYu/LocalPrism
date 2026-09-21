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
    <ProviderSettings
      refreshOnMount={refreshOnMount}
      showEngine={showEngine}
      officialOpenDefault={officialOpenDefault}
    />
  );
}
