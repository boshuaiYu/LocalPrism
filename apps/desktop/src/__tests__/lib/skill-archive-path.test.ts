import { describe, expect, it } from "vitest";
import {
  isSkillArchivePath,
  SKILL_ARCHIVE_FILTERS,
} from "@/components/skills/skill-import-dialogs";

describe("skill archive selection", () => {
  it("asks the OS dialog for the last suffix of zip, tar.gz, and tgz", () => {
    expect(SKILL_ARCHIVE_FILTERS).toEqual([
      { name: "Skill archive", extensions: ["zip", "gz", "tgz"] },
    ]);
    expect(
      SKILL_ARCHIVE_FILTERS.flatMap((filter) => filter.extensions),
    ).not.toContain("tar.gz");
  });

  it("accepts zip, tar.gz, and tgz paths on Windows, macOS, and Linux", () => {
    const accepted = [
      "pack.zip",
      "PACK.ZIP",
      "/tmp/skills/pack.tar.gz",
      "C:\\Users\\me\\pack.TAR.GZ",
      "\\\\server\\share\\pack.tgz",
      "pack.tgz",
      "nested/my.skill.tar.gz",
      "archive.tar.gz/",
    ];
    for (const path of accepted) {
      expect(isSkillArchivePath(path), path).toBe(true);
    }
  });

  it("rejects other files, including a plain gz that the dialog can still show", () => {
    const rejected = [
      "notes.gz",
      "notes.GZ",
      "/tmp/notes.gz",
      "C:\\skills\\notes.gz",
      "archive.tar",
      "archive.tar.bz2",
      "archive.rar",
      "skill.txt",
      "skill.zip.txt",
      "skill.tar.gz.bak",
      "",
      "   ",
      "folder/",
    ];
    for (const path of rejected) {
      expect(isSkillArchivePath(path), path).toBe(false);
    }
  });
});
