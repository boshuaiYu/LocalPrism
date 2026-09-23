import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TemplateGallery } from "@/components/template-gallery/template-gallery";
import { useProjectStore } from "@/stores/project-store";
import { useTemplateStore } from "@/stores/template-store";

function pressEscape() {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

function currentStepLabel(): string {
  return document.querySelector("[aria-current='step']")?.textContent ?? "";
}

describe("onboarding Escape", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    useProjectStore.setState({ lastProjectFolder: "/tmp/LocalPrism" });
    useTemplateStore.getState().reset();
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
    useTemplateStore.getState().reset();
    useProjectStore.setState({ lastProjectFolder: null });
    vi.unstubAllGlobals();
  });

  it("walks back one step from details, preview, then the gallery", async () => {
    const onExit = vi.fn();
    await act(async () => {
      root.render(<TemplateGallery onExit={onExit} />);
    });
    await act(async () => {
      useTemplateStore.getState().openPreview("paper-standard");
    });

    const useTemplate = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Use Template"),
    );
    if (!(useTemplate instanceof HTMLButtonElement)) {
      throw new Error("Use Template button not found");
    }
    await act(async () => {
      useTemplate.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });

    expect(currentStepLabel()).toContain("Details");
    expect(document.activeElement).toBeInstanceOf(HTMLInputElement);

    await act(async () => {
      pressEscape();
    });
    expect(onExit).not.toHaveBeenCalled();
    expect(currentStepLabel()).toContain("Details");
    expect(document.activeElement?.getAttribute("data-slot")).toBe(
      "dialog-content",
    );
    expect(document.body.textContent).not.toContain("Enter a project name");

    await act(async () => {
      pressEscape();
    });
    expect(onExit).not.toHaveBeenCalled();
    expect(currentStepLabel()).toContain("Template");
    expect(useTemplateStore.getState().previewTemplateId).toBe(
      "paper-standard",
    );

    await act(async () => {
      pressEscape();
    });
    expect(onExit).not.toHaveBeenCalled();
    expect(useTemplateStore.getState().previewTemplateId).toBeNull();

    await act(async () => {
      pressEscape();
    });
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
