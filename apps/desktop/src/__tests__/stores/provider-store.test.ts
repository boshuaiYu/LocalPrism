import { describe, expect, it } from "vitest";
import {
  isWorkspaceAiReady,
  resolveProviderRequestModel,
  type ProviderModel,
} from "@/stores/provider-store";

describe("isWorkspaceAiReady", () => {
  it("requires the writing engine and an authenticated active provider", () => {
    expect(
      isWorkspaceAiReady({ engineInstalled: false, activeAuthenticated: true }),
    ).toBe(false);
    expect(
      isWorkspaceAiReady({ engineInstalled: true, activeAuthenticated: false }),
    ).toBe(false);
    expect(
      isWorkspaceAiReady({ engineInstalled: true, activeAuthenticated: true }),
    ).toBe(true);
  });
});

describe("resolveProviderRequestModel", () => {
  const chatgptModels: ProviderModel[] = [
    {
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      reasoningEfforts: ["medium", "high"],
      isDefault: true,
    },
    {
      id: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      reasoningEfforts: ["medium"],
      isDefault: false,
    },
  ];

  it("keeps a catalog id", () => {
    expect(resolveProviderRequestModel("gpt-5.6-terra", chatgptModels)).toBe(
      "gpt-5.6-terra",
    );
  });

  it("replaces leftover Claude aliases with the provider default", () => {
    expect(resolveProviderRequestModel("opus", chatgptModels)).toBe(
      "gpt-5.6-sol",
    );
    expect(resolveProviderRequestModel("sonnet", chatgptModels)).toBe(
      "gpt-5.6-sol",
    );
    expect(resolveProviderRequestModel("haiku", chatgptModels)).toBe(
      "gpt-5.6-sol",
    );
  });

  it("returns the requested id when the catalog is empty", () => {
    expect(resolveProviderRequestModel("opus", [])).toBe("opus");
  });
});
