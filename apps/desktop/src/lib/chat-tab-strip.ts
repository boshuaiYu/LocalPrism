import { contentPaneSize } from "@/stores/chat-layout-store";

type StripChrome = {
  utilities: boolean;
  hideLabel: boolean;
  density: "full" | "provider";
  accountMin: string;
};

/**
 * Pixel budget for the chat tab strip.
 *
 * The learning tab is pinned outside the writing scroller. A long account
 * chip used to keep that scroller at its 4.5rem floor, and scrollIntoView
 * then hid every tab except the active one. History sessions stay out of
 * the strip; only open writing tabs plus this pinned lesson tab are laid out.
 *
 * Widths are Inter 12px stand-ins for the app's sans font:
 * "Learn LaTeX" 72px, "Proofread" 57px, "Hide" 26px. CJK falls back to 1em,
 * so 「边写边学」 is about 48px and fits in the same slot.
 */

export const DEFAULT_WINDOW_WIDTH_PX = 1280;
export const CHAT_TAB_LEADING_ICON_PX = 40;
export const CHAT_TAB_LEADING_LABEL_PX = 76;
export const CHAT_TAB_LEARN_TEXT_PX = 72;
export const CHAT_TAB_LEARN_CHROME_PX = 48;
export const CHAT_TAB_LEARN_SLOT_PX =
  CHAT_TAB_LEARN_CHROME_PX + CHAT_TAB_LEARN_TEXT_PX + 8;
export const CHAT_TAB_WRITING_SLOT_PX = 92;
export const CHAT_TAB_WRITING_MANY_SLOT_PX = 72;
export const CHAT_TAB_ACCOUNT_FULL_PX = 72;
export const CHAT_TAB_ACCOUNT_COMFORT_PX = 160;
export const CHAT_TAB_ACCOUNT_TIGHT_PX = 40;
export const CHAT_TAB_UTILITIES_PX = 80;
export const CHAT_TAB_MANY_WRITING = 4;
export const CHAT_TAB_WRITING_MAX_PX = 176;
export const CHAT_TAB_WRITING_MANY_MAX_PX = 144;

export type ChatTabStripPlan = {
  pinLearnTab: boolean;
  hideLeadingLabel: boolean;
  accountMinPx: number;
  accountDensity: "full" | "provider";
  writingScrollerMinPx: number;
  writingTabMinPx: number;
  writingTabMaxPx: number;
  learnSlotPx: number;
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

function accountMinPxFromChrome(chrome: StripChrome): number {
  if (chrome.accountMin.includes("10rem")) return CHAT_TAB_ACCOUNT_COMFORT_PX;
  if (chrome.accountMin.includes("4.5rem")) return CHAT_TAB_ACCOUNT_FULL_PX;
  return 0;
}

export function chatTabStripReservedPx(
  plan: ChatTabStripPlan,
  utilities: boolean,
): number {
  const leading = plan.hideLeadingLabel
    ? CHAT_TAB_LEADING_ICON_PX
    : CHAT_TAB_LEADING_LABEL_PX;
  return (
    leading +
    plan.learnSlotPx +
    plan.writingScrollerMinPx +
    plan.accountMinPx +
    (utilities ? CHAT_TAB_UTILITIES_PX : 0)
  );
}

export function chatTabStripPlan(input: {
  barWidthPx: number;
  writingTabCount: number;
  hasLearnTab: boolean;
  chrome: StripChrome;
}): ChatTabStripPlan {
  const writingTabMaxPx =
    input.writingTabCount >= CHAT_TAB_MANY_WRITING
      ? CHAT_TAB_WRITING_MANY_MAX_PX
      : CHAT_TAB_WRITING_MAX_PX;
  const roomy = !Number.isFinite(input.barWidthPx) || input.barWidthPx <= 0;

  if (!input.hasLearnTab) {
    return {
      pinLearnTab: false,
      hideLeadingLabel: roomy ? false : input.chrome.hideLabel,
      accountMinPx: roomy
        ? CHAT_TAB_ACCOUNT_FULL_PX
        : accountMinPxFromChrome(input.chrome),
      accountDensity: roomy ? "full" : input.chrome.density,
      writingScrollerMinPx: CHAT_TAB_ACCOUNT_FULL_PX,
      writingTabMinPx: 0,
      writingTabMaxPx,
      learnSlotPx: 0,
    };
  }

  const many = input.writingTabCount >= CHAT_TAB_MANY_WRITING;
  let hideLeadingLabel = roomy ? false : input.chrome.hideLabel;
  let accountMinPx = roomy
    ? CHAT_TAB_ACCOUNT_FULL_PX
    : accountMinPxFromChrome(input.chrome);
  let accountDensity: "full" | "provider" = roomy
    ? "full"
    : input.chrome.density;
  let writingTabMinPx = many
    ? CHAT_TAB_WRITING_MANY_SLOT_PX
    : input.writingTabCount > 0
      ? CHAT_TAB_WRITING_SLOT_PX
      : 0;

  const reserved = () =>
    chatTabStripReservedPx(
      {
        pinLearnTab: true,
        hideLeadingLabel,
        accountMinPx,
        accountDensity,
        writingScrollerMinPx: writingTabMinPx,
        writingTabMinPx,
        writingTabMaxPx,
        learnSlotPx: CHAT_TAB_LEARN_SLOT_PX,
      },
      input.chrome.utilities,
    );
  const cramped = () => !roomy && reserved() > input.barWidthPx;

  if (cramped() && accountMinPx > CHAT_TAB_ACCOUNT_FULL_PX) {
    accountMinPx = CHAT_TAB_ACCOUNT_FULL_PX;
    accountDensity = "full";
  }
  if (cramped()) hideLeadingLabel = true;
  if (cramped() && accountMinPx > CHAT_TAB_ACCOUNT_TIGHT_PX) {
    accountMinPx = CHAT_TAB_ACCOUNT_TIGHT_PX;
    accountDensity = "provider";
  }
  if (cramped() && writingTabMinPx > CHAT_TAB_WRITING_MANY_SLOT_PX) {
    writingTabMinPx = CHAT_TAB_WRITING_MANY_SLOT_PX;
  }
  if (cramped()) writingTabMinPx = 0;

  return {
    pinLearnTab: true,
    hideLeadingLabel,
    accountMinPx,
    accountDensity,
    writingScrollerMinPx: writingTabMinPx,
    writingTabMinPx,
    writingTabMaxPx,
    learnSlotPx: CHAT_TAB_LEARN_SLOT_PX,
  };
}
