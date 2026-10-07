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

function teachingEnabled(): boolean {
  return useSettingsStore.getState().latexTeaching === true;
}

export const useLatexTeachStore = create<LatexTeachState>((set, get) => ({
  ...closed,
  present: (lesson, sourceKey) => {
    if (!teachingEnabled()) return;
    const current = get();
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
