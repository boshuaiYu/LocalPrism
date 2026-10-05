export const OPEN_SETTINGS_EVENT = "localprism-open-settings";

export function requestOpenSettings(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT));
}

export function isOpenSettingsShortcut(event: {
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  repeat: boolean;
  code: string;
  key: string;
  isComposing?: boolean;
}): boolean {
  if (event.altKey || event.shiftKey || event.repeat || event.isComposing) {
    return false;
  }
  if (!(event.metaKey || event.ctrlKey)) return false;
  return event.code === "Comma" || event.key === ",";
}
