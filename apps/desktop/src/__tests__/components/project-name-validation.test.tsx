import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectWizard } from "@/components/project-wizard";
import { useProjectStore } from "@/stores/project-store";

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

describe("project name validation timing", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useProjectStore.setState({ lastProjectFolder: "/tmp/LocalPrism" });
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
    useProjectStore.setState({ lastProjectFolder: null });
  });

  it("does not show a project name error when an accordion opens", async () => {
    await act(async () => {
      root.render(<ProjectWizard mode="scratch" onBack={() => undefined} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    const name = container.querySelector("input");
    expect(name).toBeInstanceOf(HTMLInputElement);
    expect(document.activeElement).toBe(name);

    const references = findButton(container, "Reference files");
    await act(async () => {
      references.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
      references.click();
    });

    expect(container.textContent).toContain("Drag & drop");
    expect(container.textContent).not.toContain("Enter a project name");

    await act(async () => {
      await Promise.resolve();
    });
    const purpose = container.querySelector("textarea");
    await act(async () => {
      purpose?.focus();
    });
    expect(container.textContent).toContain("Enter a project name");
  });

  it("keeps the name error hidden when the location accordion opens", async () => {
    await act(async () => {
      root.render(<ProjectWizard mode="scratch" onBack={() => undefined} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    const location = findButton(container, "Project location");
    await act(async () => {
      location.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
      location.click();
    });

    expect(container.textContent).toContain("/tmp/LocalPrism/...");
    expect(container.textContent).toContain("Change");
    expect(container.textContent).not.toContain("Enter a project name");
  });
});
