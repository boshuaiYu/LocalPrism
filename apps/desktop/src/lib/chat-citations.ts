const LATEX_CITE_RE =
  /\\(?:[Cc]ite[tp]?|(?:paren|text|auto)cite)\*?(?:\[[^\]]*\]){0,2}\{([^}]+)\}/g;
const PANDOC_CITE_RE = /\[@([^\]]+)\]/g;
const NUMBERED_REF_RE = /\\\[(\d+)\\\]/g;
const IN_TEXT_NUM_RE = /\[(\d+)\]/g;
const IN_TEXT_RANGE_RE = /\[(\d+)\s*[-–]\s*(\d+)\]/g;
const BARE_DOI_ORG_RE =
  /(?<![A-Za-z0-9])(?:https?:\/\/)?(?:dx\.)?doi\.org\/(10\.\d{4,}\/[^\s<>[\]]+)/gi;
const BARE_DOI_RE = /(?<![A-Za-z0-9])(?:doi:\s*)?(10\.\d{4,}\/[^\s<>[\]]+)/gi;
const BARE_ARXIV_ORG_RE =
  /(?<![A-Za-z0-9])(?:https?:\/\/)?arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const BARE_ARXIV_RE = /(?<![A-Za-z0-9])arxiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const BARE_WWW_RE = /(?<![A-Za-z0-9/])(www\.[^\s<>()[\]]+)/gi;
const BIB_LINE_RE = /^[ \t]*\[(\d+)\](?:[:.]|\s+)\s*(.+)$/gm;
const MATH_RE =
  /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g;
const AUTOLINK_RE = /<https?:\/\/[^>\s]+>/g;
const MARKDOWN_LINK_RE =
  /\[[^\]]*\]\(<[^>]+>\)|\[[^\]]*\]\([^)\s]*(?:\([^)]*\)[^)\s]*)*(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const GFM_URL_DEF_RE =
  /^[ \t]*\[[^\]]+\]:\s*(?:<https?:\/\/[^>\s]+>|https?:\/\/\S+|doi:\S+|www\.\S+)/gm;

const MARKDOWN_LINK_PLACEHOLDER = "\u0000MDLINK";
const FENCED_PLACEHOLDER = "\u0000FENCE";
const GFM_DEF_PLACEHOLDER = "\u0000GFMDEF";
const MATH_PLACEHOLDER = "\u0000MATH";
const AUTOLINK_PLACEHOLDER = "\u0000AUTOLN";
const CITE_HASH_RE = /^#cite(?:-num)?:[\w.%+-]+$/i;

function trimCitationTail(value: string): string {
  return value.replace(/[.,;:]+$/g, "");
}

function trimDoiSuffix(doi: string): string {
  let value = trimCitationTail(doi);
  while (
    value.endsWith(")") &&
    (value.match(/\(/g)?.length ?? 0) < (value.match(/\)/g)?.length ?? 0)
  ) {
    value = value.slice(0, -1);
  }
  return value;
}

function sanitizeMarkdownUrl(url: string): string {
  if (!url || /[\s\\]/.test(url) || url.startsWith("//")) return "";

  const colon = url.indexOf(":");
  const questionMark = url.indexOf("?");
  const numberSign = url.indexOf("#");
  const slash = url.indexOf("/");

  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign)
  ) {
    return url;
  }

  const protocol = url.slice(0, colon);
  return /^(https?|mailto)$/i.test(protocol) ? url : "";
}

export function normalizeChatHref(href: string | null | undefined): string {
  const raw = (href ?? "").trim();
  if (!raw) return "";
  if (CITE_HASH_RE.test(raw)) return raw;
  if (/^#cite/i.test(raw)) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^mailto:/i.test(raw)) return raw;
  if (/^www\./i.test(raw)) return `https://${raw}`;

  const doi = raw.match(/^(?:doi:\s*)?(10\.\d{4,}\/\S+)$/i);
  if (doi) {
    return `https://doi.org/${trimDoiSuffix(doi[1])}`;
  }

  const arxiv = raw.match(/^arxiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)$/i);
  if (arxiv) {
    return `https://arxiv.org/abs/${arxiv[1]}`;
  }

  return raw;
}

