/**
 * Phase 1: the block parser.
 *
 * It walks the document **line by line** and decides what block each line starts or
 * continues. It never looks inside a line's text - that's phase 2's job. Keeping the phases
 * apart is what makes the whole thing tractable:
 *
 *   - block phase: which lines form a paragraph / list item / code fence?
 *   - inline phase: within that text, what is emphasis / a link / a code span?
 *
 * Doing both at once is how regex-based converters end up parsing `*` inside a code block.
 *
 * Container blocks (blockquote, list item) are handled by **stripping their marker and
 * recursing** on the remaining lines. That gives arbitrary nesting for free: a list inside a
 * blockquote inside a list is just three levels of recursion.
 */

import type {
  BlockNode,
  Document,
  LinkReference,
  List,
  ListItem,
  TableAlign,
} from "./ast.js";
import { parseInlines } from "./inline.js";
import { slugify, type SlugCounter } from "./slug.js";

/** Everything the two phases need to share. */
export interface ParseContext {
  definitions: Map<string, LinkReference>;
  slugs: SlugCounter;
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
const BLOCKQUOTE = /^ {0,3}> ?/;
const BULLET_ITEM = /^( {0,3})([-*+])([ \t]+|$)/;
const ORDERED_ITEM = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/;
const LINK_DEF = /^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^>]*)>|(\S+))(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;
const TASK_MARKER = /^\[([ xX])\][ \t]+/;
/** HTML block starts we recognize (a practical subset of CommonMark's 7 conditions). */
const HTML_BLOCK_START = /^ {0,3}<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:[ \t>/]|$)|^ {0,3}<!--|^ {0,3}<\?|^ {0,3}<!/;

export function parseBlocks(source: string, context: ParseContext): Document {
  const lines = normalizeLines(source);
  const children = parseBlockLines(lines, context);
  return { type: "document", children };
}

/** Normalize line endings and expand INDENTATION tabs to 4-column tab stops. */
function normalizeLines(source: string): string[] {
  return source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(expandLeadingTabs);
}

/**
 * Expand tabs only where they act as indentation (CommonMark §2.2).
 *
 * Tabs matter for block structure - "\tfoo" is an indented code block because the tab
 * advances to column 4. But a tab INSIDE content is data and must survive verbatim, or
 * `\tfoo\tbaz` in a code block loses its internal alignment. Expanding every tab in the line
 * was a real conformance failure against the spec's very first example.
 */
