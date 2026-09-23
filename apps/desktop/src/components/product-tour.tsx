import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/use-i18n";
import {
  PRODUCT_TOUR_CUE_RETRY_MS,
  PRODUCT_TOUR_STEPS,
  dispatchProductTourCue,
  findProductTourElement,
  isProductTourOverlayActive,
  productTourAfterBack,
  productTourAfterNext,
  productTourCardPosition,
  productTourClickAdvances,
  productTourRetryCues,
  productTourShieldRects,
  setProductTourOverlayActive,
  shouldAutoShowProductTour,
  subscribeProductTourOverlay,
} from "@/lib/product-tour";
import { useSettingsStore } from "@/stores/settings-store";

interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function sameRect(a: AnchorRect | null, b: AnchorRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height
  );
}

function measureStep(
  step: (typeof PRODUCT_TOUR_STEPS)[number],
): AnchorRect | null {
  const node = findProductTourElement(step);
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

/** While the tour is up, dialogs stay clickable so Next is not trapped outside. */
export function useProductTourDialogGuard(): {
  modal: boolean;
  onInteractOutside: (event: { preventDefault: () => void }) => void;
} {
  const tourOverlay = useSyncExternalStore(
    subscribeProductTourOverlay,
    isProductTourOverlayActive,
    () => false,
  );
  return {
    modal: !tourOverlay,
    onInteractOutside: (event) => {
      if (tourOverlay) event.preventDefault();
    },
  };
}

export function ProductTour() {
  const { t } = useI18n();
  const status = useSettingsStore((state) => state.productTour);
  const setProductTour = useSettingsStore((state) => state.setProductTour);
  const [hydrated, setHydrated] = useState(() =>
    useSettingsStore.persist.hasHydrated(),
  );
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const rectRef = useRef<AnchorRect | null>(null);
  const scrolledStep = useRef<string | null>(null);
  const wasVisible = useRef(false);
  const step = PRODUCT_TOUR_STEPS[index] ?? PRODUCT_TOUR_STEPS[0];
  const visible =
    hydrated && shouldAutoShowProductTour(status) && Boolean(step);

  const goNext = useCallback(() => {
    const next = productTourAfterNext(index);
    if (next.status === "completed") {
      setProductTour("completed");
      return;
    }
    setIndex(next.index);
  }, [index, setProductTour]);

  const refreshRect = useCallback(() => {
    if (!step) return;
    const node = findProductTourElement(step);
    if (node && scrolledStep.current !== step.id) {
      scrolledStep.current = step.id;
      node.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
    const next = measureStep(step);
    const nextViewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };
    setViewport((current) =>
      current.width === nextViewport.width &&
      current.height === nextViewport.height
        ? current
        : nextViewport,
    );
    if (sameRect(rectRef.current, next)) return;
    rectRef.current = next;
    setRect(next);
  }, [step]);

  useLayoutEffect(() => {
    if (useSettingsStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    return useSettingsStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    setProductTourOverlayActive(visible);
    if (wasVisible.current && !visible) {
      dispatchProductTourCue("close-overlays");
    }
    wasVisible.current = visible;
    return () => setProductTourOverlayActive(false);
  }, [visible]);

  useEffect(() => {
    scrolledStep.current = null;
  }, [step]);

  useEffect(() => {
    if (!visible || !step) return;
    const cues = step.enter ?? [];
    for (const cue of cues) dispatchProductTourCue(cue);
    const retry = productTourRetryCues(step);
    if (retry.length === 0) return;
    const timers = PRODUCT_TOUR_CUE_RETRY_MS.map((delay) =>
      window.setTimeout(() => {
        if (findProductTourElement(step)) return;
        for (const cue of retry) dispatchProductTourCue(cue);
      }, delay),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [step, visible]);

  useLayoutEffect(() => {
    if (!visible) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        refreshRect();
      });
    };
    refreshRect();
    const onResize = () => refreshRect();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [refreshRect, visible]);

  useEffect(() => {
    if (!visible || !step?.advanceOnTargetClick) return;
    const onClick = (event: MouseEvent) => {
      if (productTourClickAdvances(step, event.target)) goNext();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [goNext, step, visible]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProductTour("skipped");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setProductTour, visible]);

  if (!visible || !step) return null;

  const last = index >= PRODUCT_TOUR_STEPS.length - 1;
  const hole = rect && step.advanceOnTargetClick ? rect : null;
  const shields = hole ? productTourShieldRects(viewport, hole) : null;
  const placed = rect ? productTourCardPosition(rect, viewport) : null;
  const cardStyle: CSSProperties = placed
    ? { top: placed.top, left: placed.left }
    : {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      };

  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-[10050]"
      data-testid="product-tour"
    >
      {shields ? (
        shields.map((shield) => (
          <div
            key={`${shield.top}:${shield.left}:${shield.width}:${shield.height}`}
            data-testid="product-tour-shield"
            aria-hidden
            className="pointer-events-auto absolute z-0"
            style={shield}
          />
        ))
      ) : (
        <div
          data-testid="product-tour-shield"
          aria-hidden
          className="pointer-events-auto absolute inset-0 z-0"
        />
      )}
      {rect ? (
        <div
          className="pointer-events-none absolute rounded-lg border-2 border-background shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
          style={{
            top: Math.max(0, rect.top - 6),
            left: Math.max(0, rect.left - 6),
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-black/45" />
      )}
      <div
        className="pointer-events-auto absolute z-10 w-[min(22rem,calc(100vw-2rem))] rounded-xl border bg-background p-4 text-foreground shadow-xl"
        style={cardStyle}
        role="dialog"
        aria-modal="false"
        aria-labelledby="product-tour-title"
      >
        <p className="text-muted-foreground text-xs">
          {t("tour.progress", {
            current: index + 1,
            total: PRODUCT_TOUR_STEPS.length,
          })}
        </p>
        <h2 id="product-tour-title" className="mt-1 font-medium text-sm">
          {t(step.titleKey)}
        </h2>
        <p className="mt-2 text-sm leading-relaxed">{t(step.bodyKey)}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-8 px-2 text-xs"
            data-testid="product-tour-skip"
            onClick={() => setProductTour("skipped")}
          >
            {t("tour.skip")}
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-8 px-3 text-xs"
              data-testid="product-tour-back"
              disabled={index === 0}
              onClick={() =>
                setIndex((current) => productTourAfterBack(current))
              }
            >
              {t("tour.back")}
            </Button>
            <Button
              type="button"
              className="h-8 px-3 text-xs"
              data-testid="product-tour-next"
              onClick={goNext}
            >
              {last ? t("tour.done") : t("tour.next")}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
