import { create } from "zustand";
import { sameTeachLesson, type TeachLessonRef } from "@/lib/latex-teaching";
import type { TeachAnchor } from "@/lib/teach-float";
import { useSettingsStore } from "@/stores/settings-store";

/** Selection captured when a construct lesson is opened, if one was known. */
export interface TeachPresentContext {
  selectedText?: string | null;
}

interface LatexTeachState {
  open: boolean;
  lesson: TeachLessonRef | null;
  sourceKey: string | null;
  anchor: TeachAnchor | null;
  /** Bumps on every accepted lesson so the float can drop a drag offset. */
  placement: number;
  /** Construct selection kept after Explain dismisses the selection toolbar. */
  selectedText: string | null;
  insertReady: boolean;
  askReady: boolean;
  present: (
    lesson: TeachLessonRef,
    sourceKey: string,
    anchor?: TeachAnchor | null,
    context?: TeachPresentContext | null,
  ) => void;
  forcePresent: (
    lesson: TeachLessonRef,
    sourceKey: string,
    anchor?: TeachAnchor | null,
    context?: TeachPresentContext | null,
  ) => void;
  dismiss: () => void;
  reset: () => void;
  setInsertReady: (ready: boolean) => void;
  setAskReady: (ready: boolean) => void;
}

const closed = {
  open: false,
  lesson: null,
  sourceKey: null,
  anchor: null,
  placement: 0,
  selectedText: null,
} as const;

let teachInserter: ((snippet: string) => void) | null = null;
let teachAsker: ((prompt: string) => void) | null = null;

export function registerTeachInsert(
  handler: ((snippet: string) => void) | null,
): void {
  teachInserter = handler;
  useLatexTeachStore.getState().setInsertReady(handler != null);
}

export function insertRegisteredTeachSnippet(snippet: string): void {
  teachInserter?.(snippet);
}

/** Editor registers Ask AI. The handler chooses the learning session. */
export function registerTeachAsk(
  handler: ((prompt: string) => void) | null,
): void {
  teachAsker = handler;
  useLatexTeachStore.getState().setAskReady(handler != null);
}

export function askRegisteredTeach(prompt: string): void {
  teachAsker?.(prompt);
}

interface TeachDocumentScope {
  projectRoot: string | null;
  projectGeneration: number;
  activeFileId: string;
}

function teachingEnabled(): boolean {
  return useSettingsStore.getState().latexTeaching === true;
}

/**
 * Explain buttons use `diag:` and `compile` keys. Those stay above a
 * selection or guide so a still-active editor selection cannot cover them.
 */
function teachSourcePriority(sourceKey: string): number {
  if (sourceKey.startsWith("diag:") || sourceKey.startsWith("compile")) {
    return 2;
  }
  return 1;
}

function showLesson(
  get: () => LatexTeachState,
  set: (
    partial: Pick<
      LatexTeachState,
      "open" | "lesson" | "sourceKey" | "anchor" | "placement" | "selectedText"
    >,
  ) => void,
  lesson: TeachLessonRef,
  sourceKey: string,
  anchor: TeachAnchor | null,
  context?: TeachPresentContext | null,
) {
  const selectedText = context?.selectedText?.trim() || null;
  set({
    open: true,
    lesson,
    sourceKey,
    anchor,
    placement: get().placement + 1,
    selectedText,
  });
}

export const useLatexTeachStore = create<LatexTeachState>((set, get) => ({
  ...closed,
  insertReady: false,
  askReady: false,
  setInsertReady: (ready) => set({ insertReady: ready }),
  setAskReady: (ready) => set({ askReady: ready }),
  present: (lesson, sourceKey, anchor = null, context = null) => {
    if (!teachingEnabled()) return;
    const current = get();
    const activePriority = current.sourceKey
      ? teachSourcePriority(current.sourceKey)
      : 0;
    if (current.open && teachSourcePriority(sourceKey) < activePriority) {
      return;
    }
    if (
      current.open &&
      current.sourceKey === sourceKey &&
      current.lesson &&
      sameTeachLesson(current.lesson, lesson)
    ) {
      return;
    }
    showLesson(get, set, lesson, sourceKey, anchor, context);
  },
  forcePresent: (lesson, sourceKey, anchor = null, context = null) => {
    if (!teachingEnabled()) return;
    showLesson(get, set, lesson, sourceKey, anchor, context);
  },
  dismiss: () => {
    set({ open: false });
  },
  reset: () => set({ ...closed }),
}));

useSettingsStore.subscribe((state, previous) => {
  if (previous.latexTeaching && !state.latexTeaching) {
    useLatexTeachStore.getState().reset();
  }
});

function scopeSnapshot(state: TeachDocumentScope): TeachDocumentScope {
  return {
    projectRoot: state.projectRoot,
    projectGeneration: state.projectGeneration,
    activeFileId: state.activeFileId,
  };
}

function sameScope(
  left: TeachDocumentScope,
  right: TeachDocumentScope,
): boolean {
  return (
    left.projectRoot === right.projectRoot &&
    left.projectGeneration === right.projectGeneration &&
    left.activeFileId === right.activeFileId
  );
}

let unbindDocumentScope: (() => void) | null = null;

/**
 * Clear the open lesson when the project or the active file changes.
 * The editor shell calls this once with the document store.
 */
export function bindTeachDocumentScope(source: {
  getState: () => TeachDocumentScope;
  subscribe: (
    listener: (state: TeachDocumentScope, previous: TeachDocumentScope) => void,
  ) => () => void;
}): void {
  if (unbindDocumentScope) return;
  let current = scopeSnapshot(source.getState());
  unbindDocumentScope = source.subscribe((state) => {
    const next = scopeSnapshot(state);
    if (sameScope(current, next)) return;
    current = next;
    useLatexTeachStore.getState().reset();
  });
}
