import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  firstPendingForTab,
  pendingApprovalTabKey,
  useApprovalStore,
} from "@/stores/approval-store";
import type { RuntimeRequest } from "@/runtime/types";

function request(
  id: number | string,
  tabId: string,
  extras: Partial<RuntimeRequest> = {},
): RuntimeRequest {
  return {
    requestId: id,
    method: "item/commandExecution/requestApproval",
    runtime: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    tabId,
    agentRunId: null,
    title: "Run command",
    command: "pwd",
    cwd: null,
    diff: null,
    permissions: null,
    questions: [],
    details: null,
    ...extras,
  };
}

describe("approval-store", () => {
  beforeEach(() => {
    useApprovalStore.getState().reset();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("queues per tab and responds exactly once", async () => {
    const store = useApprovalStore.getState();
    store.enqueue(request(1, "tab-a"));
    store.enqueue(request("b", "tab-b"));
    expect(Object.keys(useApprovalStore.getState().pending)).toHaveLength(2);

    await store.respond(1, {
      decision: "allow",
      persistence: "turn",
      answers: {},
    });
    await store.respond(1, {
      decision: "deny",
      persistence: null,
      answers: {},
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("runtime_request_respond", {
      request: {
        requestId: 1,
        decision: "allow",
        persistence: "turn",
        answers: {},
      },
    });
    expect(Object.keys(useApprovalStore.getState().pending)).toEqual(["s:b"]);
  });

  it("cancels by turn and rejects unknown methods", async () => {
    const store = useApprovalStore.getState();
    store.enqueue(request(2, "tab-a"));
    await store.cancelForTurn("codex", "thread-1", "turn-1");
    expect(invoke).toHaveBeenCalledWith("runtime_request_respond", {
      request: {
        requestId: 2,
        decision: "cancel",
        persistence: null,
        answers: {},
      },
    });

    await store.rejectUnknown(request(3, "tab-a", { method: "future/method" }));
    expect(invoke).toHaveBeenLastCalledWith("runtime_request_respond", {
      request: {
        requestId: 3,
        decision: "unsupported",
        persistence: null,
        answers: {},
      },
    });
  });

  it("dismisses a request without calling the backend", () => {
    const store = useApprovalStore.getState();
    store.enqueue(request("req_1", "tab-a"));
    store.enqueue(request("req_2", "tab-b"));
    store.dismiss("req_1");
    expect(Object.keys(useApprovalStore.getState().pending)).toEqual([
      "s:req_2",
    ]);
    store.dismissForTab("tab-b");
    expect(useApprovalStore.getState().pending).toEqual({});
    expect(invoke).not.toHaveBeenCalled();
  });

  it("selects the first pending request for a tab", () => {
    const store = useApprovalStore.getState();
    store.enqueue(request("old", "tab-old", { title: "Old Bash" }));
    store.enqueue(request("new", "tab-new", { title: "New Read" }));
    const pending = useApprovalStore.getState().pending;
    expect(firstPendingForTab(pending, "tab-new")?.title).toBe("New Read");
    expect(firstPendingForTab(pending, "tab-missing")).toBeNull();
    expect(firstPendingForTab(pending, "")).toBeNull();
    expect(pendingApprovalTabKey(pending)).toBe("tab-new\0tab-old");
  });

  it("cancels every pending request for a tab", async () => {
    const store = useApprovalStore.getState();
    store.enqueue(request("keep", "tab-keep"));
    store.enqueue(request("gone", "tab-gone"));
    await store.cancelForTab("tab-gone");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("runtime_request_respond", {
      request: {
        requestId: "gone",
        decision: "cancel",
        persistence: null,
        answers: {},
      },
    });
    expect(Object.keys(useApprovalStore.getState().pending)).toEqual([
      "s:keep",
    ]);
  });

  it("drops every matching prompt before the backend answers", async () => {
    const store = useApprovalStore.getState();
    store.enqueue(request("one", "tab-a"));
    store.enqueue(request("two", "tab-a"));
    const releases: Array<() => void> = [];
    vi.mocked(invoke).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(undefined));
        }),
    );

    const pending = store.cancelForTab("tab-a");
    expect(useApprovalStore.getState().pending).toEqual({});
    for (const release of releases) release();
    await pending;
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not restore a cancelled tab prompt after an IPC failure", async () => {
    const store = useApprovalStore.getState();
    store.enqueue(request("gone", "tab-gone"));
    vi.mocked(invoke).mockRejectedValueOnce(new Error("backend closed"));
    await store.cancelForTab("tab-gone");
    expect(useApprovalStore.getState().pending).toEqual({});
  });

  it("rejects unroutable prompts without queuing them", async () => {
    useApprovalStore.getState().enqueue(request("orphan", ""));
    expect(useApprovalStore.getState().pending).toEqual({});
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("runtime_request_respond", {
        request: {
          requestId: "orphan",
          decision: "unsupported",
          persistence: null,
          answers: {},
        },
      });
    });
  });
});
