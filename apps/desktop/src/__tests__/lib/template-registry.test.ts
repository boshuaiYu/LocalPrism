import { describe, it, expect } from "vitest";
import {
  searchTemplates,
  getTemplateById,
  getTemplatesByCategory,
  getTemplateSkeleton,
  getTemplateProjectFiles,
  getAllTemplates,
  getWelcomeTemplates,
  WELCOME_TEMPLATE_IDS,
} from "@/lib/template-registry";

describe("template-registry", () => {
  describe("getAllTemplates", () => {
    it("returns a non-empty array", () => {
      const all = getAllTemplates();
      expect(all.length).toBeGreaterThan(0);
    });

    it("each template has required fields", () => {
      for (const t of getAllTemplates()) {
        expect(t.id).toBeTruthy();
        expect(t.name).toBeTruthy();
        expect(t.category).toBeTruthy();
        expect(t.content).toBeTruthy();
      }
    });
  });

  describe("searchTemplates", () => {
    it("returns all templates for empty query", () => {
      expect(searchTemplates("")).toHaveLength(getAllTemplates().length);
      expect(searchTemplates("  ")).toHaveLength(getAllTemplates().length);
    });

    it("finds HIT campus templates by keyword", () => {
      const hitsz = searchTemplates("hitszthesis");
      expect(hitsz.some((template) => template.id === "thesis-hitsz")).toBe(
        true,
      );
      expect(
        searchTemplates("推荐信").some(
          (template) => template.id === "letter-hit-recommendation",
        ),
      ).toBe(true);
      expect(
        searchTemplates("海报").some(
          (template) => template.id === "poster-hitsz",
        ),
      ).toBe(true);
    });

    it("filters by keyword (case insensitive)", () => {
      const results = searchTemplates("PAPER");
      expect(results.length).toBeGreaterThan(0);
      // All results should mention paper in name, description, tags, etc.
    });

    it("supports multi-word search", () => {
      const results = searchTemplates("research paper");
      expect(results.length).toBeGreaterThan(0);
    });

    it("returns empty for nonsense query", () => {
      const results = searchTemplates("xyznonexistent123");
      expect(results).toHaveLength(0);
    });
  });

  describe("getTemplateById", () => {
    it("returns a template for a known id", () => {
      const t = getTemplateById("paper-standard");
      expect(t).toBeDefined();
      expect(t!.name).toBe("Research Paper");
    });

    it("returns undefined for unknown id", () => {
      expect(getTemplateById("nonexistent-id")).toBeUndefined();
    });

    it("includes welcome paper templates", () => {
      expect(getTemplateById("paper-ieee")?.documentClass).toBe("IEEEtran");
      expect(getTemplateById("paper-arxiv")?.name).toMatch(/arXiv/i);
      expect(getTemplateById("paper-elsevier")?.documentClass).toBe(
        "elsarticle",
      );
      expect(getTemplateById("paper-chinese")?.documentClass).toBe("ctexart");

      for (const id of WELCOME_TEMPLATE_IDS) {
        const template = getTemplateById(id);
        expect(template).toBeDefined();
        expect(template!.content).toContain("\\documentclass");
        expect(template!.content).toContain("\\begin{document}");
        expect(template!.content).toContain("\\end{document}");
        expect(template!.content).toMatch(/\\section\{/);
      }

      expect(getTemplateById("paper-arxiv")?.content).toContain("Related Work");
      expect(getTemplateById("paper-elsevier")?.content).toContain(
        "Related work",
      );
      expect(getTemplateById("paper-chinese")?.content).toContain("相关工作");
    });

    it("includes HIT recommendation, poster, and hitszthesis templates", () => {
      expect(getTemplateById("letter-hit-recommendation")?.content).toContain(
        "LETTER OF RECOMMENDATION",
      );
      expect(getTemplateById("letter-hitsz-recommendation")?.content).toContain(
        "哈尔滨工业大学（深圳）",
      );
      expect(getTemplateById("poster-hitsz")?.documentClass).toBe("beamer");
      expect(getTemplateById("thesis-hitsz")?.documentClass).toBe(
        "hitszthesis",
      );
      expect(getTemplateById("thesis-hitsz")?.content).toContain(
        "\\PassOptionsToPackage{sort&compress,numbers}{natbib}",
      );
      expect(
        getTemplateById("thesis-hitsz")?.extraFiles?.some(
          (file) => file.path === "front/coverinformation.tex",
        ),
      ).toBe(true);
    });
  });

  describe("getWelcomeTemplates", () => {
    it("returns IEEE, arXiv, Elsevier, and Chinese papers", () => {
      const names = getWelcomeTemplates().map((template) => template.name);
      expect(names.join(" ")).toMatch(/IEEE/);
      expect(names.join(" ")).toMatch(/arXiv/);
      expect(names.join(" ")).toMatch(/Elsevier/);
      expect(names.join(" ")).toMatch(/Chinese/);
    });
  });

  describe("getTemplatesByCategory", () => {
    it("returns only templates of the given category", () => {
      const academic = getTemplatesByCategory("academic");
      expect(academic.length).toBeGreaterThan(0);
      expect(academic.every((t) => t.category === "academic")).toBe(true);
    });

    it("returns templates for each category", () => {
      for (const cat of [
        "academic",
        "professional",
        "creative",
        "starter",
      ] as const) {
        expect(getTemplatesByCategory(cat).length).toBeGreaterThan(0);
      }
    });
  });

  describe("getTemplateProjectFiles", () => {
    it("seeds the full example body instead of an empty document", () => {
      const template = getTemplateById("paper-arxiv")!;
      const files = getTemplateProjectFiles(template);
      const main = files.find((file) => file.path === template.mainFileName);
      expect(main?.content).toContain("\\maketitle");
      expect(main?.content).toContain("Score-Based Calibration");
      expect(main?.content).not.toContain(
        "Placeholder — content will be generated",
      );
    });

    it("writes hitszthesis extras including reference.bib", () => {
      const template = getTemplateById("thesis-hitsz")!;
      const paths = getTemplateProjectFiles(template).map((file) => file.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          "main.tex",
          "front/coverinformation.tex",
          "body/chapter01.tex",
          "reference.bib",
        ]),
      );
      expect(paths).not.toContain("references.bib");
    });
  });

  describe("getTemplateSkeleton", () => {
    it("returns preamble + empty document body", () => {
      const t = getTemplateById("paper-standard")!;
      const skeleton = getTemplateSkeleton(t);
      expect(skeleton).toContain("\\documentclass");
      expect(skeleton).toContain("\\begin{document}");
      expect(skeleton).toContain("\\end{document}");
      expect(skeleton).toContain("\\mbox{}");
      // Should NOT contain the full body content from template
      expect(skeleton).not.toContain("\\maketitle");
    });

    it("returns full content if no \\begin{document} marker", () => {
      const fakeTemplate = {
        ...getTemplateById("paper-standard")!,
        content: "just some preamble without document begin",
      };
      expect(getTemplateSkeleton(fakeTemplate)).toBe(fakeTemplate.content);
    });
  });
});
