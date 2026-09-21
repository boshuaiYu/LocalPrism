import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveCompile } from "@/hooks/use-live-compile";

function Probe({
  enabled,
  contentGeneration,
  projectGeneration,
  activeRootId,
  compile,
  debounceMs,
}: {
  enabled: boolean;
  contentGeneration: number;
  projectGeneration: number;
  activeRootId?: string | null;
  compile: () => void;
  debounceMs: number;
}) {
  useLiveCompile({
    enabled,
    contentGeneration,
    projectGeneration,
    activeRootId,
    compile,
    debounceMs,
  });
  return null;
}

describe("useLiveCompile", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("does not compile the generation present on the first project mount", async () => {
    const compile = vi.fn();
    await act(async () => {
      root.render(
        <Probe
          enabled
          contentGeneration={2}
          projectGeneration={1}
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(compile).not.toHaveBeenCalled();
  });

  it("debounces to a single compile after typing settles", async () => {
    const compile = vi.fn();
    await act(async () => {
      root.render(
        <Probe
          enabled
          contentGeneration={2}
          projectGeneration={1}
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      root.render(
        <Probe
          enabled
          contentGeneration={3}
          projectGeneration={1}
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      root.render(
        <Probe
          enabled
          contentGeneration={4}
          projectGeneration={1}
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(799);
    });
    expect(compile).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("does not compile the post-open contentGeneration settle", async () => {
    const compile = vi.fn();
    await act(async () => {
      root.render(
        <Probe
          enabled
          contentGeneration={0}
          projectGeneration={0}
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      root.render(
        <Probe
          enabled
          contentGeneration={0}
          projectGeneration={1}
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      root.render(
        <Probe
          enabled
          contentGeneration={1}
          projectGeneration={1}
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(compile).not.toHaveBeenCalled();
  });

  it("compiles after live preview is turned on with newer content", async () => {
    const compile = vi.fn();
    await act(async () => {
      root.render(
        <Probe
          enabled={false}
          contentGeneration={3}
          projectGeneration={1}
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      root.render(
        <Probe
          enabled
          contentGeneration={3}
          projectGeneration={1}
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("compiles when switching to another tex root after edits", async () => {
    const compile = vi.fn();
    await act(async () => {
      root.render(
        <Probe
          enabled
          contentGeneration={4}
          projectGeneration={1}
          activeRootId="a.tex"
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      root.render(
        <Probe
          enabled
          contentGeneration={5}
          projectGeneration={1}
          activeRootId="a.tex"
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      root.render(
        <Probe
          enabled
          contentGeneration={5}
          projectGeneration={1}
          activeRootId="b.tex"
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("does not compile after switching projects until content changes again", async () => {
    const compile = vi.fn();
    await act(async () => {
      root.render(
        <Probe
          enabled
          contentGeneration={5}
          projectGeneration={1}
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      root.render(
        <Probe
          enabled
          contentGeneration={1}
          projectGeneration={2}
          compile={compile}
          debounceMs={800}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(compile).not.toHaveBeenCalled();
  });
});
