const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const MATH_RE =
  /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g;
const INLINE_CODE_RE = /(`+)([^`\n]+)\1/g;
const BRACKET_LINE_RE = /^([ \t]*)\[([^\]\n]+)\]([ \t]*[.,;:]?)[ \t]*$/;
const MULTILINE_BRACKET_CLOSE_RE = /^[ \t]*\][ \t]*[.,;:]?[ \t]*$/;
const MATH_PLACEHOLDER = "\u0000MATH";

// `_` is a word character, so `\b` does not fire between `\min` and `\min_w`.
const CMD_BOUNDARY = String.raw`(?=[\s{_\d]|$)`;

const MATH_COMMAND_RE = new RegExp(
  String.raw`\\(?:frac|dfrac|tfrac|sum|prod|int|min|max|lim|arg|operatorname|text|mathrm|mathbf|mathit|mathcal|mathbb|left|right|leftarrow|rightarrow|Leftarrow|Rightarrow|leftrightarrow|longleftarrow|longrightarrow|to|gets|mapsto|in|notin|subset|supset|subseteq|supseteq|leq|geq|neq|approx|equiv|sim|propto|times|cdot|odot|infty|partial|nabla|log|ln|exp|sin|cos|tan|alpha|beta|gamma|delta|epsilon|varepsilon|theta|lambda|mu|sigma|omega|phi|psi|pi|Delta|Gamma|Lambda|Omega|Sigma|Theta|Phi|Psi|tilde|hat|bar|vec|dot|sqrt|binom|quad|qquad|ldots|cdots|forall|exists|pm|mp|mid|ell|hbar|displaystyle|textstyle)${CMD_BOUNDARY}`,
);

const STRUCTURAL_COMMAND_RE = new RegExp(
  String.raw`\\(?:cite[a-z]*|parencite|textcite|autocite|ref|eqref|label|bibliography|bibitem|include|input|usepackage|documentclass|section|subsection|subsubsection|chapter|paragraph|item|textbf|textit|emph|url|href|footnote|caption|centering|maketitle|newcommand|renewcommand|begin|end)${CMD_BOUNDARY}`,
);

const MATH_ENV_NAME = String.raw`align\*?|equation\*?|gather\*?|multline\*?|eqnarray\*?|cases`;
const MATH_ENV_RE = new RegExp(
  String.raw`\\begin\{(${MATH_ENV_NAME})\}[\s\S]*?\\end\{\1\}`,
  "g",
);
const MATH_ENV_OPEN_RE = new RegExp(String.raw`\\begin\{(${MATH_ENV_NAME})\}`);
const ENV_PLACEHOLDER = "\u0000ENV";

