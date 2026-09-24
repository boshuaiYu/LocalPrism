import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const confPath = resolve(__dirname, "../../src-tauri/tauri.conf.json");
const hookPath = resolve(__dirname, "../../src-tauri/windows/hooks.nsh");
const templatePath = resolve(
  __dirname,
  "../../src-tauri/windows/installer.nsi",
);

describe("Windows NSIS uninstall app-data hook", () => {
  const conf = JSON.parse(readFileSync(confPath, "utf-8"));
  const hook = readFileSync(hookPath, "utf-8");
  const template = readFileSync(templatePath, "utf-8");

  it("wires the NSIS hook and template from tauri.conf.json", () => {
    expect(conf.bundle.windows.nsis.installerHooks).toBe("./windows/hooks.nsh");
    expect(conf.bundle.windows.nsis.template).toBe("./windows/installer.nsi");
    expect(conf.bundle.windows.nsis.installMode).toBe("perMachine");
  });

  it("deletes LocalPrism app data only when the uninstall checkbox is checked", () => {
    expect(hook).toContain("!macro NSIS_HOOK_POSTUNINSTALL");
    expect(hook).toContain("$DeleteAppDataCheckboxState = 1");
    expect(hook).toContain("$UpdateMode <> 1");
    expect(hook).toContain('RMDir /r "$APPDATA\\LocalPrism"');
    expect(hook).toContain('RMDir /r "$LOCALAPPDATA\\LocalPrism"');
    expect(hook).toContain('RMDir /r "$INSTDIR\\claude-home"');
    expect(hook).toContain('RMDir /r "$INSTDIR\\providers"');
    expect(hook).toContain('RMDir /r "$INSTDIR\\uv"');
    expect(hook).toContain('Delete "$INSTDIR\\skills-manifest.json"');
    expect(hook).toContain('Delete "$INSTDIR\\.localprism-writable"');
  });

  it("does not delete ClaudePrism app data or the shared WebView2 profile", () => {
    const commands = [hook, template]
      .flatMap((source) => source.split("\n"))
      .filter((line) => /^\s*(RMDir|Delete)\b/.test(line))
      .join("\n");
    expect(commands).not.toContain("ClaudePrism");
    expect(commands).not.toContain("BUNDLEID");
    expect(commands).not.toContain("com.claude-prism.desktop");
    expect(commands).not.toContain("codexprism");
    expect(commands).not.toMatch(/RMDir\s+\/r\s+"\$INSTDIR"\s*$/m);
    expect(commands).not.toContain("Documents");
    expect(commands).toContain('RMDir "$INSTDIR"');
  });
});
