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
const MATH_ENV_TEST_RE = new RegExp(MATH_ENV_RE.source);
const MATH_ENV_OPEN_RE = new RegExp(String.raw`\\begin\{(${MATH_ENV_NAME})\}`);
const ENV_PLACEHOLDER = "\u0000ENV";
const CODE_PLACEHOLDER = "\u0000CODE";

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

/**
 * `\(...\)` / `\[...\]` are already marked as math. A bare symbol such as
 * `w` or `n_i` is enough. Citations and prose stay text so `\[1\]` and a
 * Chinese aside are not painted as a KaTeX error.
 */
function isExplicitMathInner(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 2000) return false;
  if (
    trimmed.includes("$") ||
    trimmed.includes("](") ||
    trimmed.includes("][")
  ) {
    return false;
  }
  if (isCitationLike(trimmed)) return false;
  if (isSafeMathFragment(trimmed)) return true;
  if (MATH_ENV_TEST_RE.test(trimmed)) return true;
  if (isProse(trimmed) || trimmed.length > 160) return false;
  return /^[0-9A-Za-z\\{}_^(),.+\-=<>|*/\s]+$/.test(trimmed);
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
  const block = `$$\n${body}\n$$`;
  // `$$.` is not a closing fence. Punctuation has to start the next line.
  return punct ? `${block}\n${punct}` : block;
}

/**
 * A line that is only `$$` closes display math. `$$。` does not, and KaTeX
 * then paints the following prose red. Split that suffix off when a fence
 * is already open. An opening `$$ label` line stays intact.
 */
function separateClosingMathFence(text: string): string {
  const lines = text.split("\n");
  let open = false;
  const out: string[] = [];
  for (const line of lines) {
    const exact = /^[ \t]*\$\$[ \t]*$/.test(line);
    if (!open) {
      if (exact) open = true;
      else if (
        /^[ \t]*\$\$\S/.test(line) &&
        line.indexOf("$$", line.indexOf("$$") + 2) < 0
      ) {
        open = true;
      }
      out.push(line);
      continue;
    }
    const stuck = /^([ \t]*\$\$)[ \t]*(\S[\s\S]*)$/.exec(line);
    if (stuck) {
      out.push(stuck[1] ?? "$$");
      out.push(stuck[2] ?? "");
      open = false;
      continue;
    }
    if (exact) open = false;
    out.push(line);
  }
  return out.join("\n");
}

const TEX_DISPLAY_RE = /\\\[([\s\S]+?)\\\]/g;
const TEX_INLINE_RE = /\\\(([\s\S]+?)\\\)/g;
// `\left[` / `\right(` are sized delimiters; `(?<!\\)` only sees the last letter.
const NOT_SIZED_DELIM = String.raw`(?<!\\(?:left|right))`;
// Markdown links are `[label](url)` / `[label][id]`. Images start with `!`.
const BARE_BRACKET_RE = new RegExp(
  `${NOT_SIZED_DELIM}(?<![\\\\!])\\[([^\\]\\n]+)\\](?!\\s*[[(:])`,
  "g",
);
const BARE_PAREN_RE = new RegExp(
  `${NOT_SIZED_DELIM}(?<!\\\\)\\(([^)\\n]+)\\)`,
  "g",
);
const DOLLAR_MATH_RE = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$/g;
const DOLLAR_PLACEHOLDER = "\u0000DOLLAR";

function indexOfBacktickRun(source: string, from: number, run: number): number {
  if (run <= 0) return -1;
  let i = from;
  while (i < source.length) {
    if (source[i] !== "`") {
      i += 1;
      continue;
    }
    let len = 0;
    while (i + len < source.length && source[i + len] === "`") len += 1;
    if (len === run) return i + len;
    i += len;
  }
  return -1;
}

