import { describe, expect, it } from "vitest";
import {
  onboardingEscape,
  onboardingGalleryEscape,
  onboardingHasDraft,
  releaseOnboardingTextFocus,
  resolveOnboardingStep,
} from "@/lib/onboarding-flow";

describe("resolveOnboardingStep", () => {
  it("stays on Template until the details phase", () => {
    expect(
      resolveOnboardingStep({
        mode: "template",
        phase: "gallery",
        referencesOpen: false,
        creating: false,
      }),
    ).toBe("template");
    expect(
      resolveOnboardingStep({
        mode: "template",
        phase: "preview",
        referencesOpen: false,
        creating: false,
      }),
    ).toBe("template");
  });

  it("moves through Details, References, and Create", () => {
    expect(
      resolveOnboardingStep({
        mode: "scratch",
        phase: "details",
        referencesOpen: false,
        creating: false,
      }),
    ).toBe("details");
    expect(
      resolveOnboardingStep({
        mode: "template",
        phase: "details",
        referencesOpen: true,
        creating: false,
      }),
    ).toBe("references");
    expect(
      resolveOnboardingStep({
        mode: "scratch",
        phase: "details",
        referencesOpen: false,
        creating: true,
      }),
    ).toBe("create");
  });
});

describe("onboardingEscape", () => {
  it("clears template search before leaving the gallery", () => {
    expect(
      onboardingEscape({
        surface: "gallery",
        searchQuery: "ieee",
        fieldFocused: false,
        referencesOpen: false,
        locationOpen: false,
        hasDraft: false,
      }),
    ).toEqual({ type: "clear-search" });
    expect(
      onboardingEscape({
        surface: "gallery",
        searchQuery: "  ",
        fieldFocused: false,
        referencesOpen: false,
        locationOpen: false,
        hasDraft: false,
      }),
    ).toEqual({ type: "exit" });
  });

  it("pops one level from details without discarding the draft", () => {
    expect(
      onboardingEscape({
        surface: "details",
        searchQuery: "",
        fieldFocused: true,
        referencesOpen: true,
        locationOpen: false,
        hasDraft: true,
      }),
    ).toEqual({ type: "blur-field" });
    expect(
      onboardingEscape({
        surface: "details",
        searchQuery: "",
        fieldFocused: false,
        referencesOpen: true,
        locationOpen: true,
        hasDraft: true,
      }),
    ).toEqual({ type: "close-section", section: "references" });
    expect(
      onboardingEscape({
        surface: "details",
        searchQuery: "",
        fieldFocused: false,
        referencesOpen: false,
        locationOpen: false,
        hasDraft: true,
      }),
    ).toEqual({ type: "back-to-preview" });
  });

  it("keeps a scratch draft when Escape would leave the wizard", () => {
    expect(
      onboardingHasDraft({
        projectName: "paper",
        purpose: "",
        attachmentCount: 0,
      }),
    ).toBe(true);
    expect(
      onboardingEscape({
        surface: "scratch",
        searchQuery: "",
        fieldFocused: false,
        referencesOpen: false,
        locationOpen: false,
        hasDraft: true,
      }),
    ).toEqual({ type: "block-exit" });
    expect(
      onboardingEscape({
        surface: "scratch",
        searchQuery: "",
        fieldFocused: false,
        referencesOpen: false,
        locationOpen: false,
        hasDraft: false,
      }),
    ).toEqual({ type: "exit" });
  });
});

describe("onboardingGalleryEscape", () => {
  it("lets a closed preview dialog consume Escape without leaving the gallery", () => {
    expect(
      onboardingGalleryEscape({
        defaultPrevented: true,
        previewOpen: false,
        searchQuery: "",
        fieldFocused: false,
      }),
    ).toBeNull();
  });

  it("leaves an open preview to the dialog and exits only from the gallery", () => {
    expect(
      onboardingGalleryEscape({
        defaultPrevented: false,
        previewOpen: true,
        searchQuery: "ieee",
        fieldFocused: true,
      }),
    ).toBeNull();
    expect(
      onboardingGalleryEscape({
        defaultPrevented: false,
        previewOpen: false,
        searchQuery: "ieee",
        fieldFocused: true,
      }),
    ).toEqual({ type: "clear-search" });
    expect(
      onboardingGalleryEscape({
        defaultPrevented: false,
        previewOpen: false,
        searchQuery: "",
        fieldFocused: false,
      }),
    ).toEqual({ type: "exit" });
  });
});

describe("releaseOnboardingTextFocus", () => {
  it("parks focus on the dialog so the next Escape can step back", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("data-slot", "dialog-content");
    dialog.tabIndex = -1;
    const input = document.createElement("input");
    dialog.append(input);
    document.body.append(dialog);
    input.focus();

    releaseOnboardingTextFocus(document.activeElement);

    expect(document.activeElement).toBe(dialog);
    dialog.remove();
  });

  it("blurs a field that is not inside a dialog", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    releaseOnboardingTextFocus(input);

    expect(document.activeElement).not.toBe(input);
    input.remove();
  });
});
