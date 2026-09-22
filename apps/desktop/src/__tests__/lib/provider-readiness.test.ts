import { describe, expect, it } from "vitest";
import {
  providerCardStatusLabel,
  providerReadinessBadge,
  providerStatusDetail,
} from "@/lib/provider-readiness";

const siliconFlow = {
  kind: "third-party",
  name: "SiliconFlow",
  authenticated: true,
  isActive: true,
  accountLabel: "Qwen/Qwen2.5-7B-Instruct",
};

const claudeSignedOut = {
  kind: "official-claude",
  authenticated: false,
  isActive: false,
  accountLabel: null,
};

const chatgptSignedOut = {
  kind: "official-chatgpt",
  authenticated: false,
  isActive: false,
  accountLabel: null,
};

describe("provider readiness", () => {
  it("counts a connected API provider even when both legacy engines are signed out", () => {
    const cards = [claudeSignedOut, chatgptSignedOut, siliconFlow];
    const models = [{ isDefault: true }];

    expect(
      providerReadinessBadge({
        engineInstalled: true,
        cards,
        models,
      }),
    ).toBe("Engine on · 1 connected · Model set");
    expect(providerCardStatusLabel(siliconFlow, models)).toBe("Active");
    expect(providerStatusDetail(siliconFlow, models)).toBe(
      "Qwen/Qwen2.5-7B-Instruct · Active",
    );
    expect(providerCardStatusLabel(claudeSignedOut, models)).toBe(
      "Not connected",
    );
  });

  it("keeps engine, connection, and model as separate facts", () => {
    expect(
      providerReadinessBadge({
        engineInstalled: false,
        cards: [siliconFlow],
        models: [],
      }),
    ).toBe("Engine off · 1 connected · Model set");

    expect(
      providerCardStatusLabel(
        { ...siliconFlow, accountLabel: " ", kind: "official-claude" },
        [],
      ),
    ).toBe("Active · no model");

    expect(
      providerReadinessBadge({
        engineInstalled: true,
        cards: [
          { ...claudeSignedOut, authenticated: true },
          { ...chatgptSignedOut, authenticated: true, isActive: true },
        ],
        models: [],
      }),
    ).toBe("Engine on · 2 connected · No model");
  });

  it("labels a saved provider that is not the default as connected", () => {
    const saved = { ...siliconFlow, isActive: false };
    expect(providerCardStatusLabel(saved, [{ isDefault: true }])).toBe(
      "Connected",
    );
  });
});
