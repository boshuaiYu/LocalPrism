import { describe, expect, it } from "vitest";
import { sanitizeBibtex } from "@/lib/zotero-bibtex";

describe("sanitizeBibtex", () => {
  it("keeps bibliographic fields and strips Zotero extra metadata", () => {
    const input = `@article{smith2020,
  title = {A Paper},
  author = {Smith, John},
  journal = {Nature},
  year = {2020},
  volume = {12},
  number = {3},
  pages = {1--10},
  doi = {10.1/xyz},
  url = {https://example.com},
  abstract = {This is a long abstract
    that spans lines and mentions file = {not-a-field}},
  note = {See also foo},
  notes = {lab notebook},
  annote = {highlighted},
  file = {C:\\\\Users\\\\foo\\\\paper.pdf},
  files = {paper.pdf},
  pdf = {paper.pdf},
  folders = {ML},
  groups = {lab},
  keywords = {ml, vision},
  urldate = {2026-01-01}
}`;

    const cleaned = sanitizeBibtex(input);

    expect(cleaned).toContain("title = {A Paper}");
    expect(cleaned).toContain("author = {Smith, John}");
    expect(cleaned).toContain("journal = {Nature}");
    expect(cleaned).toContain("year = {2020}");
    expect(cleaned).toContain("doi = {10.1/xyz}");
    expect(cleaned).not.toMatch(/\babstract\s*=/i);
    expect(cleaned).not.toMatch(/\bnotes?\s*=/i);
    expect(cleaned).not.toMatch(/\bannote\s*=/i);
    expect(cleaned).not.toMatch(/\bfiles?\s*=/i);
    expect(cleaned).not.toMatch(/\bpdf\s*=/i);
    expect(cleaned).not.toMatch(/\bfolders\s*=/i);
    expect(cleaned).not.toMatch(/\bgroups\s*=/i);
    expect(cleaned).not.toMatch(/\bkeywords\s*=/i);
    expect(cleaned).not.toMatch(/\burldate\s*=/i);
    expect(cleaned).not.toContain("paper.pdf");
    expect(cleaned).not.toContain("long abstract");
  });

  it("preserves booktitle, publisher, and related citation fields", () => {
    const input = `@inproceedings{li2024,
  title = {Nested {Braces} Title},
  booktitle = {NeurIPS},
  editor = {Ada Lovelace},
  publisher = {PMLR},
  year = 2024,
  month = {jun},
  series = {PMLR},
  edition = {2},
  address = {Vancouver},
  organization = {ACM},
  school = {MIT},
  type = {techreport},
  chapter = {4},
  howpublished = {arXiv},
  isbn = {978-1},
  issn = {1234-5678},
  abstract = {drop me}
}`;

    const cleaned = sanitizeBibtex(input);
    expect(cleaned).toContain("booktitle = {NeurIPS}");
    expect(cleaned).toContain("publisher = {PMLR}");
    expect(cleaned).toContain("isbn = {978-1}");
    expect(cleaned).toContain("year = 2024");
    expect(cleaned).toContain("Nested {Braces} Title");
    expect(cleaned).not.toMatch(/\babstract\s*=/i);
  });

  it("keeps preprint identifiers used by arXiv and PubMed", () => {
    const cleaned = sanitizeBibtex(`@article{arxiv2024,
  title = {Preprint},
  eprint = {2401.00001},
  archiveprefix = {arXiv},
  primaryclass = {cs.CL},
  pmid = {12345},
  pmcid = {PMC999},
  abstract = {drop},
  file = {x.pdf}
}`);
    expect(cleaned).toContain("eprint = {2401.00001}");
    expect(cleaned).toContain("archiveprefix = {arXiv}");
    expect(cleaned).toContain("pmid = {12345}");
    expect(cleaned).not.toMatch(/\babstract\s*=/i);
    expect(cleaned).not.toMatch(/\bfile\s*=/i);
  });

  it("sanitizes every entry in a multi-item export", () => {
    const input = `@article{one,
  title = {First},
  abstract = {nope},
  file = {a.pdf}
}

@book{two,
  title = {Second},
  note = {secret}
}`;

    const cleaned = sanitizeBibtex(input);
    expect(cleaned).toContain("@article{one,");
    expect(cleaned).toContain("@book{two,");
    expect(cleaned).toContain("title = {First}");
    expect(cleaned).toContain("title = {Second}");
    expect(cleaned).not.toMatch(/\babstract\s*=/i);
    expect(cleaned).not.toMatch(/\bnote\s*=/i);
    expect(cleaned).not.toMatch(/\bfile\s*=/i);
  });

  it("leaves unparsable input rather than dropping the record", () => {
    const input = "@not-an-entry";
    expect(sanitizeBibtex(input)).toBe("");
    expect(sanitizeBibtex("")).toBe("");
  });
});
