const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const MATH_RE =
  /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g;
const INLINE_CODE_RE = /(`+)([^`\n]+)\1/g;
const BRACKET_LINE_RE = /^([ \t]*)\[([^\]\n]+)\]([ \t]*[.,;:]?)[ \t]*$/;
const MULTILINE_BRACKET_CLOSE_RE = /^[ \t]*\][ \t]*[.,;:]?[ \t]*$/;
const MATH_PLACEHOLDER = "\u0000MATH";

const MATH_COMMAND_RE =
  /\\(?:frac|dfrac|tfrac|sum|prod|int|min|max|lim|arg|operatorname|text|mathrm|mathbf|mathit|mathcal|mathbb|left|right|leftarrow|rightarrow|Leftarrow|Rightarrow|leftrightarrow|longleftarrow|longrightarrow|to|gets|mapsto|in|notin|subset|supset|subseteq|supseteq|leq|geq|neq|approx|equiv|sim|propto|times|cdot|odot|infty|partial|nabla|log|ln|exp|sin|cos|tan|alpha|beta|gamma|delta|epsilon|varepsilon|theta|lambda|mu|sigma|omega|phi|psi|pi|Delta|Gamma|Lambda|Omega|Sigma|Theta|Phi|Psi|tilde|hat|bar|vec|dot|sqrt|binom|quad|qquad|ldots|cdots|forall|exists|pm|mp|mid|ell|hbar|displaystyle|textstyle)\b/;

const STRUCTURAL_COMMAND_RE =
  /\\(?:cite[a-z]*|parencite|textcite|autocite|ref|eqref|label|bibliography|bibitem|include|input|usepackage|documentclass|section|subsection|subsubsection|chapter|paragraph|item|textbf|textit|emph|url|href|footnote|caption|centering|maketitle|newcommand|renewcommand|begin|end)\b/;

