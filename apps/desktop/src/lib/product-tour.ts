import type { MessageKey } from "@/lib/i18n";

export type ProductTourStatus = "pending" | "completed" | "skipped";

/**
 * Bump when the tour steps change so a completed or skipped older tour
 * shows once more.
 * 1 was the home-screen tour.
 * 2 was the LaTeX workspace tour.
 * 3 adds Skills, Agents, and the update control.
 */
export const PRODUCT_TOUR_VERSION = 3;

export const PRODUCT_TOUR_EVENT = "localprism-product-tour";

/** Cues the workspace already knows how to follow. Not a second tour system. */
export type ProductTourCue =
  | "close-overlays"
  | "open-skills"
  | "open-agents"
  | "show-chat"
  | "open-agent-menu";

export type ProductTourStepId =
  | "files"
  | "zotero"
  | "latex"
  | "chat"
  | "pdf"
  | "skills"
  | "skill-categories"
  | "skill-import"
  | "agents"
  | "agent-roles"
  | "agent-skills"
  | "updates";

export interface ProductTourStep {
  id: ProductTourStepId;
  /**
   * `data-tour` values, first visible match wins.
   * Extra names stay so a slightly renamed control still lights up.
   */
  anchors: readonly string[];
  /** Raw CSS selectors tried after `anchors`. */
  selectors?: readonly string[];
  titleKey: MessageKey;
  bodyKey: MessageKey;
  /** Run when the step becomes active so the hotspot is on screen. */
  enter?: readonly ProductTourCue[];
  /** Clicking the hotspot advances, after the control's own click handler. */
  advanceOnTargetClick?: boolean;
}

export const PRODUCT_TOUR_STEPS: readonly ProductTourStep[] = [
  {
    id: "files",
    anchors: ["tour-files"],
    titleKey: "tour.files.title",
    bodyKey: "tour.files.body",
    enter: ["close-overlays"],
  },
  {
    id: "zotero",
    anchors: ["tour-zotero"],
    titleKey: "tour.zotero.title",
    bodyKey: "tour.zotero.body",
    enter: ["close-overlays"],
  },
  {
    id: "latex",
    anchors: ["tour-latex"],
    titleKey: "tour.latex.title",
    bodyKey: "tour.latex.body",
    enter: ["close-overlays"],
  },
  {
    id: "chat",
    anchors: ["tour-chat"],
    titleKey: "tour.chat.title",
    bodyKey: "tour.chat.body",
    enter: ["close-overlays"],
  },
  {
    id: "pdf",
    anchors: ["tour-pdf"],
    titleKey: "tour.pdf.title",
    bodyKey: "tour.pdf.body",
    enter: ["close-overlays"],
  },
  {
    id: "skills",
    anchors: ["tour-skills", "tour-agents-skills"],
    titleKey: "tour.skills.title",
    bodyKey: "tour.skills.body",
    enter: ["close-overlays"],
    advanceOnTargetClick: true,
  },
  {
    id: "skill-categories",
    anchors: ["tour-skill-categories", "tour-skill-packs"],
    titleKey: "tour.skillCategories.title",
    bodyKey: "tour.skillCategories.body",
    enter: ["open-skills"],
  },
  {
    id: "skill-import",
    anchors: [
      "tour-skill-import",
      "tour-add-skill",
      "tour-skill-settings-import",
    ],
    titleKey: "tour.skillImport.title",
    bodyKey: "tour.skillImport.body",
    enter: ["open-skills"],
  },
  {
    id: "agents",
    anchors: ["tour-agents-open", "tour-agents"],
    titleKey: "tour.agents.title",
    bodyKey: "tour.agents.body",
    enter: ["close-overlays"],
    advanceOnTargetClick: true,
  },
  {
    id: "agent-roles",
    anchors: ["tour-agent-list", "tour-agent-presets"],
    titleKey: "tour.agentRoles.title",
    bodyKey: "tour.agentRoles.body",
    enter: ["open-agents"],
  },
  {
    id: "agent-skills",
    anchors: ["tour-agent-menu", "tour-agent-switch", "tour-agent-skills"],
    titleKey: "tour.agentSkills.title",
    bodyKey: "tour.agentSkills.body",
    enter: ["close-overlays", "show-chat", "open-agent-menu"],
  },
  {
    id: "updates",
    anchors: [
      "tour-update-bar",
      "tour-update-cycle",
      "tour-updates",
      "tour-beta",
    ],
    selectors: [
      '[data-testid="update-cycle"]',
      '[data-testid="beta-updates"]',
      '[data-testid="updates-beta"]',
      '[data-testid="beta-channel"]',
      '[data-testid="check-for-updates"]',
    ],
    titleKey: "tour.updates.title",
    bodyKey: "tour.updates.body",
    enter: ["close-overlays"],
  },
];

