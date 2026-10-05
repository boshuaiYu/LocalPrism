import { isLinuxDesktop } from "@/lib/linux-runtime-deps";

export type WindowChromeVariable = {
  name: string;
  value: string;
};

/**
 * Windows caption buttons sit in the overlay titlebar, so the chat row is
 * padded down by `--titlebar-height`. The composer gutter is only raised on
 * Linux, where a dock can cover the bottom of the window.
 */
export function windowChromeVariables(
  userAgent: string,
): WindowChromeVariable[] {
  if (userAgent.includes("Windows")) {
    return [
      { name: "--titlebar-height", value: "32px" },
      { name: "--chat-bottom-gutter", value: "0px" },
    ];
  }
  if (isLinuxDesktop(userAgent)) {
    return [
      { name: "--titlebar-height", value: "0px" },
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
