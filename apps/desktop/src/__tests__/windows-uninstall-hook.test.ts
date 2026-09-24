import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const confPath = resolve(__dirname, "../../src-tauri/tauri.conf.json");
const hookPath = resolve(__dirname, "../../src-tauri/windows/hooks.nsh");
const templatePath = resolve(
  __dirname,
  "../../src-tauri/windows/installer.nsi",
);

const INSTALL_DIR_CHILDREN = [
  "claude-home",
  "providers",
  "uv",
  "skills",
  ".skills",
  "agents",
  ".agents",
  "slash",
];

const nsisIf = "$" + "{If}";
const nsisEndIf = "$" + "{EndIf}";

function commandLines(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => /^\s*(rmdir|delete)\b/i.test(line));
}

function guardedDelete(condition: string, body: string): string {
  return [
    `    ${nsisIf} ${condition}`,
    `      ${body}`,
    `    ${nsisEndIf}`,
  ].join("\n");
}

describe("Windows NSIS uninstall app-data hook", () => {
  const conf = JSON.parse(readFileSync(confPath, "utf-8"));
  const hook = readFileSync(hookPath, "utf-8");
  const template = readFileSync(templatePath, "utf-8");

  it("wires the NSIS hook and template from tauri.conf.json", () => {
    expect(conf.bundle.windows.nsis.installerHooks).toBe("./windows/hooks.nsh");
    expect(conf.bundle.windows.nsis.template).toBe("./windows/installer.nsi");
    expect(conf.bundle.windows.nsis.installMode).toBe("perMachine");
  });

  it("deletes only named LocalPrism children inside guarded AppData paths", () => {
    expect(hook).toContain("!macro NSIS_HOOK_POSTUNINSTALL");
    expect(hook).toContain("$DeleteAppDataCheckboxState = 1");
    expect(hook).toContain("$UpdateMode <> 1");
    expect(hook).toContain("SetShellVarContext current");
    expect(hook).toContain(
      guardedDelete(
        '"$APPDATA\\LocalPrism" != $INSTDIR',
        'RMDir /r "$APPDATA\\LocalPrism"',
      ),
    );
    expect(hook).toContain(
      guardedDelete(
        '"$LOCALAPPDATA\\LocalPrism" != $INSTDIR',
        'RMDir /r "$LOCALAPPDATA\\LocalPrism"',
      ),
    );
    expect(hook.match(/RMDir\s+\/r\s+"\$APPDATA\\LocalPrism"/g)).toHaveLength(
      1,
    );
    expect(
      hook.match(/RMDir\s+\/r\s+"\$LOCALAPPDATA\\LocalPrism"/g),
    ).toHaveLength(1);
    for (const name of INSTALL_DIR_CHILDREN) {
      expect(hook).toContain(`RMDir /r "$INSTDIR\\${name}"`);
    }
    expect(hook).toContain('Delete "$INSTDIR\\skills-manifest.json"');
    expect(hook).toContain('Delete "$INSTDIR\\.localprism-writable"');
    expect(hook).toContain('RMDir "$INSTDIR"');
    expect(hook).not.toMatch(/RMDir\s+\/r\s+"\$INSTDIR"\s*$/im);
    expect(hook).not.toContain("LOCALPRISM_HOME");
  });

  it("does not delete ClaudePrism app data or the shared WebView2 profile", () => {
    const commands = commandLines(`${hook}\n${template}`).join("\n");
    expect(commands).not.toMatch(/claudeprism/i);
    expect(commands).not.toMatch(/bundleid/i);
    expect(commands).not.toMatch(/com\.claude-prism\.desktop/i);
    expect(commands).not.toMatch(/codexprism/i);
    expect(commands).not.toMatch(/documents/i);
    expect(template).not.toMatch(/RmDir\s+\/r\s+"\$APPDATA\\\$\{BUNDLEID\}"/i);
    expect(template).not.toMatch(
      /RmDir\s+\/r\s+"\$LOCALAPPDATA\\\$\{BUNDLEID\}"/i,
    );
  });
});
