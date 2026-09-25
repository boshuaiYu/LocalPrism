import type { MessageKey } from "@/lib/i18n";

export const PROVIDER_PATH_GUIDANCE = {
  badge: "providers.path.badge",
  title: "providers.path.title",
  body: "providers.path.body",
} as const satisfies Record<string, MessageKey>;
