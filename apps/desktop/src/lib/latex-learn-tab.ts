import { translate, type UiLanguage } from "@/lib/i18n";
import { sameProjectPath } from "@/stores/chat-persistence";

/** One reusable LaTeX teaching chat per project. Persisted on the tab. */
export const LATEX_LEARN_PURPOSE = "latex-learn" as const;

export type LatexLearnPurpose = typeof LATEX_LEARN_PURPOSE;

export function isLatexLearnTab(
  tab: { purpose?: string | null } | null | undefined,
): boolean {
  return tab?.purpose === LATEX_LEARN_PURPOSE;
}

export function latexLearnSessionTitle(language: UiLanguage): string {
  return translate(language, "teach.sessionTitle");
}

export interface LatexLearnTabLike {
  id: string;
  projectPath: string | null;
  purpose?: string | null;
  runtime?: string | null;
  sessionId?: string | null;
  sessionRef?: { sessionId?: string | null } | null;
  /** Set while a history read for this tab is in flight. */
  resumeRequestId?: string | null;
  messages?: readonly unknown[] | null;
  isStreaming?: boolean;
  cancelledAttempts?: readonly unknown[] | null;
}

/** Same id resume uses: the session reference wins over the legacy field. */
export function latexLearnSessionId(tab: {
  sessionId?: string | null;
  sessionRef?: { sessionId?: string | null } | null;
}): string {
  return tab.sessionRef?.sessionId?.trim() || tab.sessionId?.trim() || "";
}

export type LatexTeachAskPlan =
  | { kind: "missing-project" }
  | { kind: "create" }
  | { kind: "reuse"; tabId: string; loadHistory: boolean };

/**
 * Pick the project's learning tab, or say one must be created.
 * A closed tab is simply absent. A Codex tab is not reusable: Ask AI needs
 * a Claude session that can take a turn.
 */
export function planLatexTeachAsk(
  tabs: readonly LatexLearnTabLike[],
  projectPath: string | null,
): LatexTeachAskPlan {
  if (!projectPath) return { kind: "missing-project" };
  const existing = tabs.find(
    (tab) =>
      tab.purpose === LATEX_LEARN_PURPOSE &&
      tab.runtime !== "codex" &&
      sameProjectPath(tab.projectPath, projectPath),
  );
  if (!existing) return { kind: "create" };
  const stopping = (existing.cancelledAttempts?.length ?? 0) > 0;
  const sessionId = latexLearnSessionId(existing);
  // An in-flight resume is busy. A second ask must wait for it, not start
  // another read or send against the cleared transcript.
  const loadHistory =
    !stopping &&
    existing.isStreaming !== true &&
    !existing.resumeRequestId &&
    (existing.messages?.length ?? 0) === 0 &&
    sessionId.length > 0;
  return { kind: "reuse", tabId: existing.id, loadHistory };
}
