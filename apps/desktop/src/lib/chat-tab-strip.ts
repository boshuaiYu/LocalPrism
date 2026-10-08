import { contentPaneSize } from "@/stores/chat-layout-store";

/**
 * Chat tab strip budget.
 *
 * The learning tab is pinned outside the writing scroller. History sessions
 * stay in the history menu; they are never laid out as tabs. A writing tab
 * is never given a 0px floor, so scrollIntoView cannot be the only thing
 * left in the row.
 *
 * Cross-platform: WebView2, WKWebView, and WebKitGTK do not share Segoe UI,
 * SF Pro, Cantarell, or Noto. Fit decisions therefore do not use one OS's
 * glyph width. Latin advances are the max of Inter, Noto Sans, Cantarell,
 * and DejaVu at 12px (at or above Segoe UI and SF Pro for these labels).
 * CJK uses a 1em box, which matches YaHei, PingFang, and Noto Sans CJK.
 * A ResizeObserver or canvas measurement can only raise that budget, never
 * lower it, so a narrower local font cannot reveal a label that would clip
 * on a wider one. Optional chrome (Hide text, provider name) is shown only
 * when the whole string fits. The account chip is never ellipsized.
 */

export const DEFAULT_WINDOW_WIDTH_PX = 1280;

/**
 * Explicit stack so the strip resolves the same families on Windows, macOS,
 * and Linux. Geist covers Latin when it has loaded; the rest are the
 * platform faces, in a fixed order.
 */
export const CHAT_STRIP_FONT_STACK =
  '"Geist", "Segoe UI", "SF Pro Text", Cantarell, "Noto Sans", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif';

export const CHAT_STRIP_FONT_SIZE_PX = 12;

/** ml-1.5 + px-2 + the 14px icon. Spacing, not a measured word. */
export const CHAT_TAB_LEADING_ICON_PX = 36;
/** gap-1.5 between that icon and the Hide label. */
export const CHAT_TAB_LEADING_GAP_PX = 6;
/**
 * Learn control around the label: px-3.5, book icon, gap, streaming dot, gap.
 * The dot is always reserved so a streaming tab does not push the label out.
 */
export const CHAT_TAB_LEARN_CHROME_PX = 62;
/** px-2 + the 14px provider icon. */
export const CHAT_TAB_ACCOUNT_ICON_PX = 30;
/** gap-1.5 between the icon and the provider name. */
export const CHAT_TAB_ACCOUNT_GAP_PX = 6;
/** pr-2.5 on the account cluster. */
export const CHAT_TAB_CLUSTER_PAD_PX = 10;
/** New-tab button, gap, history button, gap before the chip. */
export const CHAT_TAB_UTILITIES_PX = 72;
/** px-3.5 on a writing tab. */
export const CHAT_TAB_WRITING_PAD_PX = 28;
/** Structural floor. A writing tab is never given 0. */
export const CHAT_TAB_WRITING_MIN_PX = 48;
/** One long title may use the free row, but not the whole window. */
export const CHAT_TAB_WRITING_MAX_PX = 320;
export const CHAT_TAB_WRITING_MANY_MAX_PX = 144;
export const CHAT_TAB_MANY_WRITING = 4;
/** Acceptance example: the writing tab should be able to reach this phrase. */
export const CHAT_TAB_WRITING_TARGET = "Proofread and fix any";

/**
 * Half-pixel advances at 12px. Each entry is the max of Inter, Noto Sans,
 * Cantarell, and DejaVu, rounded up. Not a measurement from one OS.
 */
const LATIN_ADVANCE_PX: Record<string, number> = {
  A: 8.5,
  B: 8.5,
  C: 9,
  D: 9.5,
  E: 8,
  F: 7.5,
  G: 9.5,
  H: 9.5,
  I: 4.5,
  J: 7,
  K: 8.5,
  L: 7,
  M: 11,
  N: 9.5,
  O: 9.5,
  P: 8,
  Q: 9.5,
  R: 8.5,
  S: 8,
  T: 8,
  U: 9,
  V: 8.5,
  W: 12,
  X: 8.5,
  Y: 8.5,
  Z: 8.5,
  a: 7.5,
  b: 8,
  c: 7,
  d: 8,
  e: 7.5,
  f: 4.5,
  g: 8,
  h: 8,
  i: 3.5,
  j: 3.5,
  k: 7,
  l: 3.5,
  m: 12,
  n: 8,
  o: 7.5,
  p: 8,
  q: 8,
  r: 5,
  s: 6.5,
  t: 5,
  u: 8,
  v: 7.5,
  w: 10,
  x: 7.5,
  y: 7.5,
  z: 7,
  "0": 8,
  "1": 8,
  "2": 8,
  "3": 8,
  "4": 8,
  "5": 8,
  "6": 8,
  "7": 8,
  "8": 8,
  "9": 8,
  " ": 4,
  "·": 4,
  ".": 4,
  ",": 4,
  ":": 4.5,
  "/": 4.5,
  "-": 6,
  _: 6,
};

function isWideCodepoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/** Shared upper bound for a 12px strip label. Same number on every OS. */
export function chatStripTextUpperBoundPx(text: string): number {
  let width = 0;
  for (const char of text) {
    const known = LATIN_ADVANCE_PX[char];
    if (known != null) {
      width += known;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    width +=
      code <= 0x024f && !isWideCodepoint(code) ? 8 : CHAT_STRIP_FONT_SIZE_PX;
  }
  return Math.ceil(width);
}

/**
 * Label width used for fit decisions. A live measurement (canvas or the
 * rendered span) can only raise the shared bound.
 */
export function chatStripLabelPx(text: string, measuredPx?: number): number {
  const bound = chatStripTextUpperBoundPx(text);
  if (measuredPx != null && Number.isFinite(measuredPx) && measuredPx > bound) {
    return Math.ceil(measuredPx);
  }
  return bound;
}

export function chatTabWritingPreferredPx(): number {
  return (
    chatStripTextUpperBoundPx(CHAT_TAB_WRITING_TARGET) + CHAT_TAB_WRITING_PAD_PX
  );
}

export type AccountHeaderChrome = {
  utilities: boolean;
  hideLabel: boolean;
  density: "full" | "provider";
  accountMin: string;
};

/**
 * Wide bars keep new-tab and history. Those thresholds are column widths,
 * not glyph widths. The strip plan decides whether a label is shown whole.
 */
export function accountHeaderChrome(widthPx: number): AccountHeaderChrome {
  if (!Number.isFinite(widthPx) || widthPx <= 0 || widthPx >= 420) {
    return {
      utilities: true,
      hideLabel: false,
      density: "full",
      accountMin: "min-w-[4.5rem]",
    };
  }
  if (widthPx >= 200) {
    return {
      utilities: false,
      hideLabel: false,
      density: "full",
      accountMin: "min-w-[10rem]",
    };
  }
  return {
    utilities: false,
    hideLabel: true,
    density: "provider",
    accountMin: "min-w-0",
  };
}

export type AccountDensity = "full" | "provider" | "icon";

export type ChatTabStripLabels = {
  learn: string;
  leading: string;
  accountFull: string;
  accountProvider: string;
};

export type ChatTabStripTextPx = {
  learn?: number;
  leading?: number;
  accountFull?: number;
  accountProvider?: number;
};

const DEFAULT_LABELS: ChatTabStripLabels = {
  learn: "Learn LaTeX",
  leading: "Hide",
  accountFull: "DeepSeek",
  accountProvider: "DeepSeek",
};

export type ChatTabStripPlan = {
  pinLearnTab: boolean;
  resolvedBarPx: number;
  showUtilities: boolean;
  hideLeadingLabel: boolean;
  accountDensity: AccountDensity;
  /** Full width of the chosen account cluster, never a sliced label. */
  accountMinPx: number;
  leadingPx: number;
  learnSlotPx: number;
  utilitiesPx: number;
  /** Free width the writing scroller can use after fixed chrome. */
  writingRoomPx: number;
  writingScrollerMinPx: number;
  writingTabMinPx: number;
  writingTabMaxPx: number;
};

/** Chat column at the default 1280 window with code, chat, and PDF open. */
export function defaultThreePaneChatBarPx(
  windowWidthPx = DEFAULT_WINDOW_WIDTH_PX,
): number {
  const percent = contentPaneSize({
    code: true,
    chat: true,
    pdf: true,
    pane: "chat",
  });
  return Math.round((windowWidthPx * percent) / 100);
}

export function chatTabAccountSlotPx(
  density: AccountDensity,
  label: string,
  measuredPx?: number,
): number {
  if (density === "icon") {
    return CHAT_TAB_ACCOUNT_ICON_PX + CHAT_TAB_CLUSTER_PAD_PX;
  }
  return (
    CHAT_TAB_ACCOUNT_ICON_PX +
    CHAT_TAB_ACCOUNT_GAP_PX +
    chatStripLabelPx(label, measuredPx) +
    CHAT_TAB_CLUSTER_PAD_PX
  );
}

function leadingSlotPx(
  hideLabel: boolean,
  label: string,
  measuredPx?: number,
): number {
  if (hideLabel) return CHAT_TAB_LEADING_ICON_PX;
  return (
    CHAT_TAB_LEADING_ICON_PX +
    CHAT_TAB_LEADING_GAP_PX +
    chatStripLabelPx(label, measuredPx)
  );
}

function learnSlotPx(
  hasLearnTab: boolean,
  label: string,
  measuredPx?: number,
): number {
  if (!hasLearnTab) return 0;
  return CHAT_TAB_LEARN_CHROME_PX + chatStripLabelPx(label, measuredPx);
}

type StripChoice = {
  density: AccountDensity;
  hideLeading: boolean;
};

function choiceOrder(hideLocked: boolean): StripChoice[] {
  const densities: AccountDensity[] = ["full", "provider", "icon"];
  const choices: StripChoice[] = [];
  for (const density of densities) {
    if (!hideLocked) choices.push({ density, hideLeading: false });
    choices.push({ density, hideLeading: true });
  }
  return choices;
}

function resolveBarPx(barWidthPx: number, hasLearnTab: boolean): number {
  if (!Number.isFinite(barWidthPx) || barWidthPx <= 0) {
    return hasLearnTab ? defaultThreePaneChatBarPx() : Number.POSITIVE_INFINITY;
  }
  return barWidthPx;
}

export function chatTabStripReservedPx(plan: ChatTabStripPlan): number {
  return (
    plan.leadingPx +
    plan.learnSlotPx +
    plan.writingScrollerMinPx +
    plan.accountMinPx +
    (plan.showUtilities ? plan.utilitiesPx : 0)
  );
}

export function chatTabStripPlan(input: {
  barWidthPx: number;
  writingTabCount: number;
  hasLearnTab: boolean;
  labels?: Partial<ChatTabStripLabels>;
  textPx?: ChatTabStripTextPx;
}): ChatTabStripPlan {
  const labels: ChatTabStripLabels = { ...DEFAULT_LABELS, ...input.labels };
  const textPx = input.textPx ?? {};
  const resolvedBarPx = resolveBarPx(input.barWidthPx, input.hasLearnTab);
  const chrome = accountHeaderChrome(resolvedBarPx);
  const learnPx = learnSlotPx(input.hasLearnTab, labels.learn, textPx.learn);
  const utilitiesPx = chrome.utilities ? CHAT_TAB_UTILITIES_PX : 0;
  const many = input.writingTabCount >= CHAT_TAB_MANY_WRITING;
  const choices = choiceOrder(chrome.hideLabel);

  const roomFor = (choice: StripChoice) => {
    const spent =
      leadingSlotPx(choice.hideLeading, labels.leading, textPx.leading) +
      learnPx +
      chatTabAccountSlotPx(
        choice.density,
        choice.density === "full" ? labels.accountFull : labels.accountProvider,
        choice.density === "full" ? textPx.accountFull : textPx.accountProvider,
      ) +
      utilitiesPx;
    return resolvedBarPx - spent;
  };

  let chosen = choices[choices.length - 1];
  if (!Number.isFinite(resolvedBarPx)) {
    chosen = choices[0];
  } else if (input.hasLearnTab && input.writingTabCount > 0) {
    // Keep the richest chrome that still lets the writing title reach the
    // example phrase. If none can, drop optional labels until the writing
    // floor fits, so the title gets the leftover instead of a sliced chip.
    const preferred = chatTabWritingPreferredPx();
    const richEnough = choices.find((choice) => roomFor(choice) >= preferred);
    if (richEnough) {
      chosen = richEnough;
    } else {
      const fitting = choices.filter(
        (choice) => roomFor(choice) >= CHAT_TAB_WRITING_MIN_PX,
      );
      chosen = fitting.length
        ? fitting[fitting.length - 1]
        : choices[choices.length - 1];
    }
  } else {
    const floor = input.writingTabCount > 0 ? CHAT_TAB_WRITING_MIN_PX : 0;
    const fitting = choices.filter((choice) => roomFor(choice) >= floor);
    chosen = fitting[0] ?? choices[choices.length - 1];
  }

  const leadingPx = leadingSlotPx(
    chosen.hideLeading,
    labels.leading,
    textPx.leading,
  );
  const accountMinPx = chatTabAccountSlotPx(
    chosen.density,
    chosen.density === "full" ? labels.accountFull : labels.accountProvider,
    chosen.density === "full" ? textPx.accountFull : textPx.accountProvider,
  );
  const spent = leadingPx + learnPx + accountMinPx + utilitiesPx;
  const writingRoomPx = Number.isFinite(resolvedBarPx)
    ? Math.max(0, resolvedBarPx - spent)
    : CHAT_TAB_WRITING_MAX_PX;
  const widthCap = many
    ? CHAT_TAB_WRITING_MANY_MAX_PX
    : CHAT_TAB_WRITING_MAX_PX;
  const writingTabMaxPx =
    input.writingTabCount > 0
      ? Math.min(widthCap, Math.max(writingRoomPx, 1))
      : 0;
  const writingTabMinPx =
    input.writingTabCount > 0
      ? Math.max(1, Math.min(CHAT_TAB_WRITING_MIN_PX, writingTabMaxPx))
      : 0;

  return {
    pinLearnTab: input.hasLearnTab,
    resolvedBarPx,
    showUtilities: chrome.utilities,
    hideLeadingLabel: chosen.hideLeading,
    accountDensity: chosen.density,
    accountMinPx,
    leadingPx,
    learnSlotPx: learnPx,
    utilitiesPx,
    writingRoomPx,
    writingScrollerMinPx: writingTabMinPx,
    writingTabMinPx,
    writingTabMaxPx,
  };
}

/** Canvas advance for a strip label. 0 when the context cannot measure. */
export function measureChatStripCanvasPx(text: string): number {
  if (typeof document === "undefined") return 0;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context || typeof context.measureText !== "function") return 0;
    context.font = `${CHAT_STRIP_FONT_SIZE_PX}px ${CHAT_STRIP_FONT_STACK}`;
    const width = context.measureText(text).width;
    if (!Number.isFinite(width) || width < 1) return 0;
    return width;
  } catch {
    return 0;
  }
}
