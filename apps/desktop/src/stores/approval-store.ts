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
  rejectUnknown: (request: RuntimeRequest) => Promise<void>;
  reset: () => void;
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

  rejectUnknown: async (request) => {
    get().enqueue(request);
    await get().respond(request.requestId, {
      decision: "unsupported",
      persistence: null,
      answers: {},
    });
  },

  reset: () => set({ pending: {}, inFlight: {} }),
}));
