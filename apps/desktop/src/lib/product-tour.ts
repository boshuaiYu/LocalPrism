import type { MessageKey } from "@/lib/i18n";

export type ProductTourStatus = "pending" | "completed" | "skipped";

export interface ProductTourStep {
  id: "projects" | "zotero" | "agents" | "compile";
  anchor: string;
  titleKey: MessageKey;
  bodyKey: MessageKey;
}

export const PRODUCT_TOUR_STEPS: readonly ProductTourStep[] = [
  {
    id: "projects",
    anchor: "tour-projects",
    titleKey: "tour.projects.title",
    bodyKey: "tour.projects.body",
  },
  {
    id: "zotero",
    anchor: "tour-zotero",
    titleKey: "tour.zotero.title",
    bodyKey: "tour.zotero.body",
  },
  {
    id: "agents",
    anchor: "tour-agents",
    titleKey: "tour.agents.title",
    bodyKey: "tour.agents.body",
  },
  {
    id: "compile",
    anchor: "tour-compile",
    titleKey: "tour.compile.title",
    bodyKey: "tour.compile.body",
  },
];

export function normalizeProductTourStatus(value: unknown): ProductTourStatus {
  return value === "completed" || value === "skipped" ? value : "pending";
}

/** Auto-show only until the user finishes or skips. */
export function shouldAutoShowProductTour(status: unknown): boolean {
  return normalizeProductTourStatus(status) === "pending";
}

export function productTourAfterNext(
  index: number,
  stepCount = PRODUCT_TOUR_STEPS.length,
): { index: number; status: ProductTourStatus } {
  if (index >= stepCount - 1) {
    return { index: Math.max(0, stepCount - 1), status: "completed" };
  }
  return { index: index + 1, status: "pending" };
}

export function productTourAfterBack(index: number): number {
  return Math.max(0, index - 1);
}

export function productTourAfterSkip(): ProductTourStatus {
  return "skipped";
}
