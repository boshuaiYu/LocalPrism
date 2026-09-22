import { describe, expect, it } from "vitest";
import {
  PROJECT_FORM_CHROME_ATTR,
  deferProjectNameBlur,
  getProjectNameError,
  projectNameErrorFromBlur,
} from "@/lib/project-name";

describe("project name validation timing", () => {
  it("still reports an empty name for submit", () => {
    expect(getProjectNameError("")).toBe("Enter a project name");
    expect(getProjectNameError("  paper  ")).toBeNull();
  });

  it("does not validate when blur comes from an accordion toggle", () => {
    const button = document.createElement("button");
    button.setAttribute(PROJECT_FORM_CHROME_ATTR, "");
    const icon = document.createElement("span");
    button.append(icon);

    expect(projectNameErrorFromBlur("", icon)).toBeUndefined();

    const flag = { current: false };
    deferProjectNameBlur(flag);
    expect(projectNameErrorFromBlur("", null, flag.current)).toBeUndefined();
  });

  it("validates when the name field blurs to another control", () => {
    const textarea = document.createElement("textarea");
    expect(projectNameErrorFromBlur("", textarea)).toBe("Enter a project name");
    expect(projectNameErrorFromBlur("", null)).toBe("Enter a project name");
    expect(projectNameErrorFromBlur("notes", null)).toBeNull();
  });
});