function hasMathSignal(text: string): boolean {
  if (MATH_COMMAND_RE.test(text)) return true;
  if (/\\[a-zA-Z]+/.test(text) && /[_^]/.test(text)) return true;
  // `_{` / `^` are TeX scripts. A bare identifier underscore (`error_code`) is not.
  if (/\^[{(]|_\{/.test(text)) return true;
  if (/\^/.test(text) && /[=<>≤≥≠]/.test(text)) return true;
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

function isProse(text: string): boolean {
  const stripped = text
    .replace(/\\[a-zA-Z]+\*?(?:\{[^{}]*\})*/g, " ")
    .replace(/[{}()\\_^$&=+\-*/.,;:<>[\]|]/g, " ");
  const withoutLatin = stripped.replace(/\p{Script=Latin}+/gu, "");
  if (/\p{L}/u.test(withoutLatin)) return true;
  return /[A-Za-z]{3,}/.test(stripped);
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
  return !isProse(text);
}

function toDisplayMath(inner: string, trailing = ""): string {
  const body = inner.trim();
  const punct = trailing.trim();
  return punct ? `$$\n${body}\n$$${punct}` : `$$\n${body}\n$$`;
}

const TEX_DISPLAY_RE = /\\\[([\s\S]+?)\\\]/g;
const TEX_INLINE_RE = /\\\(([\s\S]+?)\\\)/g;
// Markdown links are `[label](url)` / `[label][id]`. Images start with `!`.
const BARE_BRACKET_RE = /(?<![\\!])\[([^\]\n]+)\](?!\s*[[(:])/g;
const BARE_PAREN_RE = /(?<!\\)\(([^)\n]+)\)/g;

function replaceOutsideInlineCode(
  text: string,
  replacer: (chunk: string) => string,
): string {
  return text
    .split(/(`+[^`\n]*`+)/g)
    .map((chunk, index) => (index % 2 === 1 ? chunk : replacer(chunk)))
    .join("");
}

function displayMathAt(text: string, offset: number, inner: string): string {
  const block = toDisplayMath(inner);
  const lineStart = offset === 0 || text[offset - 1] === "\n";
  return lineStart ? block : `\n\n${block}`;
}

/** remark-math only tokenizes `$` / `$$`. `\[` `\]` survive as escaped brackets. */
function rewriteExplicitTex(text: string): string {
  return text
    .replace(TEX_DISPLAY_RE, (full, inner: string, offset: number) => {
      if (!isSafeMathFragment(inner)) return full;
      return displayMathAt(text, offset, inner);
    })
    .replace(TEX_INLINE_RE, (full, inner: string) => {
      if (!isSafeMathFragment(inner)) return full;
      return `$${inner.trim()}$`;
    });
}

function rewriteBareTex(text: string): string {
  const hidden = protectMath(text);
  const brackets = hidden.text.replace(
    BARE_BRACKET_RE,
    (full, inner: string, offset: number) => {
      if (!isSafeMathFragment(inner) || isProse(inner)) return full;
      return displayMathAt(hidden.text, offset, inner);
    },
  );
  return hidden.restore(
    brackets.replace(BARE_PAREN_RE, (full, inner: string) => {
      if (!isSafeMathFragment(inner) || isProse(inner)) return full;
      return `$${inner.trim()}$`;
    }),
  );
}

function transformMathLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const envOpen = lines[index].match(MATH_ENV_OPEN_RE);
    if (envOpen) {
      const endRe = new RegExp(String.raw`\\end\{${envOpen[1]}\}`);
      if (!endRe.test(lines[index])) {
        const block = [lines[index]];
        let cursor = index + 1;
        while (cursor < lines.length && !endRe.test(lines[cursor])) {
          block.push(lines[cursor]);
          cursor += 1;
        }
        if (cursor < lines.length) block.push(lines[cursor]);
        out.push(block.join("\n"));
        index = cursor < lines.length ? cursor + 1 : lines.length;
        continue;
      }
    }

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
        if (isSafeMathFragment(inner) && !isProse(inner)) {
          out.push(toDisplayMath(inner, trailing));
          index = cursor + 1;
          continue;
        }
      }
    }

    const bracket = lines[index].match(BRACKET_LINE_RE);
    if (bracket && isSafeMathFragment(bracket[2]) && !isProse(bracket[2])) {
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
    if (isProse(inner) || !isSafeMathFragment(inner)) return full;
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

function protectMathEnvironments(source: string): {
  text: string;
  restore: (value: string) => string;
} {
  const stash: string[] = [];
  const text = source.replace(MATH_ENV_RE, (match) => {
    stash.push(match);
    return `${ENV_PLACEHOLDER}${stash.length - 1}\u0000`;
  });
  return {
    text,
    restore: (value) =>
      value.replace(
        new RegExp(`${ENV_PLACEHOLDER}(\\d+)\u0000`, "g"),
        (_match, index: string) => {
          const block = stash[Number(index)] ?? "";
          if (!block || isProse(block) || block.includes("$$")) return block;
          return `$$\n${block.trim()}\n$$`;
        },
      ),
  };
}

function normalizeChunk(chunk: string): string {
  const withInline = convertInlineMathCode(chunk);
  const rewritten = replaceOutsideInlineCode(withInline, (part) =>
    rewriteBareTex(rewriteExplicitTex(part)),
  );
  const protectedMath = protectMath(rewritten);
  const protectedEnv = protectMathEnvironments(protectedMath.text);
  return protectedMath.restore(
    protectedEnv.restore(transformMathLines(protectedEnv.text)),
  );
}

function lineStartOffset(lines: string[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i++) offset += lines[i].length + 1;
  return offset;
}

/** Leave an unclosed fence or `$$` tail untouched so streaming text is not rewritten. */
function splitStreamingTail(source: string): {
  stable: string;
  pending: string;
} {
  const lines = source.split("\n");
  let fence: { char: string; len: number } | null = null;
  let fenceLine = -1;
  let displayCount = 0;
  let displayAt = -1;

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (fence) {
      const close = /^(?:[ \t]{0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        fence = null;
        fenceLine = -1;
      }
      continue;
    }

    const open = /^(?:[ \t]{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      fenceLine = n;
      continue;
    }

    let i = 0;
    let ticks = 0;
    while (i < line.length) {
      if (line[i] === "`") {
        let run = 0;
        while (line[i] === "`") {
          run += 1;
          i += 1;
        }
        if (ticks === 0) ticks = run;
        else if (run === ticks) ticks = 0;
        continue;
      }
      if (ticks > 0) {
        i += 1;
        continue;
      }
      if (line[i] === "\\") {
        i += 2;
        continue;
      }
      if (line.startsWith("$$", i)) {
        displayCount += 1;
        displayAt = lineStartOffset(lines, n) + i;
        i += 2;
        continue;
      }
      i += 1;
    }
  }

  if (fence && fenceLine >= 0) {
    const at = lineStartOffset(lines, fenceLine);
    return { stable: source.slice(0, at), pending: source.slice(at) };
  }
  if (displayCount % 2 === 1 && displayAt >= 0) {
    return {
      stable: source.slice(0, displayAt),
      pending: source.slice(displayAt),
    };
  }
  return { stable: source, pending: "" };
}

/**
 * Rewrite common model math mistakes into remark-math delimiters.
 * Fenced code, existing `$` / `$$`, citations, links, and prose stay put.
 * `\[...\]` / `\(...\)` become `$$` / `$` because remark-math does not read them.
 */
function normalizeClosed(markdown: string): string {
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

export function normalizeChatMath(markdown: string): string {
  const { stable, pending } = splitStreamingTail(markdown);
  if (!stable) return markdown;
  return normalizeClosed(stable) + pending;
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
