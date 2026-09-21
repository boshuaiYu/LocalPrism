import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionModePicker } from "@/components/runtime/permission-mode-picker";
import { useSettingsStore } from "@/stores/settings-store";

describe("PermissionModePicker", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useSettingsStore.setState({ permissionMode: "acceptEdits" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("changes the approval policy from a standalone pill", async () => {
    await act(async () => {
      root.render(<PermissionModePicker />);
    });

    const trigger = container.querySelector(
      '[aria-label="Approval policy Allow edits"]',
    );
    expect(trigger).toBeTruthy();
    await act(async () => {
      (trigger as HTMLButtonElement).click();
    });

    const fullAccess = Array.from(
      document.body.querySelectorAll("button"),
    ).find(
      (button) =>
        button.getAttribute("aria-label") === "Approval policy Full access",
    );
    expect(fullAccess).toBeTruthy();
    await act(async () => {
      fullAccess!.click();
    });
    expect(useSettingsStore.getState().permissionMode).toBe(
      "bypassPermissions",
    );
  });
});
