import { describe, expect, it } from "vitest";
import {
  builtInDefaultAgentId,
  findBuiltInDefaultAgent,
  resolveOpenAgentId,
} from "@/lib/default-agent";

function agent(
  id: string,
  name: string,
  extra: {
    scope?: "user" | "project";
    unknownFields?: Record<string, string>;
  } = {},
) {
  return {
    id,
    name,
    scope: extra.scope ?? "user",
    unknownFields: extra.unknownFields,
  };
}

describe("built-in default agent identity", () => {
  it("recognizes the default agent by slug, display name, or flag", () => {
    expect(
      findBuiltInDefaultAgent([
        agent("academic-polish", "论文抛光机"),
        agent("default-agent", "Writer"),
      ])?.id,
    ).toBe("default-agent");

    expect(
      findBuiltInDefaultAgent([
        agent("academic-polish", "论文抛光机"),
        agent("writer", "默认智能体"),
      ])?.id,
    ).toBe("writer");

    expect(
      findBuiltInDefaultAgent([
        agent("academic-polish", "论文抛光机"),
        agent("writer", "Writer", { unknownFields: { default: "true" } }),
      ])?.id,
    ).toBe("writer");
  });

  it("prefers an explicit flag, then the default slug, and user scope over project", () => {
    expect(
      findBuiltInDefaultAgent([
        agent("default", "论文抛光机", { scope: "project" }),
        agent("writer", "自定义", {
          unknownFields: { isDefault: "true" },
        }),
      ])?.id,
    ).toBe("writer");

    expect(
      findBuiltInDefaultAgent([
        agent("default-agent", "项目默认", { scope: "project" }),
        agent("custom", "默认智能体", { scope: "user" }),
      ])?.id,
    ).toBe("default-agent");

    expect(
      findBuiltInDefaultAgent([
        agent("default", "项目里的默认", { scope: "project" }),
        agent("default", "用户默认", { scope: "user" }),
      ])?.scope,
    ).toBe("user");
  });

  it("returns null when the list has no built-in default agent", () => {
    expect(
      builtInDefaultAgentId([
        agent("academic-polish", "论文抛光机"),
        agent("de-ai", "AI消除器"),
      ]),
    ).toBeNull();
  });
});

describe("resolveOpenAgentId", () => {
  const agents = [
    agent("academic-polish", "论文抛光机"),
    agent("default-agent", "默认智能体"),
    agent("de-ai", "AI消除器"),
  ];

  it("keeps a listed agent the user already selected", () => {
    expect(resolveOpenAgentId("de-ai", agents)).toBe("de-ai");
  });

  it("selects the built-in default agent when nothing or an unknown id is selected", () => {
    expect(resolveOpenAgentId(null, agents)).toBe("default-agent");
    expect(resolveOpenAgentId("   ", agents)).toBe("default-agent");
    expect(resolveOpenAgentId("missing-agent", agents)).toBe("default-agent");
  });

  it("uses the synthetic default when no built-in default agent is listed", () => {
    const presets = [
      agent("academic-polish", "论文抛光机"),
      agent("de-ai", "AI消除器"),
    ];
    expect(resolveOpenAgentId(null, presets)).toBeNull();
    expect(resolveOpenAgentId("gone", presets)).toBeNull();
  });
});
