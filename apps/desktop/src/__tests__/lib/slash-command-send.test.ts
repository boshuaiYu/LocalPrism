import { describe, expect, it } from "vitest";
import {
  MAX_SLASH_SUBSTITUTION_CHARS,
  resolveOutgoingSlashPrompt,
  resolveSlashComposerValue,
  resolveVisibleSlashMessage,
} from "@/lib/slash-command-send";

const skill = {
  name: "paper-spine",
  full_command: "/paper-spine",
  scope: "skill",
  content: "HOST ORCHESTRATOR ".repeat(400),
  accepts_arguments: true,
  description: "Academic writing playbook",
};

const intake = {
  name: "paper-spine-intake",
  full_command: "/paper-spine-intake",
  scope: "skill",
  content: [
    "Intake questionnaire",
    "Ask about venue, deadline, and contribution.",
    "Do not invent answers.",
  ].join("\n"),
  accepts_arguments: true,
  description: "Collect paper intake details",
};

const review = {
  name: "review",
  full_command: "/review",
  scope: "default",
  content: "Review $ARGUMENTS",
  accepts_arguments: true,
  description: "Request code review",
};

const install = {
  name: "install-skills",
  full_command: "/install-skills",
  scope: "default",
  content: `Help the user install LocalPrism skills.

User notes (may be empty):
$ARGUMENTS

Hard rules:
- Ask one question at a time.
`,
  accepts_arguments: true,
  description: "Install skills after confirming source and destination",
};

describe("resolveOutgoingSlashPrompt", () => {
  it("does not dump a skill SKILL.md body into the outgoing prompt", () => {
    expect(
      resolveOutgoingSlashPrompt("/paper-spine outline the results", [skill]),
    ).toBe("/paper-spine outline the results");
  });

  it("prefers the skill token when an official slash file shadows the same name", () => {
    const official = {
      name: "academic-pipeline",
      full_command: "/academic-pipeline",
      scope: "user",
      content:
        "Base directory for this skill: D:\\\\LocalPrism\\nAcademic Pipeline intro",
      accepts_arguments: true,
    };
    const pipeline = {
      ...official,
      scope: "skill",
      content: "SKILL.md body ".repeat(40),
    };
    expect(
      resolveOutgoingSlashPrompt("/academic-pipeline 查工业智能体论文", [
        official,
        pipeline,
      ]),
    ).toBe("/academic-pipeline 查工业智能体论文");
  });

  it("splits a glued Chinese question off a known slash command", () => {
    expect(
      resolveOutgoingSlashPrompt(
        "/academic-pipeline查问一下关于工业智能体+记忆的相关论文呢",
        [
          {
            name: "academic-pipeline",
            full_command: "/academic-pipeline",
            scope: "skill",
            content: "SKILL.md body",
            accepts_arguments: true,
          },
        ],
      ),
    ).toBe("/academic-pipeline 查问一下关于工业智能体+记忆的相关论文呢");
  });

  it("sends only the skill token when there are no user-typed arguments", () => {
    expect(resolveOutgoingSlashPrompt("/paper-spine-intake", [intake])).toBe(
      "/paper-spine-intake",
    );
    expect(resolveOutgoingSlashPrompt("/paper-spine-intake   ", [intake])).toBe(
      "/paper-spine-intake",
    );
  });

  it("drops a skill questionnaire leftover that was not typed as user notes", () => {
    expect(
      resolveOutgoingSlashPrompt(`/paper-spine-intake ${intake.content}`, [
        intake,
      ]),
    ).toBe("/paper-spine-intake");
  });

  it("substitutes arguments for default slash commands", () => {
    expect(resolveOutgoingSlashPrompt("/review intro", [review])).toBe(
      "Review intro",
    );
  });

  it("substitutes empty arguments for default commands without inventing questions", () => {
    expect(resolveOutgoingSlashPrompt("/review", [review])).toBe("Review ");
    expect(resolveOutgoingSlashPrompt("/install-skills", [install])).toBe(
      install.content.replace(/\$ARGUMENTS/g, ""),
    );
  });

  it("drops a default-command questionnaire leftover from $ARGUMENTS", () => {
    const resolved = resolveOutgoingSlashPrompt(
      `/install-skills ${install.content}`,
      [install],
    );
    expect(resolved).toBe(install.content.replace(/\$ARGUMENTS/g, ""));
    expect(resolved).not.toContain("$ARGUMENTS");
    expect(resolved.match(/Ask one question at a time/g)?.length).toBe(1);
  });

  it("keeps user-typed notes after the command", () => {
    expect(
      resolveOutgoingSlashPrompt("/install-skills only scanpy please", [
        install,
      ]),
    ).toBe(install.content.replace(/\$ARGUMENTS/g, "only scanpy please"));
  });

  it("truncates an oversized substituted command instead of sending it whole", () => {
    const huge = {
      name: "mega",
      full_command: "/mega",
      scope: "default",
      content: "X".repeat(MAX_SLASH_SUBSTITUTION_CHARS + 200),
      accepts_arguments: true,
    };
    const resolved = resolveOutgoingSlashPrompt("/mega please keep this", [
      huge,
    ]);
    expect(resolved.length).toBeLessThan(huge.content.length);
    expect(resolved).toContain("[LocalPrism truncated this slash command");
    expect(resolved).toContain("please keep this");
  });
});

