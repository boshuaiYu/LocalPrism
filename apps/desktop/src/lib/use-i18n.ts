import { useCallback } from "react";
import { translate, type MessageKey, type UiLanguage } from "@/lib/i18n";
import { useSettingsStore } from "@/stores/settings-store";

export function useI18n() {
  const language = useSettingsStore((state) => state.uiLanguage);
  const setLanguage = useSettingsStore((state) => state.setUiLanguage);
  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) =>
      translate(language, key, vars),
    [language],
  );
  return { language, setLanguage, t };
}

export function uiText(
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  return translate(useSettingsStore.getState().uiLanguage, key, vars);
}

export type { UiLanguage };