/** Hide complete inline code, including spans that cross lines. */
function maskInlineCode(source: string): {
  text: string;
  restore: (value: string) => string;
} {
  const stash: string[] = [];
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] !== "`") {
      out += source[i];
      i += 1;
      continue;
    }
    let run = 0;
    while (i + run < source.length && source[i + run] === "`") run += 1;
    const end = indexOfBacktickRun(source, i + run, run);
    if (end < 0) {
      out += source.slice(i);
      break;
    }
    stash.push(source.slice(i, end));
    out += `${CODE_PLACEHOLDER}${stash.length - 1}\u0000`;
    i = end;
  }
  return {
    text: out,
    restore: (value) =>
      value.replace(
        new RegExp(`${CODE_PLACEHOLDER}(\\d+)\u0000`, "g"),
        (_match, index: string) => stash[Number(index)] ?? "",
      ),
  };
}

function displayMathAt(
  text: string,
  offset: number,
  inner: string,
  matchLength: number,
): string {
  const block = toDisplayMath(inner);
  const lineStart = offset === 0 || text[offset - 1] === "\n";
  const next = text[offset + matchLength];
  // `$$。` is not a closing fence, so trailing text must start on the next line.
  const suffix = next !== undefined && next !== "\n" ? "\n" : "";
  return `${lineStart ? "" : "\n\n"}${block}${suffix}`;
}

/** remark-math only tokenizes `$` / `$$`. `\[` `\]` survive as escaped brackets. */
function rewriteExplicitTex(text: string): string {
  TEX_DISPLAY_RE.lastIndex = 0;
  TEX_INLINE_RE.lastIndex = 0;
  return text
    .replace(TEX_DISPLAY_RE, (full, inner: string, offset: number) => {
      if (!isExplicitMathInner(inner)) return full;
      return displayMathAt(text, offset, inner, full.length);
    })
    .replace(TEX_INLINE_RE, (full, inner: string) => {
      if (!isExplicitMathInner(inner)) return full;
      return `$${inner.trim()}$`;
    });
}

function protectDollarMath(source: string): {
  text: string;
  restore: (value: string) => string;
} {
  const stash: string[] = [];
  DOLLAR_MATH_RE.lastIndex = 0;
  const text = source.replace(DOLLAR_MATH_RE, (match) => {
    stash.push(match);
    return `${DOLLAR_PLACEHOLDER}${stash.length - 1}\u0000`;
  });
  return {
    text,
    restore: (value) =>
      value.replace(
        new RegExp(`${DOLLAR_PLACEHOLDER}(\\d+)\u0000`, "g"),
        (_match, index: string) => stash[Number(index)] ?? "",
      ),
  };
}

/** `\[` / `\(` inside an existing `$` / `$$` span must stay literal. */
function rewriteExplicitOutsideDollars(text: string): string {
  const hidden = protectDollarMath(text);
  return hidden.restore(rewriteExplicitTex(hidden.text));
}

function lineHasTexOutside(line: string, start: number, end: number): boolean {
  const outside = `${line.slice(0, start)} ${line.slice(end)}`.replace(
    /\([^)\n]*\)/g,
    " ",
  );
  return /\\[a-zA-Z]+/.test(outside);
}

function rewriteBareBrackets(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (isStandaloneMathLine(line)) return line;
      BARE_BRACKET_RE.lastIndex = 0;
      return line.replace(
        BARE_BRACKET_RE,
        (full, inner: string, offset: number) => {
          if (!isSafeMathFragment(inner) || isProse(inner)) return full;
          if (lineHasTexOutside(line, offset, offset + full.length))
            return full;
          return displayMathAt(line, offset, inner, full.length);
        },
      );
    })
    .join("\n");
}

function rewriteBareParens(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (isStandaloneMathLine(line)) return line;
      BARE_PAREN_RE.lastIndex = 0;
      return line.replace(
        BARE_PAREN_RE,
        (full, inner: string, offset: number) => {
          if (!isSafeMathFragment(inner) || isProse(inner)) return full;
          if (lineHasTexOutside(line, offset, offset + full.length))
            return full;
          return `$${inner.trim()}$`;
        },
      );
    })
    .join("\n");
}

