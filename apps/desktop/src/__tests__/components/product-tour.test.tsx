import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProductTour,
  useProductTourDialogGuard,
} from "@/components/product-tour";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useSettingsStore } from "@/stores/settings-store";

function GuardedDialog({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const tourDialog = useProductTourDialogGuard();
  return (
    <Dialog open onOpenChange={onOpenChange} modal={tourDialog.modal}>
      <DialogContent
        aria-describedby={undefined}
        onInteractOutside={tourDialog.onInteractOutside}
      >
        <DialogTitle>Follow along</DialogTitle>
        <p>Inside dialog</p>
      </DialogContent>
    </Dialog>
  );
}

describe("ProductTour", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useSettingsStore.setState({ productTour: "pending", uiLanguage: "en" });
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
    useSettingsStore.setState({ productTour: "pending" });
  });

  function renderTour() {
    return act(async () => {
      root.render(
        <>
          <div data-tour="tour-files">Files</div>
          <button type="button" data-tour="tour-skills">
            Skills
          </button>
          <nav data-tour="tour-skill-categories">Packs</nav>
          <ProductTour />
        </>,
      );
    });
  }

  function tour() {
    return document.body.querySelector('[data-testid="product-tour"]');
  }

  it("shows once, then stays hidden after skip", async () => {
    await renderTour();
    expect(tour()).not.toBeNull();
    expect(document.body.textContent).toContain("Project files");
    expect(document.body.textContent).toContain("1 / 12");

    const skip = document.body.querySelector(
      '[data-testid="product-tour-skip"]',
    );
    expect(skip).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      (skip as HTMLButtonElement).click();
    });

    expect(useSettingsStore.getState().productTour).toBe("skipped");
    expect(tour()).toBeNull();

    await renderTour();
    expect(tour()).toBeNull();
  });

  it("advances when the skills hotspot is clicked", async () => {
    const cues: string[] = [];
    const onCue = (event: Event) => {
      cues.push(String((event as CustomEvent).detail));
    };
    window.addEventListener("localprism-product-tour", onCue);
    await renderTour();
    for (let step = 0; step < 5; step += 1) {
      const next = document.body.querySelector(
        '[data-testid="product-tour-next"]',
      );
      await act(async () => {
        (next as HTMLButtonElement).click();
      });
    }
    expect(document.body.textContent).toContain("callable writing tools");

    const skills = container.querySelector('[data-tour="tour-skills"]');
    await act(async () => {
      (skills as HTMLButtonElement).click();
    });
    expect(document.body.textContent).toContain("PaperSpine");
    expect(cues).toContain("open-skills");
    window.removeEventListener("localprism-product-tour", onCue);
  });

  it("keeps a followed dialog open when Next is clicked", async () => {
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(
        <>
          <div data-tour="tour-files">Files</div>
          <GuardedDialog onOpenChange={onOpenChange} />
          <ProductTour />
        </>,
      );
    });
    const next = document.body.querySelector(
      '[data-testid="product-tour-next"]',
    );
    await act(async () => {
      (next as HTMLButtonElement).click();
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Inside dialog");
    expect(document.body.textContent).toContain("Zotero");
  });

  it("does not auto-show after the tour is completed", async () => {
    useSettingsStore.setState({ productTour: "completed" });
    await renderTour();
    expect(tour()).toBeNull();
  });
});
