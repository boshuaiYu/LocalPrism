import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useApprovalStore } from "@/stores/approval-store";
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
});