function rewriteBareTex(text: string): string {
  const hiddenBrackets = protectDollarMath(text);
  const brackets = rewriteBareBrackets(hiddenBrackets.text);
  const hiddenParens = protectDollarMath(hiddenBrackets.restore(brackets));
  return hiddenParens.restore(rewriteBareParens(hiddenParens.text));
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
    // An equation example is source, not inline math. `$...$` cannot hold
    // `\begin{equation}` and KaTeX would paint the span red.
    if (MATH_ENV_OPEN_RE.test(inner)) return full;
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
  // Wrapping `\begin{equation}` inside a backtick span injects `$$` and
  // splits the span. remark-math then treats the rest of the reply as display
  // math: a later word is centered, the real formula stays raw, and KaTeX
  // paints the prose red.
  const masked = maskInlineCode(withInline);
  const rewritten = rewriteBareTex(rewriteExplicitOutsideDollars(masked.text));
  const protectedMath = protectMath(rewritten);
  const protectedEnv = protectMathEnvironments(protectedMath.text);
  const restoredMath = protectedMath.restore(
    protectedEnv.restore(transformMathLines(protectedEnv.text)),
  );
  // Inline code is still masked, so a backtick example of `$$。` stays source.
  return masked.restore(separateClosingMathFence(restoredMath));
}

function lineStartOffset(lines: string[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i++) offset += lines[i].length + 1;
  return offset;
}

/**
 * Leave an unclosed fence, inline code span, or `$$` tail untouched so
 * streaming text is not rewritten. Inline code can cross lines; `$$` inside
 * it is not a math delimiter.
 */
function splitStreamingTail(source: string): {
  stable: string;
  pending: string;
} {
  const lines = source.split("\n");
  let fence: { char: string; len: number } | null = null;
  let fenceLine = -1;
  let inlineRun = 0;
  let inlineAt = -1;
  let displayCount = 0;
  let displayAt = -1;

  const scanLine = (line: string, base: number, start: number) => {
    let i = start;
    while (i < line.length) {
      if (line[i] === "`") {
        let run = 0;
        while (line[i + run] === "`") run += 1;
        const end = indexOfBacktickRun(line, i + run, run);
        if (end < 0) {
          inlineRun = run;
          inlineAt = base + i;
          return;
        }
        i = end;
        continue;
      }
      if (line[i] === "\\") {
        i += 2;
        continue;
      }
      if (line.startsWith("$$", i)) {
        displayCount += 1;
        displayAt = base + i;
        i += 2;
        continue;
      }
      i += 1;
    }
  };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? "";
    const base = lineStartOffset(lines, n);
    if (fence) {
      const close = /^(?:[ \t]{0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        fence = null;
        fenceLine = -1;
      }
      continue;
    }
    if (inlineRun > 0) {
      const end = indexOfBacktickRun(line, 0, inlineRun);
      if (end < 0) continue;
      inlineRun = 0;
      inlineAt = -1;
      scanLine(line, base, end);
      continue;
    }
    const open = /^(?:[ \t]{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      fenceLine = n;
      continue;
    }
    scanLine(line, base, 0);
  }

  const cuts: number[] = [];
  if (fence && fenceLine >= 0) cuts.push(lineStartOffset(lines, fenceLine));
  if (inlineRun > 0 && inlineAt >= 0) cuts.push(inlineAt);
  if (displayCount % 2 === 1 && displayAt >= 0) cuts.push(displayAt);
  if (cuts.length === 0) return { stable: source, pending: "" };
  const at = Math.min(...cuts);
  return { stable: source.slice(0, at), pending: source.slice(at) };
}

/**
 * Rewrite common model math mistakes into remark-math delimiters.
 * Fenced code, inline code, existing `$` / `$$`, citations, links, and prose
 * stay put. `\[...\]` / `\(...\)` become `$$` / `$` because remark-math does
 * not read them. A bare symbol inside those delimiters is still math.
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
