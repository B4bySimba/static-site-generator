/**
 * Front matter extraction.
 *
 * A minimal YAML subset - scalars, quoted strings, booleans, numbers, inline `[a, b]` arrays,
 * and block `- item` arrays. Deliberately NOT a YAML parser: full YAML is a famously large
 * spec (anchors, multi-line scalars, custom tags) and pulling `js-yaml` in would violate the
 * zero-dependency rule for a feature that, in practice, is used for `title`, `date`, `tags`,
 * and `draft`. Anything more complex should be JSON front matter, which we also accept.
 */

export interface FrontMatterResult {
  data: Record<string, unknown>;
  /** The document with its front matter block removed. */
  content: string;
}

const DELIMITER = /^---[ \t]*$/;

export function extractFrontMatter(source: string): FrontMatterResult {
  const normalized = source.replace(/^﻿/, ""); // strip a BOM
  const lines = normalized.split(/\r\n?|\n/);

  if (lines.length === 0 || !DELIMITER.test(lines[0] as string)) {
    return { data: {}, content: normalized };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (DELIMITER.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, content: normalized }; // unterminated: treat as content

  const block = lines.slice(1, end);
  const content = lines.slice(end + 1).join("\n").replace(/^\n+/, "");
  return { data: parseYamlSubset(block), content };
}

function parseYamlSubset(lines: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let listBuffer: unknown[] | null = null;

  const flush = (): void => {
    if (currentKey !== null && listBuffer !== null) data[currentKey] = listBuffer;
    listBuffer = null;
  };

  for (const raw of lines) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;

    // Block list item belonging to the previous key.
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && currentKey !== null) {
      listBuffer ??= [];
      listBuffer.push(parseScalar((item[1] as string).trim()));
      continue;
    }

    const pair = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(raw);
    if (!pair) continue;

    flush();
    currentKey = pair[1] as string;
    const value = (pair[2] ?? "").trim();

    if (value === "") {
      // Either an empty value or the header of a block list; decided by what follows.
      data[currentKey] = "";
      continue;
    }
    data[currentKey] = parseScalar(value);
    currentKey = null;
  }
  flush();

  return data;
}

function parseScalar(value: string): unknown {
  if (value === "") return "";

  // Quoted strings keep their contents verbatim.
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }

  // Inline array: [a, b, "c d"]
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTopLevel(inner).map((part) => parseScalar(part.trim()));
  }

  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;

  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);

  // ISO-ish dates are useful enough to convert.
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(:\d{2})?)?/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return value;
}

/** Split on commas that are not inside quotes. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") out.push(current);
  return out;
}