function hasMathSignal(text: string): boolean {
  if (MATH_COMMAND_RE.test(text)) return true;
  if (/\\[a-zA-Z]+/.test(text) && /[_^]/.test(text)) return true;
  if (/\^[{(]|_\{/.test(text)) return true;
  if (/[=<>≤≥≠].*[_^]|[_^].*[=<>≤≥≠]/.test(text)) return true;
  return false;
}

function isStructuralTexOnly(text: string): boolean {
  if (MATH_COMMAND_RE.test(text) || /_\{|\^[{(]/.test(text)) return false;
  return STRUCTURAL_COMMAND_RE.test(text);
}

function isCitationLike(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^[@^]/.test(trimmed)) return true;
  if (/^\^[\w.:-]+$/.test(trimmed)) return true;
  if (/^\d+(?:\s*[,–-]\s*\d+)*$/.test(trimmed)) return true;
  if (/https?:\/\//i.test(trimmed) || /\bwww\./i.test(trimmed)) return true;
  if (
    /^(?:p{1,2}|page|pages|chap|chapter|sec|section|fig|figure)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  return false;
}

function isSafeMathFragment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 800) return false;
  if (
    trimmed.includes("$") ||
    trimmed.includes("](") ||
    trimmed.includes("][")
  ) {
    return false;
  }
  if (isCitationLike(trimmed)) return false;
  if (!hasMathSignal(trimmed)) return false;
  if (isStructuralTexOnly(trimmed)) return false;
  return true;
}

function proseWordCount(text: string): number {
  const stripped = text
    .replace(/\\[a-zA-Z]+\*?(\{[^{}]*\})*/g, " ")
    .replace(/[{}()\\_^$&=+\-*/.,;:<>[\]]/g, " ");
  return stripped.split(/\s+/).filter((word) => /^[A-Za-z]{4,}$/.test(word))
    .length;
}

function isStandaloneMathLine(line: string): boolean {
  const text = line.trim();
  if (!isSafeMathFragment(text)) return false;
  if (
    /^(?:#{1,6}\s|>\s|[-*+]\s|\d+\.\s|\|)/.test(text) ||
    text.startsWith("[") ||
    text.startsWith("!") ||
    text.startsWith("$$") ||
    text.startsWith("\\[") ||
    text.startsWith("\\(")
  ) {
    return false;
  }
  return proseWordCount(text) < 3;
}

function toDisplayMath(inner: string, trailing = ""): string {
  const body = inner.trim();
  const punct = trailing.trim();
  return punct ? `$$\n${body}\n$$${punct}` : `$$\n${body}\n$$`;
}

function transformMathLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (/^[ \t]*\[[ \t]*$/.test(lines[index])) {
      const body: string[] = [];
      let cursor = index + 1;
      while (
        cursor < lines.length &&
        body.length <= 12 &&
        !MULTILINE_BRACKET_CLOSE_RE.test(lines[cursor])
      ) {
        body.push(lines[cursor]);
        cursor += 1;
      }
      if (
        cursor < lines.length &&
        body.length > 0 &&
        MULTILINE_BRACKET_CLOSE_RE.test(lines[cursor])
      ) {
        const inner = body.join("\n").trim();
        const close = lines[cursor].match(MULTILINE_BRACKET_CLOSE_RE);
        const trailing = close?.[0].replace(/[\]\s]/g, "") ?? "";
        if (isSafeMathFragment(inner) && proseWordCount(inner) < 3) {
          out.push(toDisplayMath(inner, trailing));
          index = cursor + 1;
          continue;
        }
      }
    }

    const bracket = lines[index].match(BRACKET_LINE_RE);
    if (
      bracket &&
      isSafeMathFragment(bracket[2]) &&
      proseWordCount(bracket[2]) < 3
    ) {
      out.push(toDisplayMath(bracket[2], bracket[3]));
      index += 1;
      continue;
    }

    if (isStandaloneMathLine(lines[index])) {
      out.push(toDisplayMath(lines[index]));
      index += 1;
      continue;
    }

    out.push(lines[index]);
    index += 1;
  }

  return out.join("\n");
}

function convertInlineMathCode(text: string): string {
  return text.replace(INLINE_CODE_RE, (full, _ticks: string, code: string) => {
    const inner = code.trim();
    if (!inner || inner.includes("\n")) return full;
    if (proseWordCount(inner) >= 3) return full;
    if (!isSafeMathFragment(inner)) return full;
    return `$${inner}$`;
  });
}

function protectMath(source: string): {
  text: string;
  restore: (value: string) => string;
} {
  const stash: string[] = [];
  const text = source.replace(MATH_RE, (match) => {
    stash.push(match);
    return `${MATH_PLACEHOLDER}${stash.length - 1}\u0000`;
  });
  return {
    text,
    restore: (value) =>
      value.replace(
        new RegExp(`${MATH_PLACEHOLDER}(\\d+)\u0000`, "g"),
        (_match, index: string) => stash[Number(index)] ?? "",
      ),
  };
}

function normalizeChunk(chunk: string): string {
  const withInline = convertInlineMathCode(chunk);
  const protectedMath = protectMath(withInline);
  return protectedMath.restore(transformMathLines(protectedMath.text));
}

/**
 * Rewrite common model math mistakes into remark-math delimiters.
 * Fenced code, existing `$` / `$$` / `\(\)` / `\[\]` math, citations, and prose stay put.
 */
export function normalizeChatMath(markdown: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const match of markdown.matchAll(FENCE_RE)) {
    const index = match.index ?? 0;
    parts.push(normalizeChunk(markdown.slice(last, index)));
    parts.push(match[0]);
    last = index + match[0].length;
  }
  parts.push(normalizeChunk(markdown.slice(last)));
  return parts.join("");
}

export function unwrapMathDelimiters(code: string): string {
  const trimmed = code.trim();
  if (
    trimmed.startsWith("$$") &&
    trimmed.endsWith("$$") &&
    trimmed.length >= 4
  ) {
    return trimmed.slice(2, -2).trim();
  }
  if (
    trimmed.startsWith("\\[") &&
    trimmed.endsWith("\\]") &&
    trimmed.length >= 4
  ) {
    return trimmed.slice(2, -2).trim();
  }
  if (
    trimmed.startsWith("\\(") &&
    trimmed.endsWith("\\)") &&
    trimmed.length >= 4
  ) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith("$") && trimmed.endsWith("$") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

const DOCUMENT_TEX_RE =
  /\\(?:documentclass|usepackage|begin\{document\}|section\*?|chapter\*?|maketitle)\b/;

export function canPreviewLatexBlock(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  if (trimmed.split("\n").length > 40) return false;
  if (DOCUMENT_TEX_RE.test(trimmed)) return false;
  return true;
}
