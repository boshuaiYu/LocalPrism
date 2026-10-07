import { useEffect } from "react";
import { BookOpenIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MessageKey } from "@/lib/i18n";
import {
  EMPTY_PROJECT_LESSON,
  resolveLesson,
  shouldOfferEmptyGuide,
  shouldShowTeachEntry,
  shouldShowTeachPanel,
  teachActionForDiagnostic,
  type TeachLesson,
} from "@/lib/latex-teaching";
import { useI18n } from "@/lib/use-i18n";
import { useLatexTeachStore } from "@/stores/latex-teach-store";
import { useSettingsStore } from "@/stores/settings-store";

const KIND_KEY = {
  construct: "teach.kind.construct",
  error: "teach.kind.error",
  guide: "teach.kind.guide",
} as const satisfies Record<TeachLesson["kind"], MessageKey>;

export function TeachPanel({
  onInsert,
}: {
  onInsert?: (snippet: string) => void;
}) {
  const enabled = useSettingsStore((state) => state.latexTeaching);
  const language = useSettingsStore((state) => state.uiLanguage);
  const open = useLatexTeachStore((state) => state.open);
  const lessonRef = useLatexTeachStore((state) => state.lesson);
  const dismiss = useLatexTeachStore((state) => state.dismiss);
  const { t } = useI18n();

  useEffect(() => {
    if (!enabled) useLatexTeachStore.getState().reset();
  }, [enabled]);

  if (!shouldShowTeachPanel(enabled, open) || !lessonRef) return null;

  const lesson = resolveLesson(lessonRef, language);
  const snippet = lesson.snippet;
  const bannerClass =
    lesson.tone === "error"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-primary/30 bg-primary/10 text-primary";

  return (
    <aside
      className="flex h-full min-h-0 w-[min(20rem,42%)] shrink-0 flex-col border-border border-l bg-card"
      data-testid="latex-teach-panel"
    >
      <header className="flex items-center justify-between gap-2 border-border border-b px-3 py-2">
        <h2 className="flex min-w-0 items-center gap-2 font-medium text-sm">
          <BookOpenIcon className="size-4 shrink-0 text-primary" />
          <span className="truncate">{t("teach.panelTitle")}</span>
        </h2>
        <Button
          aria-label={t("teach.close")}
          data-testid="latex-teach-close"
          onClick={dismiss}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div
          className={`mb-3 rounded-md border px-2.5 py-2 text-xs ${bannerClass}`}
        >
          <span className="font-mono">{lesson.tag}</span>
          <p className="mt-1 text-foreground">{lesson.banner}</p>
        </div>
        <p className="mb-1 font-medium text-[11px] text-muted-foreground">
          {t(KIND_KEY[lesson.kind])}
        </p>
        <h3 className="mb-2 font-medium text-sm">{lesson.title}</h3>
        <h4 className="mb-1 font-medium text-[11px] text-muted-foreground">
          {t("teach.what")}
        </h4>
        <p className="mb-3 text-muted-foreground text-xs leading-relaxed">
          {lesson.what}
        </p>
        {lesson.points.length > 0 && (
          <>
            <h4 className="mb-1 font-medium text-[11px] text-muted-foreground">
              {t("teach.patterns")}
            </h4>
            <ul className="mb-3 list-disc space-y-1 pl-4 text-muted-foreground text-xs leading-relaxed">
              {lesson.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </>
        )}
        {snippet && (
          <div className="overflow-hidden rounded-md border border-border bg-muted/40">
            <div className="border-border border-b px-2 py-1 text-[11px] text-muted-foreground">
              {t("teach.example")}
            </div>
            <pre className="overflow-x-auto p-2 font-mono text-[11px] text-foreground leading-relaxed">
              {snippet}
            </pre>
          </div>
        )}
        {lesson.source && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {lesson.source}
          </p>
        )}
        {lesson.insertable && snippet && onInsert && (
          <Button
            className="mt-3 w-full"
            onClick={() => onInsert(snippet)}
            size="sm"
            type="button"
          >
            {t("teach.insert")}
          </Button>
        )}
      </div>
    </aside>
  );
}

export function TeachEmptyEntry({ content }: { content: string }) {
  const enabled = useSettingsStore((state) => state.latexTeaching);
  const { t } = useI18n();
  if (!shouldOfferEmptyGuide(enabled, content)) return null;

  return (
    <button
      className="flex w-full items-center gap-2 border-border border-b bg-primary/5 px-3 py-1.5 text-left text-muted-foreground text-xs hover:bg-primary/10"
      data-testid="latex-teach-empty-entry"
      onClick={() => {
        useLatexTeachStore
          .getState()
          .forcePresent(EMPTY_PROJECT_LESSON, "guide:empty");
      }}
      type="button"
    >
      <BookOpenIcon className="size-3.5 shrink-0 text-primary" />
      <span>{t("teach.emptyEntry")}</span>
    </button>
  );
}

export function TeachDiagnosticButton({
  message,
  sourceKey,
}: {
  message: string;
  sourceKey?: string;
}) {
  const enabled = useSettingsStore((state) => state.latexTeaching);
  const { t } = useI18n();
  if (!shouldShowTeachEntry(enabled)) return null;

  return (
    <button
      className="ml-auto shrink-0 rounded px-1.5 py-0.5 font-medium text-primary text-xs hover:bg-primary/10"
      data-testid="latex-teach-diagnostic"
      onClick={(event) => {
        event.stopPropagation();
        const action = teachActionForDiagnostic(true, message);
        if (!action) return;
        useLatexTeachStore
          .getState()
          .forcePresent(action.ref, sourceKey ?? action.sourceKey);
      }}
      title={t("teach.entryHint")}
      type="button"
    >
      {t("teach.entry")}
    </button>
  );
}
