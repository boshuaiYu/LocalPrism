import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/stores/settings-store";

const STORAGE_KEY = "claude-prism-settings";

describe("latex teaching setting", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      latexTeaching: false,
      uiLanguage: "en",
      vimMode: false,
    });
  });

  it("defaults off, persists an opt-in, and ignores non-boolean values", async () => {
    expect(useSettingsStore.getState().latexTeaching).toBe(false);

    useSettingsStore.getState().setLatexTeaching(true);
    expect(useSettingsStore.getState().latexTeaching).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toContain('"latexTeaching":true');

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { vimMode: true, uiLanguage: "zh" },
        version: 6,
      }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().latexTeaching).toBe(false);
    expect(useSettingsStore.getState().vimMode).toBe(true);
    expect(useSettingsStore.getState().uiLanguage).toBe("zh");

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { latexTeaching: "yes", uiLanguage: "en" },
        version: 7,
      }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().latexTeaching).toBe(false);

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { latexTeaching: true, uiLanguage: "zh" },
        version: 7,
      }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().latexTeaching).toBe(true);
    expect(useSettingsStore.getState().uiLanguage).toBe("zh");
  });
});
