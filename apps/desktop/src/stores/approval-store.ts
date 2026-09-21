import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { requestKey } from "@/runtime/event-normalizer";
import type {
  RuntimeKind,
  RuntimeRequest,
  RuntimeRequestResponse,
} from "@/runtime/types";

interface ApprovalStoreState {
  pending: Record<string, RuntimeRequest>;
  inFlight: Record<string, true>;
  enqueue: (request: RuntimeRequest) => void;
  respond: (
    requestId: string | number,
    response: RuntimeRequestResponse,
  ) => Promise<void>;
  cancelForTurn: (
    runtime: RuntimeKind,
    threadId: string,
    turnId: string,
  ) => Promise<void>;
  cancelForTab: (tabId: string) => Promise<void>;
  rejectUnknown: (request: RuntimeRequest) => Promise<void>;
  dismiss: (requestId: string | number) => void;
  dismissForTab: (tabId: string) => void;
  reset: () => void;
}

export function firstPendingForTab(
  pending: Record<string, RuntimeRequest>,
  tabId: string,
): RuntimeRequest | null {
  if (!tabId) return null;
  return (
    Object.values(pending).find((request) => request.tabId === tabId) ?? null
  );
}

export function pendingApprovalTabKey(
  pending: Record<string, RuntimeRequest>,
): string {
  return [
    ...new Set(
      Object.values(pending)
        .map((request) => request.tabId)
        .filter((tabId) => tabId.length > 0),
    ),
  ]
    .sort()
    .join("\0");
}

async function sendResponse(
  requestId: string | number,
  response: RuntimeRequestResponse,
): Promise<void> {
  await invoke("runtime_request_respond", {
    request: {
      requestId,
      decision: response.decision,
      persistence: response.persistence,
      answers: response.answers,
    },
  });
}

export const useApprovalStore = create<ApprovalStoreState>((set, get) => ({
  pending: {},
  inFlight: {},

  enqueue: (request) => {
    if (!request.tabId.trim()) {
      void sendResponse(request.requestId, {
        decision: "unsupported",
        persistence: null,
        answers: {},
      }).catch(() => undefined);
      return;
    }
    const key = requestKey(request.requestId);
    set((state) => {
      if (state.pending[key] || state.inFlight[key]) {
        return state;
      }
      return {
        pending: { ...state.pending, [key]: request },
      };
    });
  },

  respond: async (requestId, response) => {
    const key = requestKey(requestId);
    const request = get().pending[key];
    if (!request || get().inFlight[key]) {
      return;
    }
    set((state) => {
      const pending = { ...state.pending };
      delete pending[key];
      return {
        pending,
        inFlight: { ...state.inFlight, [key]: true },
      };
    });
    try {
      await sendResponse(requestId, response);
      set((state) => {
        const inFlight = { ...state.inFlight };
        delete inFlight[key];
        return { inFlight };
      });
    } catch {
      set((state) => {
        const inFlight = { ...state.inFlight };
        delete inFlight[key];
        return {
          inFlight,
          pending: { ...state.pending, [key]: request },
        };
      });
      throw new Error("Failed to respond to runtime request");
    }
  },

  cancelForTurn: async (runtime, threadId, turnId) => {
    const matches = Object.values(get().pending).filter(
      (request) =>
        request.runtime === runtime &&
        request.threadId === threadId &&
        request.turnId === turnId,
    );
    for (const request of matches) {
      await get().respond(request.requestId, {
        decision: "cancel",
        persistence: null,
        answers: {},
      });
    }
  },

  cancelForTab: async (tabId) => {
    if (!tabId) return;
    const matches = Object.values(get().pending).filter(
      (request) => request.tabId === tabId,
    );
    if (matches.length === 0) return;
    set((state) => {
      const pending = { ...state.pending };
      const inFlight = { ...state.inFlight };
      for (const request of matches) {
        const key = requestKey(request.requestId);
        delete pending[key];
        delete inFlight[key];
      }
      return { pending, inFlight };
    });
    await Promise.all(
      matches.map(async (request) => {
        try {
          await sendResponse(request.requestId, {
            decision: "cancel",
            persistence: null,
            answers: {},
          });
        } catch {
          // The conversation is gone; do not restore the prompt.
        }
      }),
    );
  },

  rejectUnknown: async (request) => {
    get().enqueue(request);
    await get().respond(request.requestId, {
      decision: "unsupported",
      persistence: null,
      answers: {},
    });
  },

  dismiss: (requestId) => {
    const key = requestKey(requestId);
    set((state) => {
      const pending = { ...state.pending };
      const inFlight = { ...state.inFlight };
      delete pending[key];
      delete inFlight[key];
      return { pending, inFlight };
    });
  },

  dismissForTab: (tabId) => {
    set((state) => {
      const pending = { ...state.pending };
      const inFlight = { ...state.inFlight };
      for (const [key, request] of Object.entries(pending)) {
        if (request.tabId === tabId) delete pending[key];
      }
      return { pending, inFlight };
    });
  },

  reset: () => set({ pending: {}, inFlight: {} }),
}));
