import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const confPath = resolve(__dirname, "../../src-tauri/tauri.conf.json");
const hookPath = resolve(__dirname, "../../src-tauri/windows/hooks.nsh");

describe("Windows NSIS uninstall app-data hook", () => {
  const conf = JSON.parse(readFileSync(confPath, "utf-8"));
  const hook = readFileSync(hookPath, "utf-8");

  it("wires the NSIS hook from tauri.conf.json", () => {
    expect(conf.bundle.windows.nsis.installerHooks).toBe("./windows/hooks.nsh");
    expect(conf.bundle.windows.nsis.installMode).toBe("perMachine");
  });

  it("deletes LocalPrism app data only when the uninstall checkbox is checked", () => {
    expect(hook).toContain("!macro NSIS_HOOK_POSTUNINSTALL");
    expect(hook).toContain("$DeleteAppDataCheckboxState = 1");
    expect(hook).toContain("$UpdateMode <> 1");
    expect(hook).toContain('RMDir /r "$APPDATA\\LocalPrism"');
    expect(hook).toContain('RMDir /r "$LOCALAPPDATA\\LocalPrism"');
    expect(hook).toContain('RMDir /r "$APPDATA\\ClaudePrism"');
    expect(hook).toContain('RMDir /r "$LOCALAPPDATA\\ClaudePrism"');
    expect(hook).toContain('RMDir /r "$INSTDIR\\claude-home"');
    expect(hook).toContain('RMDir /r "$INSTDIR\\providers"');
    expect(hook).toContain('RMDir /r "$INSTDIR\\uv"');
    expect(hook).toContain('Delete "$INSTDIR\\.localprism-writable"');
  });

  it("does not recursively delete the install dir or user project folders", () => {
    const commands = hook
      .split("\n")
      .filter((line) => /^\s*(RMDir|Delete)\b/.test(line));
    const commandText = commands.join("\n");
    expect(commandText).not.toMatch(/RMDir\s+\/r\s+"\$INSTDIR"\s*$/m);
    expect(commandText).not.toContain("Documents");
    expect(commandText).not.toContain("\\$INSTDIR\\.localprism\"");
    expect(commandText).toContain('RMDir "$INSTDIR"');
  });
});