function expandLeadingTabs(line: string): string {
  let i = 0;
  let column = 0;
  let prefix = "";
  while (i < line.length) {
    const ch = line[i];
    if (ch === " ") {
      prefix += " ";
      column++;
    } else if (ch === "\t") {
      const width = 4 - (column % 4);
      prefix += " ".repeat(width);
      column += width;
    } else {
      break;
    }
    i++;
  }
  return prefix + line.slice(i);
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

const isBlank = (line: string): boolean => line.trim() === "";

/**
 * The main loop. Each iteration classifies the current line and consumes as many lines as
 * that block needs.
 */
export function parseBlockLines(lines: string[], context: ParseContext): BlockNode[] {
  const blocks: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (isBlank(line)) {
      i++;
      continue;
    }

    // --- link reference definitions: collected, never rendered -------------
    const def = LINK_DEF.exec(line);
    if (def) {
      const label = (def[1] as string).trim().toLowerCase();
      if (!context.definitions.has(label)) {
        context.definitions.set(label, {
          url: def[2] ?? def[3] ?? "",
          title: def[4] ?? def[5] ?? def[6],
        });
      }
      i++;
      continue;
    }

    // --- thematic break (before lists: "***" is a break, not a bullet) ------
    if (THEMATIC_BREAK.test(line)) {
      blocks.push({ type: "thematicBreak" });
      i++;
      continue;
    }

    // --- ATX heading -------------------------------------------------------
    const atx = ATX_HEADING.exec(line);
    if (atx) {
      const level = (atx[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6;
      // Strip an optional closing sequence of hashes. Doing this as a separate step rather
      // than inside the main pattern avoids a backtracking trap: with a lazy content group,
      // "### ###" would let the content expand to swallow the closing hashes.
      const text = (atx[2] ?? "").replace(/(^|[ \t])#+[ \t]*$/, "").trim();
      blocks.push({
        type: "heading",
        level,
        children: parseInlines(text, context),
        slug: slugify(text, context.slugs),
      });
      i++;
      continue;
    }

    // --- fenced code -------------------------------------------------------
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const padding = (fence[1] as string).length;
      const marker = fence[2] as string;
      const info = (fence[3] ?? "").trim();
      const body: string[] = [];
      i++;
      // A closing fence must use the same character and be at least as long.
      const closer = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
      while (i < lines.length && !closer.test(lines[i] as string)) {
        // Strip up to as much indentation as the opening fence had.
        const l = lines[i] as string;
        body.push(l.slice(Math.min(padding, indentOf(l))));
        i++;
      }
      i++; // consume the closing fence (or run off the end, which is legal)
      blocks.push({
        type: "code",
        info,
        lang: info.split(/\s+/)[0] ?? "",
        value: body.join("\n"),
        fenced: true,
      });
      continue;
    }

    // --- indented code (4+ spaces, and not a list continuation) ------------
    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (indentOf(lines[i] as string) >= 4 || isBlank(lines[i] as string))) {
        body.push((lines[i] as string).slice(4));
        i++;
      }
      // Trailing blank lines belong to the document, not the code block.
      while (body.length > 0 && isBlank(body[body.length - 1] as string)) body.pop();
      blocks.push({ type: "code", info: "", lang: "", value: body.join("\n"), fenced: false });
      continue;
    }

    // --- blockquote: strip "> " and RECURSE --------------------------------
    if (BLOCKQUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i] as string;
        if (BLOCKQUOTE.test(l)) {
          inner.push(l.replace(BLOCKQUOTE, ""));
          i++;
        } else if (!isBlank(l) && !startsNewBlock(l)) {
          inner.push(l); // lazy continuation of a paragraph inside the quote
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "blockquote", children: parseBlockLines(inner, context) });
      continue;
    }

    // --- lists -------------------------------------------------------------
    if (BULLET_ITEM.test(line) || ORDERED_ITEM.test(line)) {
      const [list, consumed] = parseList(lines, i, context);
      blocks.push(list);
      i = consumed;
      continue;
    }

    // --- table (a header row followed by a delimiter row) -------------------
    if (i + 1 < lines.length && isTableDelimiter(lines[i + 1] as string) && line.includes("|")) {
      const [table, consumed] = parseTable(lines, i, context);
      if (table) {
        blocks.push(table);
        i = consumed;
        continue;
      }
    }

    // --- HTML block --------------------------------------------------------
    if (HTML_BLOCK_START.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i] as string)) {
        body.push(lines[i] as string);
        i++;
      }
      blocks.push({ type: "htmlBlock", value: body.join("\n") });
      continue;
    }

    // --- paragraph (with setext heading lookahead) --------------------------
    const text: string[] = [];
    while (i < lines.length && !isBlank(lines[i] as string)) {
      const current = lines[i] as string;

      // A setext underline turns the paragraph so far into a heading.
      const setext = SETEXT_UNDERLINE.exec(current);
      if (setext && text.length > 0) {
        const content = text.join("\n").trim();
        blocks.push({
          type: "heading",
          level: (setext[1] as string).startsWith("=") ? 1 : 2,
          children: parseInlines(content, context),
          slug: slugify(content, context.slugs),
        });
        i++;
        text.length = 0;
        break;
      }

      // Any other block start interrupts the paragraph.
      if (text.length > 0 && startsNewBlock(current)) break;

      text.push(current);
      i++;
    }

    if (text.length > 0) {
      blocks.push({ type: "paragraph", children: parseInlines(text.join("\n").trim(), context) });
    }
  }

  return blocks;
}

/** Would this line begin a new block, interrupting an open paragraph? */
function startsNewBlock(line: string): boolean {
  return (
    ATX_HEADING.test(line) ||
    THEMATIC_BREAK.test(line) ||
    FENCE_OPEN.test(line) ||
    BLOCKQUOTE.test(line) ||
    BULLET_ITEM.test(line) ||
    ORDERED_ITEM.test(line)
  );
}

// --- Lists ---------------------------------------------------------------------

