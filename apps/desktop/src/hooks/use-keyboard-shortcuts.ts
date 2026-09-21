import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getAppZoomAction, shouldHandleAppZoomShortcut } from "@/lib/app-zoom";
import { useDocumentStore } from "@/stores/document-store";

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const el = target.closest(
    "input, textarea, select, [contenteditable=''], [contenteditable=true], .cm-editor, .cm-content",
  );
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return !el.readOnly && !el.disabled;
  }
  return el !== null;
}

/** Capture & Ask is Ctrl/Cmd+Shift+X. Ctrl/Cmd+X must stay native cut. */
export function isCaptureAskShortcut(e: KeyboardEvent): boolean {
  if (e.altKey || e.repeat) return false;
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return false;
  if (e.code !== "KeyX" && e.key.toLowerCase() !== "x") return false;
  // Chinese IME leftover Shift + Ctrl+X arrives as key "x" (cut), not "X".
  if (e.key === "x") return false;
  if (isTypingTarget(e.target)) return false;
  return true;
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handleZoomKeyDown = (e: KeyboardEvent) => {
      const zoomAction = getAppZoomAction(e);
      if (!zoomAction || !shouldHandleAppZoomShortcut(e.target)) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        const state = useDocumentStore.getState();
        state.setIsSaving(true);
        state.saveCurrentFile().finally(() => {
          setTimeout(() => state.setIsSaving(false), 500);
        });
      }

      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "n"
      ) {
        e.preventDefault();
        invoke("create_new_window").catch(console.error);
      }

      if (isCaptureAskShortcut(e)) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("toggle-capture-mode"));
      }

      // Cmd+Shift+D (macOS) / Ctrl+Shift+D (others): Toggle debug panel
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "d"
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("toggle-debug-panel"));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keydown", handleZoomKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keydown", handleZoomKeyDown, true);
    };
  }, []);
}
