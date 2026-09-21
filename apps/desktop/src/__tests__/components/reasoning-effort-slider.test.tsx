import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReasoningEffortSlider } from "@/components/claude-chat/reasoning-effort-slider";

describe("ReasoningEffortSlider", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it("renders a discrete slider from the parsed model efforts", async () => {
    root.render(
      <ReasoningEffortSlider
        options={["low", "xhigh"]}
        value="low"
        onChange={() => undefined}
      />,
    );

    const slider = await vi.waitFor(() => {
      const node = container.querySelector(
        '[data-testid="reasoning-effort-slider"]',
      );
      if (!(node instanceof HTMLInputElement)) {
        throw new Error("slider missing");
      }
      return node;
    });
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("1");
    expect(slider.value).toBe("0");
    expect(slider.getAttribute("aria-valuetext")).toBe("Low");
    expect(container.textContent).toContain("Low");
  });

  it("emits the parsed effort at the chosen step", async () => {
    const onChange = vi.fn();
    root.render(
      <ReasoningEffortSlider
        options={["low", "medium", "high", "xhigh"]}
        value="medium"
        onChange={onChange}
      />,
    );

    const slider = await vi.waitFor(() => {
      const node = container.querySelector(
        '[data-testid="reasoning-effort-slider"]',
      );
      if (!(node instanceof HTMLInputElement)) {
        throw new Error("slider missing");
      }
      return node;
    });
    slider.value = "3";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith("xhigh");
  });

  it("hides when the parsed model has no selectable efforts", async () => {
    root.render(
      <ReasoningEffortSlider
        options={[]}
        value={null}
        onChange={() => undefined}
      />,
    );

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="reasoning-effort-slider"]'),
      ).toBeNull();
    });
  });

  it("omits the reset control and the unused fast toggle", async () => {
    root.render(
      <ReasoningEffortSlider
        options={["low", "medium", "high"]}
        value="medium"
        modelName="GPT-5.6 Luna"
        onChange={() => undefined}
      />,
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("GPT-5.6 Luna");
    });
    expect(
      container.querySelector('[aria-label="Reset reasoning effort"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="reasoning-effort-fast-toggle"]'),
    ).toBeNull();
    expect(container.textContent).toContain("Med");
  });

  it("toggles a distinct fast model when the catalog has a sibling", async () => {
    const onFastChange = vi.fn();
    root.render(
      <ReasoningEffortSlider
        options={["low", "medium"]}
        value="medium"
        fastToggle={{ enabled: false, onChange: onFastChange }}
        onChange={() => undefined}
      />,
    );

    const toggle = await vi.waitFor(() => {
      const node = container.querySelector(
        '[data-testid="reasoning-effort-fast-toggle"]',
      );
      if (!(node instanceof HTMLButtonElement)) {
        throw new Error("fast toggle missing");
      }
      return node;
    });
    toggle.click();
    expect(onFastChange).toHaveBeenCalledWith(true);
  });
});