/**
 * Lists are the fiddliest block. The rules that matter:
 *  - Items continue while subsequent lines are indented past the item's marker.
 *  - A blank line between items makes the list "loose", which changes rendering
 *    (loose items wrap their content in <p>, tight items do not).
 *  - Changing the bullet character or the ordered delimiter starts a NEW list.
 */
function parseList(lines: string[], start: number, context: ParseContext): [List, number] {
  const first = lines[start] as string;
  const bullet = BULLET_ITEM.exec(first);
  const ordered = !bullet;
  const orderedMatch = ORDERED_ITEM.exec(first);

  const markerChar = ordered ? (orderedMatch?.[3] as string) : (bullet?.[2] as string);
  const startNumber = ordered ? Number(orderedMatch?.[2] ?? 1) : 1;

  const items: ListItem[] = [];
  let loose = false;
  let i = start;
  let sawBlankLine = false;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (isBlank(line)) {
      sawBlankLine = true;
      i++;
      continue;
    }

    const b = BULLET_ITEM.exec(line);
    const o = ORDERED_ITEM.exec(line);
    const isItemStart = ordered ? !!o : !!b;
    const sameMarker = ordered ? o?.[3] === markerChar : b?.[2] === markerChar;

    if (isItemStart && sameMarker) {
      // A blank line before this item makes the whole list loose.
      if (sawBlankLine && items.length > 0) loose = true;
      sawBlankLine = false;

      const match = (ordered ? o : b) as RegExpExecArray;
      const markerWidth = (match[0] as string).length;
      const contentIndent = markerWidth;

      let content = line.slice(markerWidth);
      const itemLines: string[] = [content];
      i++;

      // Continuation lines: indented at least to the content column, or lazy paragraph text.
      while (i < lines.length) {
        const next = lines[i] as string;
        if (isBlank(next)) {
          // Look ahead: a blank followed by an indented line continues this item.
          const after = lines[i + 1];
          if (after !== undefined && indentOf(after) >= contentIndent && !isBlank(after)) {
            itemLines.push("");
            i++;
            continue;
          }
          break;
        }
        if (indentOf(next) >= contentIndent) {
          itemLines.push(next.slice(contentIndent));
          i++;
          continue;
        }
        // Lazy continuation of the item's paragraph.
        if (!startsNewBlock(next)) {
          itemLines.push(next);
          i++;
          continue;
        }
        break;
      }

      // Task list marker, e.g. "- [x] done".
      let checked: boolean | null = null;
      const task = TASK_MARKER.exec(itemLines[0] as string);
      if (task) {
        checked = (task[1] as string).toLowerCase() === "x";
        itemLines[0] = (itemLines[0] as string).slice((task[0] as string).length);
      }

      // A blank line INSIDE an item also makes the list loose.
      if (itemLines.some(isBlank) && itemLines.filter((l) => !isBlank(l)).length > 1) loose = true;

      items.push({ type: "listItem", children: parseBlockLines(itemLines, context), checked });
      continue;
    }

    break;
  }

  return [{ type: "list", ordered, start: startNumber, loose, children: items }, i];
}

// --- Tables ----------------------------------------------------------------------

function isTableDelimiter(line: string): boolean {
  return /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line) && line.includes("-");
}

function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") {
      current += "|"; // an escaped pipe is content, not a separator
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parseTable(
  lines: string[],
  start: number,
  context: ParseContext,
): [BlockNode | null, number] {
  const headerCells = splitTableRow(lines[start] as string);
  const delimiterCells = splitTableRow(lines[start + 1] as string);

  // A table's delimiter row must have exactly as many cells as its header.
  if (headerCells.length !== delimiterCells.length) return [null, start];

  const align: TableAlign[] = delimiterCells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  const rows: (typeof headerCells extends string[] ? never : never)[] = [];
  const bodyRows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && !isBlank(lines[i] as string) && (lines[i] as string).includes("|")) {
    bodyRows.push(splitTableRow(lines[i] as string));
    i++;
  }
  void rows;

  return [
    {
      type: "table",
      align,
      header: headerCells.map((c) => parseInlines(c, context)),
      rows: bodyRows.map((row) =>
        // Pad or truncate to the header width, as GFM requires.
        Array.from({ length: headerCells.length }, (_, idx) =>
          parseInlines(row[idx] ?? "", context),
        ),
      ),
    },
    i,
  ];
}
