import type { MessageKey } from "@/lib/i18n";

export type ProductTourStatus = "pending" | "completed" | "skipped";

/**
 * Bump when the tour steps change so a completed or skipped older tour
 * shows once more. 1 was the home-screen tour. 2 is the LaTeX workspace tour.
 */
export const PRODUCT_TOUR_VERSION = 2;

export interface ProductTourStep {
  id: "files" | "zotero" | "latex" | "chat" | "pdf" | "agents-skills";
  anchor: string;
  titleKey: MessageKey;
  bodyKey: MessageKey;
}

export const PRODUCT_TOUR_STEPS: readonly ProductTourStep[] = [
  {
    id: "files",
    anchor: "tour-files",
    titleKey: "tour.files.title",
    bodyKey: "tour.files.body",
  },
  {
    id: "zotero",
    anchor: "tour-zotero",
    titleKey: "tour.zotero.title",
    bodyKey: "tour.zotero.body",
  },
  {
    id: "latex",
    anchor: "tour-latex",
    titleKey: "tour.latex.title",
    bodyKey: "tour.latex.body",
  },
  {
    id: "chat",
    anchor: "tour-chat",
    titleKey: "tour.chat.title",
    bodyKey: "tour.chat.body",
  },
  {
    id: "pdf",
    anchor: "tour-pdf",
    titleKey: "tour.pdf.title",
    bodyKey: "tour.pdf.body",
  },
  {
    id: "agents-skills",
    anchor: "tour-agents-skills",
    titleKey: "tour.agentsSkills.title",
    bodyKey: "tour.agentsSkills.body",
  },
];

export function normalizeProductTourStatus(value: unknown): ProductTourStatus {
  return value === "completed" || value === "skipped" ? value : "pending";
}

/**
 * A stored tour counts only for the current version. Older completions and
 * skips become pending so the LaTeX workspace tour can show once.
 */
export function resolveStoredProductTour(
  storedVersion: unknown,
  status: unknown,
): ProductTourStatus {
  if (storedVersion !== PRODUCT_TOUR_VERSION) return "pending";
  return normalizeProductTourStatus(status);
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
