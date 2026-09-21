import { describe, expect, it } from "vitest";
import {
  newProjectFileTemplate,
  resolveNewProjectFile,
} from "@/lib/new-project-file";

describe("resolveNewProjectFile", () => {
  it("appends .tex or .md when the name has no extension", () => {
    expect(resolveNewProjectFile("main", "tex")).toEqual({
      name: "main.tex",
      type: "tex",
    });
    expect(resolveNewProjectFile("notes", "markdown")).toEqual({
      name: "notes.md",
      type: "markdown",
    });
  });

  it("honors an explicit markdown extension even if LaTeX is selected", () => {
    expect(resolveNewProjectFile("readme.md", "tex")).toEqual({
      name: "readme.md",
      type: "markdown",
    });
  });

  it("builds a markdown heading from the file stem", () => {
    expect(newProjectFileTemplate("notes.md", "markdown")).toBe("# notes\n\n");
  });
});
