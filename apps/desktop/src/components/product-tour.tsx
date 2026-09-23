import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
} from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/use-i18n";
import {
  PRODUCT_TOUR_STEPS,
  productTourAfterBack,
  productTourAfterNext,
  shouldAutoShowProductTour,
} from "@/lib/product-tour";
import { useSettingsStore } from "@/stores/settings-store";

interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function measureAnchor(anchor: string): AnchorRect | null {
  const node = document.querySelector(`[data-tour="${anchor}"]`);
  if (!(node instanceof HTMLElement)) return null;
  const rect = node.getBoundingClientRect();
  if (rect.width < 2 && rect.height < 2) return null;
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
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
  const step = PRODUCT_TOUR_STEPS[index] ?? PRODUCT_TOUR_STEPS[0];
  const visible = hydrated && shouldAutoShowProductTour(status) && step;

  const refreshRect = useCallback(() => {
    if (!step) return;
    setRect(measureAnchor(step.anchor));
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

  useLayoutEffect(() => {
    if (!visible) return;
    refreshRect();
    const onChange = () => refreshRect();
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
    };
  }, [refreshRect, visible]);

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
  const cardStyle: CSSProperties = rect
    ? {
        top: Math.min(rect.top + rect.height + 12, window.innerHeight - 220),
        left: Math.min(Math.max(16, rect.left), window.innerWidth - 360),
      }
    : {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      };

  return (
    <div
      className="fixed inset-0 z-[70]"
      data-testid="product-tour"
      role="dialog"
      aria-modal="true"
      aria-labelledby="product-tour-title"
    >
      {rect ? (
        <div className="absolute inset-0" />
      ) : (
        <div className="absolute inset-0 bg-black/55" />
      )}
      {rect && (
        <div
          className="pointer-events-none absolute rounded-lg border-2 border-background shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
          style={{
            top: Math.max(0, rect.top - 6),
            left: Math.max(0, rect.left - 6),
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      )}
      <div
        className="absolute z-10 w-[min(22rem,calc(100vw-2rem))] rounded-xl border bg-background p-4 text-foreground shadow-xl"
        style={cardStyle}
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
              onClick={() => {
                const next = productTourAfterNext(index);
                if (next.status === "completed") {
                  setProductTour("completed");
                  return;
                }
                setIndex(next.index);
              }}
            >
              {last ? t("tour.done") : t("tour.next")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
