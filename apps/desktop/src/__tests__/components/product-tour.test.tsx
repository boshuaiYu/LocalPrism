import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProductTour,
  useProductTourDialogGuard,
} from "@/components/product-tour";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  PRODUCT_TOUR_STEPS,
  isProductTourReplayRequested,
  requestProductTourReplay,
  resetProductTourReplayForTests,
} from "@/lib/product-tour";
import {
  isWelcomeCompleted,
  markWelcomeCompleted,
  resetWelcomeCompletedForTests,
} from "@/lib/welcome";
import {
  resetChatLayoutStoreForTests,
  useChatLayoutStore,
} from "@/stores/chat-layout-store";
import { useDocumentStore } from "@/stores/document-store";
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
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    useSettingsStore.setState({ productTour: "pending", uiLanguage: "en" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    resetChatLayoutStoreForTests();
    resetProductTourReplayForTests();
    resetWelcomeCompletedForTests();
    useSettingsStore.setState({
      productTour: "pending",
      compilerBackend: "tectonic",
      vimMode: false,
    });
    vi.unstubAllGlobals();
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
    const cues: string[] = [];
    const onCue = (event: Event) => {
      cues.push(String((event as CustomEvent).detail));
    };
    window.addEventListener("localprism-product-tour", onCue);
    await renderTour();
    expect(tour()).not.toBeNull();
    expect(document.body.textContent).toContain("Project files");
    expect(document.body.textContent).toContain("1 / 12");

    const skip = document.body.querySelector(
      '[data-testid="product-tour-skip"]',
    );
    expect(skip).toBeInstanceOf(HTMLButtonElement);
    cues.length = 0;
    await act(async () => {
      (skip as HTMLButtonElement).click();
    });

    expect(useSettingsStore.getState().productTour).toBe("skipped");
    expect(cues).toContain("restore-workspace");
    expect(tour()).toBeNull();
    window.removeEventListener("localprism-product-tour", onCue);

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
    const cues: string[] = [];
    const onCue = (event: Event) => {
      cues.push(String((event as CustomEvent).detail));
    };
    window.addEventListener("localprism-product-tour", onCue);
    useSettingsStore.setState({ productTour: "completed" });
    await renderTour();
    expect(tour()).toBeNull();
    expect(cues).not.toContain("close-overlays");
    window.removeEventListener("localprism-product-tour", onCue);
  });

  it("blocks pointer events except the click-through hotspot", async () => {
    const previousWidth = window.innerWidth;
    const previousHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 600,
    });
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function rectForTour() {
      const anchor = this.getAttribute("data-tour");
      if (anchor === "tour-files") return domRect(20, 40, 100, 30);
      if (anchor === "tour-skills") return domRect(40, 100, 80, 28);
      return original.call(this);
    };
    try {
      await renderTour();
      const blocked = shields();
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.className).toContain("inset-0");
      for (const shield of blocked) {
        expect(shield.className).toContain("pointer-events-auto");
      }
      expect(covers(blocked, 80, 114)).toBe(true);

      for (let step = 0; step < 5; step += 1) {
        const next = document.body.querySelector(
          '[data-testid="product-tour-next"]',
        );
        await act(async () => {
          (next as HTMLButtonElement).click();
        });
      }
      const holed = shields();
      expect(holed.some((node) => node.className.includes("inset-0"))).toBe(
        false,
      );
      expect(covers(holed, 10, 10)).toBe(true);
      expect(covers(holed, 80, 114)).toBe(false);
      const right = holed.find(
        (node) => Number.parseFloat(node.style.left) === 120,
      );
      expect(right?.style.width).toBe("680px");
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1000,
      });
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });
      const grown = shields();
      const grownRight = grown.find(
        (node) => Number.parseFloat(node.style.left) === 120,
      );
      expect(grownRight?.style.width).toBe("880px");
      expect(covers(grown, 80, 114)).toBe(false);
      expect(tour()?.className).toContain("pointer-events-none");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: previousWidth,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: previousHeight,
      });
    }
  });

  it("retries opening skills until the panel anchor mounts", async () => {
    const cues: string[] = [];
    const onCue = (event: Event) => {
      cues.push(String((event as CustomEvent).detail));
    };
    window.addEventListener("localprism-product-tour", onCue);
    await act(async () => {
      root.render(
        <>
          <div data-tour="tour-files">Files</div>
          <button type="button" data-tour="tour-skills">
            Skills
          </button>
          <ProductTour />
        </>,
      );
    });
    for (let step = 0; step < 6; step += 1) {
      const next = document.body.querySelector(
        '[data-testid="product-tour-next"]',
      );
      await act(async () => {
        (next as HTMLButtonElement).click();
      });
    }
    const first = cues.filter((cue) => cue === "open-skills").length;
    expect(first).toBeGreaterThan(0);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(cues.filter((cue) => cue === "open-skills").length).toBeGreaterThan(
      first,
    );
    window.removeEventListener("localprism-product-tour", onCue);
  });

  it("closes tour panels when the tour is finished", async () => {
    const cues: string[] = [];
    const onCue = (event: Event) => {
      cues.push(String((event as CustomEvent).detail));
    };
    const realSetTimeout = window.setTimeout.bind(window);
    const timeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      delay?: number,
    ) => {
      if (delay === 50 || delay === 150 || delay === 400 || delay === 800) {
        return 0;
      }
      return realSetTimeout(handler, delay);
    }) as unknown as typeof window.setTimeout);
    window.addEventListener("localprism-product-tour", onCue);
    try {
      await renderTour();
      for (let step = 0; step < 12; step += 1) {
        const next = document.body.querySelector(
          '[data-testid="product-tour-next"]',
        );
        await act(async () => {
          (next as HTMLButtonElement).click();
        });
      }
      expect(useSettingsStore.getState().productTour).toBe("completed");
      expect(cues).toContain("close-overlays");
      expect(cues).toContain("restore-workspace");
      expect(tour()).toBeNull();
    } finally {
      timeoutSpy.mockRestore();
      window.removeEventListener("localprism-product-tour", onCue);
    }
  });

  it("replays a finished tour and leaves first-run status untouched", async () => {
    resetWelcomeCompletedForTests();
    markWelcomeCompleted();
    useSettingsStore.setState({
      productTour: "completed",
      compilerBackend: "texlive",
      vimMode: true,
    });
    await renderTour();
    expect(tour()).toBeNull();

    await act(async () => {
      requestProductTourReplay();
    });
    expect(tour()).not.toBeNull();
    expect(document.body.textContent).toContain("Project files");
    expect(document.body.textContent).toContain("1 / 12");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(tour()).toBeNull();
    expect(useSettingsStore.getState().productTour).toBe("completed");
    expect(useSettingsStore.getState().compilerBackend).toBe("texlive");
    expect(useSettingsStore.getState().vimMode).toBe(true);
    expect(isWelcomeCompleted()).toBe(true);

    await renderTour();
    expect(tour()).toBeNull();
  });

  it("finishes a replay without reopening a skipped first-run tour", async () => {
    useSettingsStore.setState({ productTour: "skipped" });
    await renderTour();
    await act(async () => {
      requestProductTourReplay();
    });
    for (let step = 0; step < PRODUCT_TOUR_STEPS.length; step += 1) {
      const next = document.body.querySelector(
        '[data-testid="product-tour-next"]',
      );
      await act(async () => {
        (next as HTMLButtonElement).click();
      });
    }
    expect(tour()).toBeNull();
    expect(useSettingsStore.getState().productTour).toBe("skipped");
    await renderTour();
    expect(tour()).toBeNull();
  });

  it("starts a queued replay when the workspace tour mounts", async () => {
    useSettingsStore.setState({ productTour: "skipped" });
    requestProductTourReplay();
    await renderTour();
    expect(tour()).not.toBeNull();
    expect(useSettingsStore.getState().productTour).toBe("skipped");

    const skip = document.body.querySelector(
      '[data-testid="product-tour-skip"]',
    );
    await act(async () => {
      (skip as HTMLButtonElement).click();
    });
    expect(tour()).toBeNull();
    expect(useSettingsStore.getState().productTour).toBe("skipped");
  });

  it("still records a skip when the first-run tour has not finished", async () => {
    useSettingsStore.setState({ productTour: "pending" });
    await renderTour();
    await act(async () => {
      requestProductTourReplay();
    });
    const skip = document.body.querySelector(
      '[data-testid="product-tour-skip"]',
    );
    await act(async () => {
      (skip as HTMLButtonElement).click();
    });
    expect(useSettingsStore.getState().productTour).toBe("skipped");
    expect(tour()).toBeNull();
  });

  it("restores chat and drops a replay when the tour unmounts", async () => {
    resetWelcomeCompletedForTests();
    markWelcomeCompleted();
    useSettingsStore.setState({
      productTour: "completed",
      compilerBackend: "texlive",
      vimMode: true,
    });
    useChatLayoutStore.setState({ visible: false, suppressAutoOpen: true });
    const cues: string[] = [];
    const onCue = (event: Event) => {
      cues.push(String((event as CustomEvent).detail));
    };
    window.addEventListener("localprism-product-tour", onCue);
    try {
      await renderTour();
      await act(async () => {
        requestProductTourReplay();
      });
      expect(tour()).not.toBeNull();
      useChatLayoutStore.getState().setVisible(true);

      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);

      expect(cues).toContain("restore-workspace");
      expect(isProductTourReplayRequested()).toBe(false);
      expect(useChatLayoutStore.getState().visible).toBe(false);
      expect(useSettingsStore.getState().productTour).toBe("completed");
      expect(useSettingsStore.getState().compilerBackend).toBe("texlive");
      expect(useSettingsStore.getState().vimMode).toBe(true);
      expect(isWelcomeCompleted()).toBe(true);

      await renderTour();
      expect(tour()).toBeNull();
    } finally {
      window.removeEventListener("localprism-product-tour", onCue);
    }
  });

  it("leaves a pending first-run tour pending when it unmounts", async () => {
    resetWelcomeCompletedForTests();
    useSettingsStore.setState({
      productTour: "pending",
      compilerBackend: "texlive",
      vimMode: true,
    });
    await renderTour();
    await act(async () => {
      requestProductTourReplay();
    });
    expect(tour()).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    expect(useSettingsStore.getState().productTour).toBe("pending");
    expect(isProductTourReplayRequested()).toBe(false);
    expect(useSettingsStore.getState().compilerBackend).toBe("texlive");
    expect(useSettingsStore.getState().vimMode).toBe(true);
    expect(isWelcomeCompleted()).toBe(false);

    await renderTour();
    expect(tour()).not.toBeNull();
  });

  it("ends a replay when the project closes and keeps stored status", async () => {
    const previous = useDocumentStore.getState();
    resetWelcomeCompletedForTests();
    markWelcomeCompleted();
    useSettingsStore.setState({
      productTour: "completed",
      compilerBackend: "texlive",
      vimMode: true,
    });
    useChatLayoutStore.setState({ visible: false, suppressAutoOpen: true });
    useDocumentStore.setState({
      projectRoot: "/paper",
      initialized: true,
      isProjectMutating: false,
    });
    try {
      await renderTour();
      await act(async () => {
        requestProductTourReplay();
      });
      expect(tour()).not.toBeNull();
      useChatLayoutStore.getState().setVisible(true);

      await act(async () => {
        const closed = useDocumentStore.getState().closeProject();
        if (closed instanceof Promise) await closed;
      });

      expect(isProductTourReplayRequested()).toBe(false);
      expect(useChatLayoutStore.getState().visible).toBe(false);
      expect(useSettingsStore.getState().productTour).toBe("completed");
      expect(useSettingsStore.getState().compilerBackend).toBe("texlive");
      expect(useSettingsStore.getState().vimMode).toBe(true);
      expect(isWelcomeCompleted()).toBe(true);
      expect(tour()).toBeNull();

      await renderTour();
      expect(tour()).toBeNull();
    } finally {
      useDocumentStore.setState({
        projectRoot: previous.projectRoot,
        initialized: previous.initialized,
        isProjectMutating: false,
        projectGeneration: previous.projectGeneration,
      });
    }
  });

  it("keeps a pending tour pending when the project closes", async () => {
    const previous = useDocumentStore.getState();
    resetWelcomeCompletedForTests();
    useSettingsStore.setState({
      productTour: "pending",
      compilerBackend: "texlive",
      vimMode: true,
    });
    useChatLayoutStore.setState({ visible: false, suppressAutoOpen: true });
    useDocumentStore.setState({
      projectRoot: "/paper",
      initialized: true,
      isProjectMutating: false,
    });
    try {
      await renderTour();
      expect(tour()).not.toBeNull();
      useChatLayoutStore.getState().setVisible(true);

      await act(async () => {
        const closed = useDocumentStore.getState().closeProject();
        if (closed instanceof Promise) await closed;
      });

      expect(useSettingsStore.getState().productTour).toBe("pending");
      expect(isProductTourReplayRequested()).toBe(false);
      expect(useChatLayoutStore.getState().visible).toBe(false);
      expect(useSettingsStore.getState().compilerBackend).toBe("texlive");
      expect(useSettingsStore.getState().vimMode).toBe(true);
      expect(isWelcomeCompleted()).toBe(false);
    } finally {
      useDocumentStore.setState({
        projectRoot: previous.projectRoot,
        initialized: previous.initialized,
        isProjectMutating: false,
        projectGeneration: previous.projectGeneration,
      });
    }
  });

  it("keeps a manual replay through StrictMode setup replay", async () => {
    useSettingsStore.setState({ productTour: "completed" });
    await act(async () => {
      root.render(
        <StrictMode>
          <div data-tour="tour-files">Files</div>
          <ProductTour />
        </StrictMode>,
      );
    });
    expect(tour()).toBeNull();
    await act(async () => {
      requestProductTourReplay();
    });
    expect(isProductTourReplayRequested()).toBe(true);
    expect(tour()).not.toBeNull();
    expect(useSettingsStore.getState().productTour).toBe("completed");
  });
});

function domRect(left: number, top: number, width: number, height: number) {
  return {
    x: left,
    y: top,
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

function shields(): HTMLElement[] {
  return [
    ...document.body.querySelectorAll('[data-testid="product-tour-shield"]'),
  ].filter((node): node is HTMLElement => node instanceof HTMLElement);
}

function covers(nodes: HTMLElement[], x: number, y: number): boolean {
  return nodes.some((node) => {
    if (node.className.includes("inset-0")) return true;
    const top = Number.parseFloat(node.style.top);
    const left = Number.parseFloat(node.style.left);
    const width = Number.parseFloat(node.style.width);
    const height = Number.parseFloat(node.style.height);
    return x >= left && x < left + width && y >= top && y < top + height;
  });
}
