import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
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
import {
  clampTeachFloat,
  placeTeachFloat,
  TEACH_FLOAT_HEIGHT,
  TEACH_FLOAT_WIDTH,
  type TeachAnchor,
} from "@/lib/teach-float";
import { useI18n } from "@/lib/use-i18n";
import { cn } from "@/lib/utils";
import {
  insertRegisteredTeachSnippet,
  useLatexTeachStore,
} from "@/stores/latex-teach-store";
import { useSettingsStore } from "@/stores/settings-store";

const KIND_KEY = {
  construct: "teach.kind.construct",
  error: "teach.kind.error",
  guide: "teach.kind.guide",
} as const satisfies Record<TeachLesson["kind"], MessageKey>;

function anchorFromElement(element: Element): TeachAnchor {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function viewportSize(): { width: number; height: number } {
  return {
    width: window.innerWidth || 1024,
    height: window.innerHeight || 768,
  };
}

export function TeachPanel({
  onInsert,
}: {
  onInsert?: (snippet: string) => void;
}) {
  const enabled = useSettingsStore((state) => state.latexTeaching);
  const language = useSettingsStore((state) => state.uiLanguage);
  const open = useLatexTeachStore((state) => state.open);
  const lessonRef = useLatexTeachStore((state) => state.lesson);
  const anchor = useLatexTeachStore((state) => state.anchor);
  const placement = useLatexTeachStore((state) => state.placement);
  const insertReady = useLatexTeachStore((state) => state.insertReady);
  const dismiss = useLatexTeachStore((state) => state.dismiss);
  const { t } = useI18n();
  const cardRef = useRef<HTMLDivElement>(null);
  const dragOrigin = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [viewport, setViewport] = useState(viewportSize);
  const [dragPos, setDragPos] = useState<{ left: number; top: number } | null>(
    null,
  );

  useEffect(() => {
    if (!enabled) useLatexTeachStore.getState().reset();
  }, [enabled]);

  useLayoutEffect(() => {
    setDragPos(null);
  }, [placement]);

  useEffect(() => {
    const onResize = () => setViewport(viewportSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const anchored = useMemo(
    () =>
      placeTeachFloat({
        anchor,
        cardWidth: TEACH_FLOAT_WIDTH,
        cardHeight: TEACH_FLOAT_HEIGHT,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      }),
    [anchor, viewport.height, viewport.width],
  );
  const position = dragPos ?? anchored;

  if (!shouldShowTeachPanel(enabled, open) || !lessonRef) return null;

  const lesson = resolveLesson(lessonRef, language);
  const snippet = lesson.snippet;
  const insert =
    onInsert ?? (insertReady ? insertRegisteredTeachSnippet : undefined);
  const errorTone = lesson.tone === "error";
  const bannerClass = errorTone
    ? "border-destructive/30 bg-destructive/10 text-destructive"
    : "border-primary/30 bg-primary/10 text-primary";

  const cardSize = () => {
    const card = cardRef.current;
    return {
      width:
        card && card.offsetWidth > 0 ? card.offsetWidth : TEACH_FLOAT_WIDTH,
      height:
        card && card.offsetHeight > 0 ? card.offsetHeight : TEACH_FLOAT_HEIGHT,
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button")) return;
    event.preventDefault();
    dragOrigin.current = {
      x: event.clientX,
      y: event.clientY,
      left: position.left,
      top: position.top,
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // jsdom rejects capture when the pointer is not considered active.
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const origin = dragOrigin.current;
    if (!origin) return;
    const size = cardSize();
    const view = viewportSize();
    setDragPos(
      clampTeachFloat(
        origin.left + event.clientX - origin.x,
        origin.top + event.clientY - origin.y,
        size.width,
        size.height,
        view.width,
        view.height,
      ),
    );
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    dragOrigin.current = null;
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore release when capture was never taken.
    }
  };

  return createPortal(
    <div
      ref={cardRef}
      aria-label={t("teach.panelTitle")}
      className={cn(
        "fixed z-40 flex max-h-[min(30rem,70vh)] w-[min(22.5rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl",
        errorTone ? "border-destructive/45" : "border-primary/40",
      )}
      aria-modal="false"
      data-testid="latex-teach-panel"
      role="dialog"
      style={{ left: position.left, top: position.top }}
    >
      <header
        className={cn(
          "flex cursor-grab touch-none select-none items-center justify-between gap-2 border-border border-b px-3 py-2.5 active:cursor-grabbing",
          errorTone ? "bg-destructive/10" : "bg-primary/10",
        )}
        data-testid="latex-teach-drag"
        onPointerCancel={onPointerUp}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <h2 className="flex min-w-0 items-center gap-2 font-medium text-sm">
          <span
            className={cn(
              "grid size-5 shrink-0 place-items-center rounded-md border",
              errorTone
                ? "border-destructive/35 bg-destructive/10 text-destructive"
                : "border-primary/30 bg-primary/10 text-primary",
            )}
          >
            <BookOpenIcon className="size-3.5" />
          </span>
          <span className="truncate">{t("teach.panelTitle")}</span>
          <span className="shrink-0 font-normal text-[10px] text-muted-foreground">
            {t("teach.drag")}
          </span>
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
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
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
        {lesson.insertable && snippet && insert && (
          <Button
            className="mt-3 w-full"
            onClick={() => insert(snippet)}
            size="sm"
            type="button"
          >
            {t("teach.insert")}
          </Button>
        )}
      </div>
    </div>,
    document.body,
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
      onClick={(event) => {
        useLatexTeachStore
          .getState()
          .forcePresent(
            EMPTY_PROJECT_LESSON,
            "guide:empty",
            anchorFromElement(event.currentTarget),
          );
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
          .forcePresent(
            action.ref,
            sourceKey ?? action.sourceKey,
            anchorFromElement(event.currentTarget),
          );
      }}
      title={t("teach.entryHint")}
      type="button"
    >
      {t("teach.entry")}
    </button>
  );
}
