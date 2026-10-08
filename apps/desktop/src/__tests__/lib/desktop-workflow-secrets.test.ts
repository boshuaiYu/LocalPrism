import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(__dirname, "../../../../../.github/workflows/build-desktop.yml"),
  "utf8",
);

describe("desktop release workflow secrets", () => {
  it("does not expose the updater signing key to every job", () => {
    expect(workflow).not.toMatch(
      /^env:\n(?: {2}.*\n)* {2}TAURI_SIGNING_PRIVATE_KEY:/m,
    );
    expect(workflow).toContain("sign-updater:");
    expect(workflow).toContain("ci-sign-updater-artifacts.sh");
    expect(workflow).toContain("ci-ephemeral-updater-key.sh");
  });

  it("gives the release key only to the sign-updater job", () => {
    const signJob = workflow.split("sign-updater:")[1] ?? "";
    expect(signJob).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY");
    const beforeSign = workflow.split("sign-updater:")[0] ?? "";
    expect(beforeSign).not.toContain("secrets.TAURI_SIGNING_PRIVATE_KEY");
  });

  it("puts the GitHub changelog into latest.json before signing", () => {
    const signJob =
      workflow.split("sign-updater:")[1]?.split("\n  publish:")[0] ?? "";
    const notesScript = readFileSync(
      resolve(__dirname, "../../../../../scripts/ci-updater-release-notes.sh"),
      "utf8",
    );
    expect(signJob).toContain("ci-updater-release-notes.sh");
    expect(signJob).toContain("UPDATER_RELEASE_NOTES_FILE");
    expect(signJob.indexOf("ci-updater-release-notes.sh")).toBeLessThan(
      signJob.indexOf("ci-sign-updater-artifacts.sh"),
    );
    expect(notesScript).toContain("releases/generate-notes");
    expect(notesScript).toContain("gh release view");
  });

  it("still publishes from the signed latest.json after the split", () => {
    const publish = workflow.split("publish:")[1] ?? "";
    expect(workflow).toContain("needs: [sign-updater]");
    expect(publish).toContain("desktop-signed");
    expect(publish).toContain("latest.json");
    expect(publish).toContain("manifest_signature");
    expect(publish).toContain(
      "latest.json is missing a non-empty manifest_signature",
    );
  });
});
