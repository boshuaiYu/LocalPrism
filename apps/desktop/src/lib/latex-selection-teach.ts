import {
  lessonRefForSelection,
  type TeachLessonRef,
} from "@/lib/latex-teaching";

/**
 * Editor selections already show the Proofread toolbar.
 * A selection-opened teach float uses this source prefix (`sel:<from>:<to>`).
 * Diagnostic, compile, and guide lessons use other keys and stay put.
 */
export function isSelectionTeachSource(
  sourceKey: string | null | undefined,
): boolean {
  return typeof sourceKey === "string" && sourceKey.startsWith("sel:");
}

/**
 * While the selection toolbar is the surface for this selection, drop a
 * float that was opened from an earlier selection so it does not cover
 * Proofread. Do not open a new lesson here.
 */
export function releaseSelectionLessonForToolbar(state: {
  open: boolean;
  sourceKey: string | null;
  dismiss: () => void;
}): void {
  if (state.open && isSelectionTeachSource(state.sourceKey)) {
    state.dismiss();
  }
}

export function selectionExplainAction(input: {
  teachingEnabled: boolean;
  isTex: boolean;
  from: number;
  to: number;
  selected: string;
  line: string;
  selectionStartInLine: number;
  selectionEndInLine: number;
}): { lesson: TeachLessonRef; sourceKey: string } | null {
  if (input.teachingEnabled !== true || input.isTex !== true) return null;
  const lesson = lessonRefForSelection({
    selected: input.selected,
    line: input.line,
    selectionStartInLine: input.selectionStartInLine,
    selectionEndInLine: input.selectionEndInLine,
  });
  if (!lesson) return null;
  return { lesson, sourceKey: `sel:${input.from}:${input.to}` };
}
