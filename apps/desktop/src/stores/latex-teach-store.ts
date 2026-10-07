import { create } from "zustand";
import { sameTeachLesson, type TeachLessonRef } from "@/lib/latex-teaching";
import { useSettingsStore } from "@/stores/settings-store";

interface LatexTeachState {
  open: boolean;
  lesson: TeachLessonRef | null;
  sourceKey: string | null;
  present: (lesson: TeachLessonRef, sourceKey: string) => void;
  forcePresent: (lesson: TeachLessonRef, sourceKey: string) => void;
  dismiss: () => void;
  reset: () => void;
}

const closed = {
  open: false,
  lesson: null,
  sourceKey: null,
} as const;

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

export const useLatexTeachStore = create<LatexTeachState>((set, get) => ({
  ...closed,
  present: (lesson, sourceKey) => {
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
    set({ open: true, lesson, sourceKey });
  },
  forcePresent: (lesson, sourceKey) => {
    if (!teachingEnabled()) return;
    set({ open: true, lesson, sourceKey });
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