export function isOpenableChatHref(href: string): boolean {
  if (/[\s\\]/.test(href)) return false;
  try {
    const parsed = new URL(href);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function transformChatUrl(url: string): string {
  const normalized = normalizeChatHref(url);
  if (CITE_HASH_RE.test(normalized)) return normalized;
  return sanitizeMarkdownUrl(normalized);
}

function protectSegments(
  source: string,
  pattern: RegExp,
  token: string,
): { text: string; restored: (value: string) => string } {
  const stash: string[] = [];
  const text = source.replace(pattern, (match) => {
    stash.push(match);
    return `${token}${stash.length - 1}\u0000`;
  });
  return {
    text,
    restored: (value) =>
      value.replace(new RegExp(`${token}(\\d+)\u0000`, "g"), (_, index) => {
        return stash[Number(index)] ?? "";
      }),
  };
}

function replaceOutsideCode(
  source: string,
  replacer: (chunk: string) => string,
): string {
  return source
    .split(/(`+[^`]*`+)/g)
    .map((chunk, index) => (index % 2 === 1 ? chunk : replacer(chunk)))
    .join("");
}

function extractCitationUrl(text: string): string | null {
  const https = text.match(/https?:\/\/[^\s<>[\]]+/i);
  if (https) return trimDoiSuffix(https[0]);

  const doiOrg = text.match(/(?:dx\.)?doi\.org\/(10\.\d{4,}\/[^\s<>[\]]+)/i);
  if (doiOrg) return `https://doi.org/${trimDoiSuffix(doiOrg[1])}`;

  const doi = text.match(/(?:doi:\s*)(10\.\d{4,}\/[^\s<>[\]]+)/i);
  if (doi) return `https://doi.org/${trimDoiSuffix(doi[1])}`;

  const arxivOrg = text.match(
    /arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}(?:v\d+)?)/i,
  );
  if (arxivOrg) return `https://arxiv.org/abs/${arxivOrg[1]}`;

  const arxiv = text.match(/arxiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (arxiv) return `https://arxiv.org/abs/${arxiv[1]}`;

  const www = text.match(/\bwww\.[^\s<>()[\]]+/i);
  if (www) return `https://${trimCitationTail(www[0])}`;

  return null;
}

function collectNumberedBibliography(source: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const match of source.matchAll(BIB_LINE_RE)) {
    if (
      /^[ \t]*\[\d+\]:\s+(?:<https?:\/\/|https?:\/\/|doi:|www\.)/i.test(
        match[0],
      )
    ) {
      continue;
    }
    const num = match[1];
    const url = extractCitationUrl(match[2] ?? "");
    refs.set(num, url ?? `#cite-num:${num}`);
  }
  return refs;
}

function citeHash(kind: "cite" | "cite-num", key: string): string {
  return `#${kind}:${key.replace(/[^\w.-]+/g, "_")}`;
}

function citeChip(label: string, href: string): string {
  return `[${label.replace(/[\])\n]/g, "")}](${href})`;
}

function isLocatorKey(key: string): boolean {
  return /^(?:p{1,2}|page|pages|chap|chapter|sec|section|fig|figure)\b/i.test(
    key,
  );
}

function applyOutsideLinks(
  source: string,
  replacer: (chunk: string) => string,
): string {
  const links = protectSegments(
    source,
    MARKDOWN_LINK_RE,
    MARKDOWN_LINK_PLACEHOLDER,
  );
  return links.restored(replaceOutsideCode(links.text, replacer));
}

function applyOutsideMathAndLinks(
  source: string,
  replacer: (chunk: string) => string,
): string {
  const autolinks = protectSegments(source, AUTOLINK_RE, AUTOLINK_PLACEHOLDER);
  const math = protectSegments(autolinks.text, MATH_RE, MATH_PLACEHOLDER);
  return autolinks.restored(
    math.restored(applyOutsideLinks(math.text, replacer)),
  );
}

function promoteCiteKeys(keys: string): string {
  return keys
    .split(/[;,]/)
    .map((key) => key.trim().replace(/^@/, ""))
    .filter((key) => key && !isLocatorKey(key))
    .map((key) => citeChip(key, citeHash("cite", key)))
    .join(" ");
}

export function promoteChatCitations(markdown: string): string {
  const fences = protectSegments(markdown, FENCE_RE, FENCED_PLACEHOLDER);
  const gfmDefs = protectSegments(
    fences.text,
    GFM_URL_DEF_RE,
    GFM_DEF_PLACEHOLDER,
  );
  const numberedRefs = collectNumberedBibliography(gfmDefs.text);

  let next = applyOutsideMathAndLinks(gfmDefs.text, (chunk) =>
    chunk
      .replace(LATEX_CITE_RE, (_match, keys: string) => promoteCiteKeys(keys))
      .replace(PANDOC_CITE_RE, (_match, keys: string) => promoteCiteKeys(keys)),
  );

  next = applyOutsideLinks(next, (chunk) =>
    chunk.replace(NUMBERED_REF_RE, (_match, num: string) => {
      return citeChip(num, numberedRefs.get(num) ?? citeHash("cite-num", num));
    }),
  );

  if (numberedRefs.size > 0) {
    next = applyOutsideMathAndLinks(next, (chunk) =>
      chunk.replace(
        IN_TEXT_RANGE_RE,
        (match, startText: string, endText: string, offset: number) => {
          if (chunk[offset - 1] === "]") return match;
          const start = Number(startText);
          const end = Number(endText);
          if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
            return match;
          }
          if (end - start >= 20) return match;
          const nums = Array.from({ length: end - start + 1 }, (_, i) =>
            String(start + i),
          );
          if (nums.some((num) => !numberedRefs.has(num))) return match;
          return nums
            .map((num) =>
              citeChip(num, numberedRefs.get(num) ?? citeHash("cite-num", num)),
            )
            .join(" ");
        },
      ),
    );
    next = applyOutsideMathAndLinks(next, (chunk) =>
      chunk.replace(IN_TEXT_NUM_RE, (match, num: string, offset: number) => {
        const before = chunk[offset - 1];
        if (before === "!" || before === "]") return match;
        if (chunk[offset + match.length] === "(") return match;
        const href = numberedRefs.get(num);
        return href ? citeChip(num, href) : match;
      }),
    );
  }

  next = applyOutsideMathAndLinks(next, (chunk) =>
    chunk.replace(BARE_DOI_ORG_RE, (match, doi: string) => {
      return citeChip(
        trimDoiSuffix(match),
        `https://doi.org/${trimDoiSuffix(doi)}`,
      );
    }),
  );

  next = applyOutsideMathAndLinks(next, (chunk) =>
    chunk.replace(
      BARE_DOI_RE,
      (match, doi: string, offset: number, whole: string) => {
        const before = whole.slice(Math.max(0, offset - 8), offset);
        if (/https?:\/\/$/i.test(before) || /doi\.org\/$/i.test(before)) {
          return match;
        }
        return citeChip(
          trimDoiSuffix(match.trim()),
          `https://doi.org/${trimDoiSuffix(doi)}`,
        );
      },
    ),
  );

  next = applyOutsideMathAndLinks(next, (chunk) =>
    chunk.replace(BARE_ARXIV_ORG_RE, (match, id: string) => {
      return citeChip(trimCitationTail(match), `https://arxiv.org/abs/${id}`);
    }),
  );

  next = applyOutsideMathAndLinks(next, (chunk) =>
    chunk.replace(
      BARE_ARXIV_RE,
      (match, id: string, offset: number, whole: string) => {
        const before = whole.slice(Math.max(0, offset - 16), offset);
        if (/arxiv\.org\/(?:abs|pdf|html)\/$/i.test(before)) {
          return match;
        }
        return citeChip(
          trimCitationTail(match.trim()),
          `https://arxiv.org/abs/${id}`,
        );
      },
    ),
  );

  next = applyOutsideMathAndLinks(next, (chunk) =>
    chunk.replace(BARE_WWW_RE, (_match, host: string) => {
      const cleaned = trimCitationTail(host);
      return citeChip(cleaned, `https://${cleaned}`);
    }),
  );

  return fences.restored(gfmDefs.restored(next));
}
