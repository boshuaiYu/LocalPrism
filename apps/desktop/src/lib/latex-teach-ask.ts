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

export function teachAskReplyNote(language: UiLanguage): string {
  return translate(language, "teach.askReplyFormat");
}

/** Both languages, so a resumed transcript can drop whichever note was sent. */
export const TEACH_ASK_REPLY_NOTES: readonly string[] = [
  teachAskReplyNote("en"),
  teachAskReplyNote("zh"),
];

/** Appended to the model prompt only. The learning bubble keeps the lesson text. */
export function appendTeachAskReplyNote(
  prompt: string,
  language: UiLanguage,
): string {
  const note = teachAskReplyNote(language);
  const base = prompt.replace(/\s+$/, "");
  if (!note || base.endsWith(note)) return base;
  return `${base}\n\n${note}`;
}

export function stripTeachAskReplyNote(text: string): string {
  let current = text;
  for (;;) {
    // JSONL rows often end in `\n` or `\r\n`. Trim every trailing whitespace
    // character before the suffix check, then keep the original text when
    // the note is absent.
    const end = current.replace(/\s+$/g, "");
    const note = TEACH_ASK_REPLY_NOTES.find(
      (item) => item && end.endsWith(item),
    );
    if (!note) return current;
    current = end.slice(0, -note.length).replace(/\s+$/g, "");
  }
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