export function normalizeProductTourStatus(value: unknown): ProductTourStatus {
  return value === "completed" || value === "skipped" ? value : "pending";
}

/**
 * A stored tour counts only for the current version. Older completions and
 * skips become pending so the latest workspace tour can show once.
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

export function dispatchProductTourCue(cue: ProductTourCue): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PRODUCT_TOUR_EVENT, { detail: cue }));
}

function tourAttributeSelector(anchor: string): string | null {
  if (!/^[a-z0-9-]+$/i.test(anchor)) return null;
  return `[data-tour="${anchor}"]`;
}

export function productTourSelectors(step: ProductTourStep): string[] {
  const anchors = step.anchors.flatMap((anchor) => {
    const selector = tourAttributeSelector(anchor);
    return selector ? [selector] : [];
  });
  return [...anchors, ...(step.selectors ?? [])];
}

export function isVisibleTourElement(node: Element): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false;
  const rect = node.getBoundingClientRect();
  return rect.width >= 2 && rect.height >= 2;
}

/** First on-screen match. Zero-size placeholders are skipped. */
export function findProductTourElement(
  step: ProductTourStep,
  root: ParentNode = document,
): HTMLElement | null {
  for (const selector of productTourSelectors(step)) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = root.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (isVisibleTourElement(node)) return node;
    }
  }
  return null;
}

/** True when the click landed on this step's hotspot, even before layout. */
export function productTourClickAdvances(
  step: ProductTourStep,
  target: EventTarget | null,
  root: ParentNode = document,
): boolean {
  if (!step.advanceOnTargetClick || !(target instanceof Node)) return false;
  for (const selector of productTourSelectors(step)) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = root.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (node.contains(target)) return true;
    }
  }
  return false;
}

const TOUR_CARD_WIDTH = 352;
const TOUR_CARD_HEIGHT = 176;
const TOUR_CARD_GAP = 12;

export function productTourCardPosition(
  rect: { top: number; left: number; width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number; place: "above" | "below" } {
  const left = Math.min(
    Math.max(16, rect.left),
    Math.max(16, viewport.width - TOUR_CARD_WIDTH - 16),
  );
  const belowTop = rect.top + rect.height + TOUR_CARD_GAP;
  const aboveTop = rect.top - TOUR_CARD_HEIGHT - TOUR_CARD_GAP;
  const fitsBelow = belowTop + TOUR_CARD_HEIGHT <= viewport.height - 16;
  const place = fitsBelow || aboveTop < 16 ? "below" : "above";
  const top =
    place === "below"
      ? Math.min(
          belowTop,
          Math.max(16, viewport.height - TOUR_CARD_HEIGHT - 16),
        )
      : Math.max(16, aboveTop);
  return { top, left, place };
}

let overlayActive = false;
const overlayListeners = new Set<() => void>();

export function setProductTourOverlayActive(active: boolean): void {
  if (overlayActive === active) return;
  overlayActive = active;
  for (const listener of overlayListeners) listener();
}

export function subscribeProductTourOverlay(listener: () => void): () => void {
  overlayListeners.add(listener);
  return () => overlayListeners.delete(listener);
}

export function isProductTourOverlayActive(): boolean {
  return overlayActive;
}
