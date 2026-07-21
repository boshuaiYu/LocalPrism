import { describe, expect, it } from "vitest";
import {
  advanceSteps,
  CODEX_INSTALL_STEPS,
  CODEX_LOGIN_STEPS,
  STEP_ORDER_CODEX_INSTALL,
  createPendingSteps,
} from "@/lib/runtime-flow-steps";

describe("runtime-flow-steps", () => {
  it("creates pending copies of Codex install/login steps", () => {
    const install = createPendingSteps(CODEX_INSTALL_STEPS);
    expect(install.map((s) => s.id)).toEqual(STEP_ORDER_CODEX_INSTALL);
    expect(install.every((s) => s.status === "pending")).toBe(true);
    expect(createPendingSteps(CODEX_LOGIN_STEPS)[0]?.id).toBe("opening-browser");
  });

  it("marks prior steps complete when advancing", () => {
    const steps = createPendingSteps(CODEX_INSTALL_STEPS);
    const next = advanceSteps(steps, "verifying", STEP_ORDER_CODEX_INSTALL);
    expect(next.find((s) => s.id === "downloading")?.status).toBe("complete");
    expect(next.find((s) => s.id === "installing")?.status).toBe("complete");
    expect(next.find((s) => s.id === "verifying")?.status).toBe("active");
    expect(next.find((s) => s.id === "complete")?.status).toBe("pending");
  });
});
