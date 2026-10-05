export type WindowChromeVariable = {
  name: string;
  value: string;
};

/**
 * Windows caption buttons sit in the overlay titlebar, so the chat row is
 * padded down by `--titlebar-height` instead of reserving `--window-controls-inset`
 * beside the account label. The composer gutter is only raised on Linux, where
 * a dock can cover the bottom of the window.
 */
export function windowChromeVariables(
  userAgent: string,
): WindowChromeVariable[] {
  if (userAgent.includes("Windows")) {
    return [
      { name: "--titlebar-height", value: "32px" },
      { name: "--traffic-light-width", value: "0px" },
      { name: "--window-controls-inset", value: "8.75rem" },
      { name: "--chat-bottom-gutter", value: "0px" },
    ];
  }
  if (!userAgent.includes("Macintosh")) {
    return [
      { name: "--titlebar-height", value: "0px" },
      { name: "--traffic-light-width", value: "0px" },
      { name: "--window-controls-inset", value: "0px" },
      { name: "--chat-bottom-gutter", value: "3rem" },
    ];
  }
  return [{ name: "--chat-bottom-gutter", value: "0px" }];
}

export function applyWindowChrome(
  userAgent: string,
  setProperty: (name: string, value: string) => void,
): void {
  for (const variable of windowChromeVariables(userAgent)) {
    setProperty(variable.name, variable.value);
  }
}
