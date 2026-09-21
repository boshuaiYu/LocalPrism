import { afterEach, describe, expect, it } from "vitest";
import {
  activeCompileUsesTexlive,
  resetTexliveAvailabilityForTests,
  resolveUseTexlive,
  setCachedTexliveAvailableForTests,
} from "@/lib/latex-compiler";
import { useSettingsStore } from "@/stores/settings-store";

describe("resolveUseTexlive", () => {
  it("uses Tectonic when the user did not pick TeXLive", () => {
    expect(resolveUseTexlive("tectonic", true)).toBe(false);
    expect(resolveUseTexlive("tectonic", false)).toBe(false);
  });

  it("uses TeXLive only when it is installed", () => {
    expect(resolveUseTexlive("texlive", true)).toBe(true);
    expect(resolveUseTexlive("texlive", false)).toBe(false);
  });

  it("lets the native compiler decide when TeXLive status is still unknown", () => {
    expect(resolveUseTexlive("texlive", null)).toBe(true);
  });
});

describe("activeCompileUsesTexlive", () => {
  afterEach(() => {
    resetTexliveAvailabilityForTests();
    useSettingsStore.setState({ compilerBackend: "tectonic" });
  });

  it("does not request TeXLive when xelatex is missing", () => {
    useSettingsStore.setState({ compilerBackend: "texlive" });
    setCachedTexliveAvailableForTests(false);
    expect(activeCompileUsesTexlive()).toBe(false);
  });
});
