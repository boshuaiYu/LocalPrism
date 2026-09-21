import { describe, expect, it } from "vitest";
import { progressFromInstallLogs } from "@/components/scientific-skills/install-progress";

describe("progressFromInstallLogs", () => {
  it("moves off 0 when a default pack starts updating", () => {
    expect(
      progressFromInstallLogs([
        "Preparing installer...",
        "Updating paper-spine…",
      ]),
    ).toBeGreaterThan(0);
    expect(
      progressFromInstallLogs([
        "Preparing installer...",
        "Updating paper-spine…",
        "Updating nature-skills…",
      ]),
    ).toBeGreaterThan(
      progressFromInstallLogs([
        "Preparing installer...",
        "Updating paper-spine…",
      ]),
    );
  });

  it("uses download logs inside the current pack instead of staying at 0", () => {
    expect(
      progressFromInstallLogs([
        "Updating paper-spine…",
        "Downloading skills...",
        "Download progress 50%",
      ]),
    ).toBeGreaterThan(10);
    expect(
      progressFromInstallLogs([
        "Download progress 40%",
        "Updating paper-spine…",
      ]),
    ).toBeGreaterThan(progressFromInstallLogs(["Updating paper-spine…"]));
  });

  it("reaches 100 only when the installer reports complete", () => {
    expect(
      progressFromInstallLogs(
        ["Updating paper-spine…", "Copied 3 skills"],
        true,
      ),
    ).toBe(100);
  });
});
