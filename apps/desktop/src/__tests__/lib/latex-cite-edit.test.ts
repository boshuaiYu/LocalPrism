import { describe, expect, it } from "vitest";
import {
  findCiteAtSelection,
  findCitesInDoc,
  orderEditedCitekeys,
  parseCiteKeyList,
} from "@/lib/latex-cite-edit";
import { buildCiteCommand } from "@/lib/zotero-citekeys";

const USER_SNIPPET = [
  "\\section{Conclusions}",
  "\\label{conclusions}",
  "\\cite{acharyaAgenticAIAutonomous2025}",
  "",
  "\\cite{AgenticAIWill,alfarisyUnsupervisedDomainSpecificOpenWorld2025,aliiqbalRedefiningObjectDetection2024}",
  "\\section*{Acknowledgment}",
].join("\n");

describe("parseCiteKeyList", () => {
  it("splits, trims, and drops invalid keys", () => {
    expect(parseCiteKeyList("a, b ,a, bad key,c")).toEqual(["a", "b", "c"]);
  });
});

describe("findCitesInDoc", () => {
  it("finds single-key, multi-key, starred, and optional-arg cites", () => {
    const cite = "\\cite{one}";
    const citep = "\\citep[see][p. 1]{two,three}";
    const citet = "\\citet*{four}";
    const doc = `See ${cite} and ${citep} plus ${citet}.`;
    const citeFrom = doc.indexOf(cite);
    const citepFrom = doc.indexOf(citep);
    const citetFrom = doc.indexOf(citet);
    expect(findCitesInDoc(doc)).toEqual([
      {
        from: citeFrom,
        to: citeFrom + cite.length,
        prefix: "\\cite",
        keys: ["one"],
      },
      {
        from: citepFrom,
        to: citepFrom + citep.length,
        prefix: "\\citep[see][p. 1]",
        keys: ["two", "three"],
      },
      {
        from: citetFrom,
        to: citetFrom + citet.length,
        prefix: "\\citet*",
        keys: ["four"],
      },
    ]);
  });

  it("includes empty \\cite{}", () => {
    const doc = "x\\cite{}y";
    expect(findCitesInDoc(doc)).toEqual([
      {
        from: doc.indexOf("\\cite{}"),
        to: doc.indexOf("\\cite{}") + 7,
        prefix: "\\cite",
        keys: [],
      },
    ]);
  });
});

describe("findCiteAtSelection", () => {
  it("detects the cursor inside a single-key cite", () => {
    const doc = "\\cite{acharyaAgenticAIAutonomous2025}";
    expect(findCiteAtSelection(doc, 8, 8)?.keys).toEqual([
      "acharyaAgenticAIAutonomous2025",
    ]);
  });

  it("detects a multi-key cite from the user snippet", () => {
    const multi = findCitesInDoc(USER_SNIPPET)[1];
    expect(multi.keys).toEqual([
      "AgenticAIWill",
      "alfarisyUnsupervisedDomainSpecificOpenWorld2025",
      "aliiqbalRedefiningObjectDetection2024",
    ]);
    expect(
      findCiteAtSelection(USER_SNIPPET, multi.from + 6, multi.from + 6),
    ).toEqual(multi);
    expect(
      findCiteAtSelection(USER_SNIPPET, multi.from, multi.to)?.keys,
    ).toEqual(multi.keys);
  });

  it("treats a collapsed cursor on either edge as on the cite", () => {
    const doc = "aa\\cite{foo}bb";
    const cite = findCitesInDoc(doc)[0];
    expect(findCiteAtSelection(doc, cite.from, cite.from)).toEqual(cite);
    expect(findCiteAtSelection(doc, cite.to, cite.to)).toEqual(cite);
    expect(findCiteAtSelection(doc, 0, 0)).toBeNull();
    expect(findCiteAtSelection(doc, doc.length, doc.length)).toBeNull();
  });

  it("does not treat a range that spills outside the cite as editable", () => {
    const doc = "See \\cite{foo} and more";
    const cite = findCitesInDoc(doc)[0];
    expect(findCiteAtSelection(doc, cite.from, cite.to + 4)).toBeNull();
    expect(findCiteAtSelection(doc, 0, cite.to)).toBeNull();
  });

  it("edits when the selection is only the keys inside the braces", () => {
    const doc = "\\citep{foo,bar}";
    expect(findCiteAtSelection(doc, 7, 14)).toEqual({
      from: 0,
      to: 15,
      prefix: "\\citep",
      keys: ["foo", "bar"],
    });
  });

  it("prefers the left cite when the cursor sits on an adjacent boundary", () => {
    const doc = "\\cite{aaa}\\cite{bbb}";
    const [left, right] = findCitesInDoc(doc);
    expect(left.to).toBe(right.from);
    expect(findCiteAtSelection(doc, left.to, left.to)).toEqual(left);
    expect(findCiteAtSelection(doc, right.from + 1, right.from + 1)).toEqual(
      right,
    );
  });

  it("ignores a nearby section command", () => {
    const ack = USER_SNIPPET.indexOf("\\section*{Acknowledgment}");
    expect(findCiteAtSelection(USER_SNIPPET, ack, ack)).toBeNull();
  });

  it("keeps optional arguments in the prefix", () => {
    const doc = "\\citep[see][]{alpha,beta}";
    const hit = findCiteAtSelection(doc, 16, 16);
    expect(hit?.prefix).toBe("\\citep[see][]");
    expect(hit?.keys).toEqual(["alpha", "beta"]);
    expect(buildCiteCommand(["alpha", "gamma"], hit?.prefix)).toBe(
      "\\citep[see][]{alpha,gamma}",
    );
  });
});

describe("orderEditedCitekeys", () => {
  it("keeps original order and appends newly selected keys", () => {
    expect(
      orderEditedCitekeys(new Set(["c", "a", "d"]), ["a", "b", "c"]),
    ).toEqual(["a", "c", "d"]);
  });
});