describe("resolveVisibleSlashMessage", () => {
  it("shows the skill token plus user notes, not the SKILL.md body", () => {
    expect(
      resolveVisibleSlashMessage("/paper-spine outline the results", [skill]),
    ).toBe("/paper-spine outline the results");
    expect(
      resolveVisibleSlashMessage(`/paper-spine-intake ${intake.content}`, [
        intake,
      ]),
    ).toBe("/paper-spine-intake");
  });

  it("keeps default-command labels short while the engine still gets the body", () => {
    expect(resolveVisibleSlashMessage("/install-skills", [install])).toBe(
      "/install-skills",
    );
    expect(
      resolveVisibleSlashMessage("/install-skills only scanpy please", [
        install,
      ]),
    ).toBe("/install-skills only scanpy please");
    expect(
      resolveVisibleSlashMessage(`/install-skills ${install.content}`, [
        install,
      ]),
    ).toBe("/install-skills");
    expect(resolveOutgoingSlashPrompt("/install-skills", [install])).toBe(
      install.content.replace(/\$ARGUMENTS/g, ""),
    );
  });
});

describe("resolveSlashComposerValue", () => {
  it("replaces previous composer text that was not slash arguments", () => {
    expect(resolveSlashComposerValue("please review the intro", review)).toBe(
      "/review ",
    );
  });

  it("keeps arguments the user was already editing after a slash command", () => {
    expect(resolveSlashComposerValue("/rev intro section", review)).toBe(
      "/review intro section",
    );
  });

  it("does not leave a command questionnaire after the selected token", () => {
    expect(
      resolveSlashComposerValue(
        `/paper-spine-intake ${intake.content}`,
        intake,
      ),
    ).toBe("/paper-spine-intake ");
  });

  it("keeps a glued Chinese question when picking the command", () => {
    expect(
      resolveSlashComposerValue("/academic-pipeline查问一下论文", {
        name: "academic-pipeline",
        full_command: "/academic-pipeline",
        scope: "skill",
        content: "SKILL.md body",
        accepts_arguments: true,
      }),
    ).toBe("/academic-pipeline 查问一下论文");
  });
});

describe("slash name collisions", () => {
  it("does not treat /review-code as /review", () => {
    const reviewCode = {
      name: "review",
      full_command: "/review-code",
      scope: "skill",
      content: "SKILL.md",
      accepts_arguments: true,
    };
    expect(
      resolveOutgoingSlashPrompt("/review-code please", [review, reviewCode]),
    ).toBe("/review-code please");
    expect(
      resolveOutgoingSlashPrompt("/review intro", [review, reviewCode]),
    ).toBe("Review intro");
  });
});
