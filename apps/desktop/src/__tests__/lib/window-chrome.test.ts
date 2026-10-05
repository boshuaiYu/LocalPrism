import { describe, expect, it } from "vitest";
import { windowChromeVariables } from "@/lib/window-chrome";

function value(userAgent: string, name: string): string | undefined {
  return windowChromeVariables(userAgent).find(
    (variable) => variable.name === name,
  )?.value;
}

describe("windowChromeVariables", () => {
  it("keeps the Windows caption inset off the composer bottom", () => {
    const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
    expect(value(windows, "--titlebar-height")).toBe("32px");
    expect(value(windows, "--window-controls-inset")).toBe("8.75rem");
    expect(value(windows, "--chat-bottom-gutter")).toBe("0px");
  });

  it("raises the composer gutter only for a Linux dock", () => {
    const linux = "Mozilla/5.0 (X11; Linux x86_64)";
    expect(value(linux, "--titlebar-height")).toBe("0px");
    expect(value(linux, "--chat-bottom-gutter")).toBe("3rem");
  });

  it("does not add a dock gutter on macOS", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
    expect(value(mac, "--chat-bottom-gutter")).toBe("0px");
    expect(value(mac, "--titlebar-height")).toBeUndefined();
  });
});
