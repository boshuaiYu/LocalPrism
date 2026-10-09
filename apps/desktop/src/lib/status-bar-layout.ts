import {
  chatStripLabelPx,
  measureChatStripCanvasPx,
} from "@/lib/chat-tab-strip";

/**
 * Footer version row.
 *
 * The project sidebar footer is about 210px. Windows, macOS, and Linux do
 * not share a UI font, so the fit check uses the chat strip's 12px upper
 * bound (text-xs): the widest Latin advance, and 1em for each CJK
 * character. A canvas or nowrap span measurement can only raise that
 * bound, never lower it, so a narrower local font cannot leave a label
 * on one line that would clip on a wider one.
 *
 * gap-1.5 between the version and the hint. The clickable hint also has
 * px-1. Those are spacing, not measured glyphs.
 */

/** gap-1.5 */
export const STATUS_VERSION_NOTICE_GAP_PX = 6;
/** px-1 on the hint button. A plain status span has no horizontal pad. */
export const STATUS_NOTICE_BUTTON_PAD_PX = 8;

export type StatusVersionNoticeLayout = "inline" | "stacked";

export type StatusVersionNoticePlan = {
  /** Hint beside the version, or on the next line when the pair does not fit. */
  layout: StatusVersionNoticeLayout;
  /** The version string itself fits the cluster on one line. */
  versionFits: boolean;
  /** The hint, including its button padding, fits the cluster on one line. */
  noticeFits: boolean;
};

/**
 * Raw label width from canvas and a nowrap span. Undefined when nothing
 * measured. Callers pass this into the plan, which keeps the shared upper
 * bound unless the measurement is wider.
 */
export function statusLabelMeasurementPx(
  text: string,
  renderedPx?: number,
): number | undefined {
  const rendered =
    renderedPx != null && Number.isFinite(renderedPx) && renderedPx > 0
      ? renderedPx
      : 0;
  const canvas = measureChatStripCanvasPx(text);
  const measured = Math.max(rendered, Number.isFinite(canvas) ? canvas : 0);
  if (measured <= 0) return undefined;
  return Math.ceil(measured);
}

export type MeasuredLabelWidth = {
  label: string;
  px: number;
};

/**
 * A live width belongs to the label that was measured. A leftover wider
 * width does not apply to the next string.
 */
export function measuredLabelPx(
  measured: MeasuredLabelWidth | undefined,
  label: string,
): number | undefined {
  if (!measured || measured.label !== label) return undefined;
  if (!Number.isFinite(measured.px) || measured.px <= 0) return undefined;
  return measured.px;
}

export function rememberMeasuredLabel(
  previous: MeasuredLabelWidth | undefined,
  label: string,
  px: number | undefined,
): MeasuredLabelWidth | undefined {
  if (px == null || !Number.isFinite(px) || px <= 0) return undefined;
  if (previous?.label === label && previous.px === px) return previous;
  return { label, px };
}

export function planStatusVersionNotice(input: {
  /** Content box of the version cluster, not the whole footer. */
  availablePx: number;
  versionLabel: string;
  noticeLabel?: string | null;
  /** Horizontal chrome around the notice label. 0 for a plain span. */
  noticeChromePx?: number;
  measuredVersionPx?: number;
  measuredNoticePx?: number;
}): StatusVersionNoticePlan {
  const notice = input.noticeLabel ?? "";
  const versionPx = chatStripLabelPx(
    input.versionLabel,
    input.measuredVersionPx,
  );
  const chrome = notice ? Math.max(0, input.noticeChromePx ?? 0) : 0;
  const noticePx = notice
    ? chatStripLabelPx(notice, input.measuredNoticePx) + chrome
    : 0;
  const available = input.availablePx;
  const known = Number.isFinite(available) && available > 0;
  const versionFits = !known || versionPx <= available;
  const noticeFits = !notice || !known || noticePx <= available;
  if (!notice || !known) {
    return { layout: "inline", versionFits, noticeFits };
  }
  const needed = versionPx + STATUS_VERSION_NOTICE_GAP_PX + noticePx;
  return {
    layout: needed <= available ? "inline" : "stacked",
    versionFits,
    noticeFits,
  };
}
