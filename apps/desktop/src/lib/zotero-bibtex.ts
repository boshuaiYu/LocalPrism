/** Bibliographic fields kept in Zotero → .bib exports. */
const KEEP_BIB_FIELDS = new Set([
  "author",
  "title",
  "journal",
  "journaltitle",
  "booktitle",
  "year",
  "date",
  "volume",
  "number",
  "issue",
  "pages",
  "doi",
  "url",
  "publisher",
  "editor",
  "isbn",
  "issn",
  "month",
  "series",
  "edition",
  "address",
  "location",
  "organization",
  "school",
  "institution",
  "type",
  "chapter",
  "howpublished",
  "eprint",
  "eprinttype",
  "archiveprefix",
  "primaryclass",
  "pmid",
  "pmcid",
]);

const PASSTHROUGH_ENTRY_TYPES = new Set(["comment", "preamble", "string"]);

function isIdentChar(char: string): boolean {
  return /[A-Za-z0-9_:\-.+/]/.test(char);
}

function skipWhitespaceAndComments(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      index += 1;
      continue;
    }
    if (char === "%") {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    break;
  }
  return index;
}

function readBraced(
  source: string,
  start: number,
): { text: string; end: number } | null {
  if (source[start] !== "{") return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { text: source.slice(start, index + 1), end: index + 1 };
      }
    }
  }
  return null;
}

function readQuoted(
  source: string,
  start: number,
): { text: string; end: number } | null {
  if (source[start] !== '"') return null;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"') {
      return { text: source.slice(start, index + 1), end: index + 1 };
    }
  }
  return null;
}

function readBareValue(
  source: string,
  start: number,
): { text: string; end: number } {
  let index = start;
  while (index < source.length && isIdentChar(source[index] ?? "")) {
    index += 1;
  }
  return { text: source.slice(start, index), end: index };
}

function readFieldValue(
  source: string,
  start: number,
): { text: string; end: number } | null {
  const pieces: string[] = [];
  let index = start;
  let sawValue = false;

  while (index < source.length) {
    index = skipWhitespaceAndComments(source, index);
    const char = source[index];
    if (!char) break;

    if (char === "{") {
      const braced = readBraced(source, index);
      if (!braced) return null;
      pieces.push(braced.text);
      index = braced.end;
      sawValue = true;
    } else if (char === '"') {
      const quoted = readQuoted(source, index);
      if (!quoted) return null;
      pieces.push(quoted.text);
      index = quoted.end;
      sawValue = true;
    } else if (isIdentChar(char)) {
      const bare = readBareValue(source, index);
      if (!bare.text) break;
      pieces.push(bare.text);
      index = bare.end;
      sawValue = true;
    } else {
      break;
    }

    const afterValue = skipWhitespaceAndComments(source, index);
    if (source[afterValue] === "#") {
      pieces.push("#");
      index = afterValue + 1;
      continue;
    }
    return { text: pieces.join(" # "), end: afterValue };
  }

  return sawValue ? { text: pieces.join(" # "), end: index } : null;
}

function matchingCloser(opener: string): string {
  return opener === "(" ? ")" : "}";
}

function sliceRawEntry(
  source: string,
  start: number,
  openerIndex: number,
): string | null {
  const opener = source[openerIndex];
  if (opener !== "{" && opener !== "(") return null;
  const closer = matchingCloser(opener);
  let depth = 0;
  for (let index = openerIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === opener || char === "{") depth += 1;
    else if (char === closer || (opener === "(" && char === "}")) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function sanitizeStandardEntry(
  source: string,
  start: number,
  type: string,
  openerIndex: number,
): { entry: string; end: number } | null {
  const opener = source[openerIndex] ?? "{";
  const closer = matchingCloser(opener);
  let index = skipWhitespaceAndComments(source, openerIndex + 1);
  const keyStart = index;
  while (
    index < source.length &&
    source[index] !== "," &&
    source[index] !== closer
  ) {
    if (source[index] === "\n") break;
    index += 1;
  }
  const citekey = source.slice(keyStart, index).trim();
  if (!citekey) return null;

  index = skipWhitespaceAndComments(source, index);
  if (source[index] === ",") index += 1;

  const kept: Array<{ name: string; value: string }> = [];
  while (index < source.length) {
    index = skipWhitespaceAndComments(source, index);
    const char = source[index];
    if (!char || char === closer) {
      const end = char === closer ? index + 1 : index;
      if (kept.length === 0) {
        return {
          entry: `@${type}{${citekey},\n}`,
          end,
        };
      }
      const fields = kept
        .map((field) => `  ${field.name} = ${field.value}`)
        .join(",\n");
      return {
        entry: `@${type}{${citekey},\n${fields}\n}`,
        end,
      };
    }

    const nameMatch = source
      .slice(index)
      .match(/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*/);
    if (!nameMatch) {
      const raw = sliceRawEntry(source, start, openerIndex);
      return raw ? { entry: raw.trim(), end: start + raw.length } : null;
    }
    const fieldName = nameMatch[1] ?? "";
    index += nameMatch[0].length;
    const value = readFieldValue(source, index);
    if (!value) {
      const raw = sliceRawEntry(source, start, openerIndex);
      return raw ? { entry: raw.trim(), end: start + raw.length } : null;
    }
    index = skipWhitespaceAndComments(source, value.end);
    if (source[index] === ",") index += 1;

    if (KEEP_BIB_FIELDS.has(fieldName.toLowerCase())) {
      kept.push({ name: fieldName, value: value.text });
    }
  }
  return null;
}

/**
 * Strip Zotero extra metadata (abstract/note/file/…) from one or more BibTeX entries.
 * Unknown or unparsable entries are left unchanged so imports never drop records.
 */
export function sanitizeBibtex(bibtex: string): string {
  const input = bibtex.trim();
  if (!input) return "";

  const pieces: string[] = [];
  let index = 0;
  while (index < input.length) {
    const start = input.indexOf("@", index);
    if (start === -1) break;

    const header = input.slice(start).match(/^@([A-Za-z]+)\s*([{(])/);
    if (!header || header.index !== 0) {
      index = start + 1;
      continue;
    }

    const type = header[1] ?? "misc";
    const openerIndex = start + (header[0]?.length ?? 1) - 1;
    const raw = sliceRawEntry(input, start, openerIndex);
    if (!raw) {
      index = start + 1;
      continue;
    }
    const end = start + raw.length;

    if (PASSTHROUGH_ENTRY_TYPES.has(type.toLowerCase())) {
      pieces.push(raw.trim());
      index = end;
      continue;
    }

    const sanitized = sanitizeStandardEntry(input, start, type, openerIndex);
    pieces.push((sanitized?.entry ?? raw).trim());
    index = sanitized?.end ?? end;
  }

  return pieces.join("\n\n");
}
