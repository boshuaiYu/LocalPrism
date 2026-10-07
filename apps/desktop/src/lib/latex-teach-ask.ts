import { translate, type UiLanguage } from "@/lib/i18n";
import type { TeachLesson, TeachLessonKind } from "@/lib/latex-teaching";

export interface TeachAskPromptInput {
  lesson: Pick<TeachLesson, "kind" | "tag" | "title" | "what">;
  language: UiLanguage;
  /** Error lessons: short extracted detail, such as a missing file name. */
  detail?: string | null;
  /** Error lessons: compiler or diagnostic text when it is known. */
  diagnosticMessage?: string | null;
  /** Construct lessons: the editor selection that opened the lesson. */
  selectedText?: string | null;
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

/**
 * Diagnostic and compile lessons store the raw message after the second colon
 * (`diag:<id>:<message>`, `compile:<index>:<message>`).
 */
export function diagnosticMessageFromTeachSource(
  sourceKey: string | null | undefined,
  kind: TeachLessonKind,
): string {
  if (kind !== "error" || !sourceKey) return "";
  const match = /^(?:diag|compile):[^:]*:([\s\S]+)$/.exec(sourceKey);
  return clean(match?.[1]);
}

/**
 * Localized prompt for the teach card's Ask AI action.
 * The local lesson stays on screen; this text is what chat receives.
 */
export function buildTeachAskPrompt(input: TeachAskPromptInput): string {
  const { lesson, language } = input;
  if (lesson.kind === "guide") {
    return translate(language, "teach.askGuide", {
      title: lesson.title,
      what: lesson.what,
    });
  }
  if (lesson.kind === "error") {
    const detail = clean(input.detail);
    const message = clean(input.diagnosticMessage);
    const parts = [
      translate(language, "teach.askError", {
        tag: lesson.tag,
        title: lesson.title,
      }),
    ];
    if (detail) {
      parts.push(translate(language, "teach.askErrorDetail", { detail }));
    }
    if (message && message !== detail) {
      parts.push(translate(language, "teach.askErrorMessage", { message }));
    }
    return parts.join("\n");
  }
  const intro = translate(language, "teach.askConstruct", {
    tag: lesson.tag,
    title: lesson.title,
    what: lesson.what,
  });
  const selected = clean(input.selectedText);
  if (!selected) return intro;
  return `${intro}\n\n${translate(language, "teach.askSelected", { selected })}`;
}
