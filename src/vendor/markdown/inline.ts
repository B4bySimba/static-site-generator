/**
 * Phase 2: the inline parser.
 *
 * An asterisk is not a reliable open/close marker. These are all legal and all
 * mean different things (the examples use \u002a to keep this comment intact):
 *
 *     *foo bar*        emphasis
 *     a * b * c        literal asterisks
 *     foo*bar*baz      intraword emphasis, allowed with *
 *     foo_bar_baz      NOT emphasis, which is what saves snake_case
 *
 * CommonMark settles it with delimiter runs and flanking rules. A run may open
 * if it is left-flanking (no whitespace after, and either no punctuation after
 * or whitespace/punctuation before) and may close if it is right-flanking, the
 * mirror image. Underscore has an extra restriction that keeps identifiers whole.
 *
 * So this runs in two passes: scan text into a flat node list while pushing every
 * delimiter run onto a stack, then walk the stack pairing closers with openers
 * and rewrite the list into a tree.
 */

import type { InlineNode, Link, LinkReference } from "./ast.js";
import { decodeEntities } from "./entities.js";

interface Delimiter {
  char: "*" | "_" | "~";
  /** Index of the placeholder text node holding the run. */
  index: number;
  length: number;
  canOpen: boolean;
  canClose: boolean;
  active: boolean;
}

interface Context {
  definitions: Map<string, LinkReference>;
}

const ESCAPABLE = `!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`;
const PUNCTUATION = /[!-/:-@[-`{-~¡-¿‐-‧]/;

const isWhitespace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);
const isPunctuation = (ch: string | undefined): boolean => ch !== undefined && PUNCTUATION.test(ch);

export function parseInlines(
  text: string,
  context: { definitions: Map<string, LinkReference> },
): InlineNode[] {
  const parser = new InlineParser(text, { definitions: context.definitions });
  return parser.parse();
}

class InlineParser {
  private pos = 0;
  private nodes: InlineNode[] = [];
  private delimiters: Delimiter[] = [];
  /**
   * Indices of text nodes that are delimiter-run placeholders. Ordinary text must never be
   * merged into one of these: the placeholder's content IS the run, and emphasis processing
   * later trims characters off it by length. (Merging them was a real bug - `*foo*` produced
   * `*fo<em></em>` because the opener node had swallowed the word.)
   */
  private delimiterNodes = new Set<number>();

  constructor(
    private readonly text: string,
    private readonly context: Context,
  ) {}

  parse(): InlineNode[] {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos] as string;

      switch (ch) {
        case "\\":
          this.handleBackslash();
          break;
        case "`":
          this.handleCodeSpan();
          break;
        case "*":
        case "_":
        case "~":
          this.handleDelimiterRun(ch as "*" | "_" | "~");
          break;
        case "[":
          this.handleLinkOpen();
          break;
        case "!":
          this.handleImage();
          break;
        case "<":
          this.handleAutolinkOrHtml();
          break;
        case "&":
          this.handleEntity();
          break;
        case "\n":
          this.handleLineBreak();
          break;
        default:
          this.pushText(ch);
          this.pos++;
      }
    }

    this.processEmphasis(0);
    return mergeAdjacentText(this.nodes);
  }

  private pushText(value: string): void {
    const lastIndex = this.nodes.length - 1;
    const last = this.nodes[lastIndex];
    if (last && last.type === "text" && !this.delimiterNodes.has(lastIndex)) {
      last.value += value;
      return;
    }
    this.nodes.push({ type: "text", value });
  }

  /** A backslash escapes ASCII punctuation; before a newline it is a hard break. */
  private handleBackslash(): void {
    const next = this.text[this.pos + 1];
    if (next === "\n") {
      this.nodes.push({ type: "lineBreak", hard: true });
      this.pos += 2;
      return;
    }
    if (next !== undefined && ESCAPABLE.includes(next)) {
      this.pushText(next);
      this.pos += 2;
      return;
    }
    this.pushText("\\");
    this.pos++;
  }

  /**
   * A code span is delimited by equal-length backtick runs. Content is taken literally, which
   * is why `` `*not emphasis*` `` works - the scanner never enters it.
   */
  private handleCodeSpan(): void {
    const start = this.pos;
    let openLen = 0;
    while (this.text[this.pos] === "`") {
      openLen++;
      this.pos++;
    }

    const contentStart = this.pos;
    while (this.pos < this.text.length) {
      if (this.text[this.pos] === "`") {
        let closeLen = 0;
        const closeStart = this.pos;
        while (this.text[this.pos] === "`") {
          closeLen++;
          this.pos++;
        }
        if (closeLen === openLen) {
          let value = this.text.slice(contentStart, closeStart);
          // Strip one leading and trailing space when both are present (CommonMark §6.1),
          // so `` ` `` can contain a literal backtick.
          if (value.length > 2 && value.startsWith(" ") && value.endsWith(" ") && value.trim() !== "") {
            value = value.slice(1, -1);
          }
          this.nodes.push({ type: "codeSpan", value: value.replace(/\n/g, " ") });
          return;
        }
        continue;
      }
      this.pos++;
    }

    // No matching closer: the backticks are literal text.
    this.pos = start + openLen;
    this.pushText("`".repeat(openLen));
  }

  /** Scan a run of *, _ or ~ and record whether it can open and/or close. */
  private handleDelimiterRun(char: "*" | "_" | "~"): void {
    const start = this.pos;
    while (this.text[this.pos] === char) this.pos++;
    const length = this.pos - start;

    const before = start > 0 ? this.text[start - 1] : undefined;
    const after = this.text[this.pos];

    const leftFlanking =
      !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
    const rightFlanking =
      !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));

    let canOpen: boolean;
    let canClose: boolean;
    if (char === "_") {
      // The intraword rule: this is what keeps snake_case identifiers from becoming emphasis.
      canOpen = leftFlanking && (!rightFlanking || isPunctuation(before));
      canClose = rightFlanking && (!leftFlanking || isPunctuation(after));
    } else if (char === "~") {
      // GFM strikethrough uses exactly two tildes.
      canOpen = leftFlanking && length === 2;
      canClose = rightFlanking && length === 2;
    } else {
      canOpen = leftFlanking;
      canClose = rightFlanking;
    }

    this.nodes.push({ type: "text", value: char.repeat(length) });
    this.delimiterNodes.add(this.nodes.length - 1);
    this.delimiters.push({
      char,
      index: this.nodes.length - 1,
      length,
      canOpen,
      canClose,
      active: true,
    });
  }

  private handleLinkOpen(): void {
    this.nodes.push({ type: "text", value: "[" });
    // Reuse the delimiter stack as a bracket stack: index marks the "[" placeholder.
    this.delimiters.push({
      char: "*", // unused for brackets; the marker is the "[" text node
      index: this.nodes.length - 1,
      length: -1, // sentinel: this is a bracket, not an emphasis run
      canOpen: true,
      canClose: false,
      active: true,
    });
    this.pos++;
    this.tryCloseLinkLater();
  }

  /**
   * Links are resolved by scanning forward from "[" for the matching "]" and then either an
   * inline destination `(url "title")` or a reference `[label]`.
   */
  private tryCloseLinkLater(): void {
    const openIndex = this.nodes.length - 1;
    const openPos = this.pos;
    let depth = 1;
    let i = this.pos;

    while (i < this.text.length) {
      const ch = this.text[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        // Skip code spans so a "]" inside one doesn't close the link.
        let run = 0;
        while (this.text[i] === "`") {
          run++;
          i++;
        }
        const closer = "`".repeat(run);
        const next = this.text.indexOf(closer, i);
        i = next === -1 ? this.text.length : next + run;
        continue;
      }
      if (ch === "[") depth++;
      if (ch === "]") {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }

    if (i >= this.text.length) return; // unmatched "["; the "[" stays literal text

    const labelText = this.text.slice(openPos, i);
    let after = i + 1;
    let url: string | undefined;
    let title: string | undefined;

    if (this.text[after] === "(") {
      const parsed = parseInlineDestination(this.text, after);
      if (parsed) {
        url = parsed.url;
        title = parsed.title;
        after = parsed.end;
      }
    }

    if (url === undefined) {
      // Reference link: [text][label], [text][] or shortcut [text].
      let label = labelText;
      if (this.text[after] === "[") {
        const close = this.text.indexOf("]", after + 1);
        if (close !== -1) {
          const explicit = this.text.slice(after + 1, close).trim();
          if (explicit !== "") label = explicit;
          after = close + 1;
        }
      }
      const def = this.context.definitions.get(label.trim().toLowerCase());
      if (!def) return; // not a link at all; leave the brackets as text
      url = def.url;
      title = def.title;
    }

    // Parse the label's own inlines (links can contain emphasis, code, etc).
    const children = parseInlines(labelText, this.context);

    // Replace the "[" placeholder with the finished link node and drop it from the stack.
    this.nodes.length = openIndex;
    this.delimiters = this.delimiters.filter((d) => d.index < openIndex);
    const link: Link = { type: "link", url, title, children };
    this.nodes.push(link);
    this.pos = after;
  }

  private handleImage(): void {
    if (this.text[this.pos + 1] !== "[") {
      this.pushText("!");
      this.pos++;
      return;
    }

    const close = findMatchingBracket(this.text, this.pos + 1);
    if (close === -1) {
      this.pushText("!");
      this.pos++;
      return;
    }

    const alt = this.text.slice(this.pos + 2, close);
    let after = close + 1;
    let url: string | undefined;
    let title: string | undefined;

    if (this.text[after] === "(") {
      const parsed = parseInlineDestination(this.text, after);
      if (parsed) {
        url = parsed.url;
        title = parsed.title;
        after = parsed.end;
      }
    }
    if (url === undefined) {
      let label = alt;
      if (this.text[after] === "[") {
        const end = this.text.indexOf("]", after + 1);
        if (end !== -1) {
          const explicit = this.text.slice(after + 1, end).trim();
          if (explicit !== "") label = explicit;
          after = end + 1;
        }
      }
      const def = this.context.definitions.get(label.trim().toLowerCase());
      if (!def) {
        this.pushText("!");
        this.pos++;
        return;
      }
      url = def.url;
      title = def.title;
    }

    this.nodes.push({ type: "image", url, title, alt: stripMarkup(alt) });
    this.pos = after;
  }

  private handleAutolinkOrHtml(): void {
    const rest = this.text.slice(this.pos);

    // <https://example.com> and <mailto:…>
    const autolink = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/.exec(rest);
    if (autolink) {
      const url = autolink[1] as string;
      this.nodes.push({ type: "link", url, title: undefined, children: [{ type: "text", value: url }] });
      this.pos += (autolink[0] as string).length;
      return;
    }

    // <user@example.com>
    const email = /^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(rest);
    if (email) {
      const address = email[1] as string;
      this.nodes.push({
        type: "link",
        url: `mailto:${address}`,
        title: undefined,
        children: [{ type: "text", value: address }],
      });
      this.pos += (email[0] as string).length;
      return;
    }

    // Raw inline HTML.
    const tag = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>|^<!--[\s\S]*?-->/.exec(rest);
    if (tag) {
      this.nodes.push({ type: "htmlInline", value: tag[0] as string });
      this.pos += (tag[0] as string).length;
      return;
    }

    this.pushText("<");
    this.pos++;
  }

  private handleEntity(): void {
    const rest = this.text.slice(this.pos);
    const entity = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(rest);
    if (entity) {
      const decoded = decodeEntities(entity[0] as string);
      this.pushText(decoded);
      this.pos += (entity[0] as string).length;
      return;
    }
    this.pushText("&");
    this.pos++;
  }

  /** Two trailing spaces before a newline is a hard break; otherwise it's a soft break. */
  private handleLineBreak(): void {
    const last = this.nodes[this.nodes.length - 1];
    let hard = false;
    if (last && last.type === "text" && /  $/.test(last.value)) {
      last.value = last.value.replace(/ +$/, "");
      hard = true;
    }
    this.nodes.push({ type: "lineBreak", hard });
    this.pos++;
    // Leading whitespace on the next line is not significant.
    while (this.text[this.pos] === " ") this.pos++;
  }

  /**
   * The "process emphasis" algorithm. Walk forward to each potential closer, then scan
   * BACKWARD for the nearest compatible opener, and nest the nodes between them.
   */
  private processEmphasis(stackBottom: number): void {
    const delims = this.delimiters.filter((d) => d.length > 0); // drop bracket sentinels
    let closerIdx = stackBottom;

    while (closerIdx < delims.length) {
      const closer = delims[closerIdx] as Delimiter;
      if (!closer.canClose || !closer.active || closer.length === 0) {
        closerIdx++;
        continue;
      }

      // Find the nearest opener of the same character before this closer.
      let openerIdx = closerIdx - 1;
      let opener: Delimiter | undefined;
      while (openerIdx >= stackBottom) {
        const candidate = delims[openerIdx] as Delimiter;
        if (
          candidate.active &&
          candidate.canOpen &&
          candidate.char === closer.char &&
          candidate.length > 0 &&
          !violatesRuleOfThree(candidate, closer)
        ) {
          opener = candidate;
          break;
        }
        openerIdx--;
      }

      if (!opener) {
        // No opener: this run can never close anything, so stop reconsidering it.
        closer.canClose = false;
        closerIdx++;
        continue;
      }

      // Strikethrough consumes both tildes at once.
      const use = closer.char === "~" ? 2 : Math.min(2, opener.length, closer.length);

      const openerNode = this.nodes[opener.index];
      const closerNode = this.nodes[closer.index];
      if (!openerNode || openerNode.type !== "text" || !closerNode || closerNode.type !== "text") {
        closerIdx++;
        continue;
      }

      // Trim the consumed characters from the placeholder text nodes.
      openerNode.value = openerNode.value.slice(0, openerNode.value.length - use);
      closerNode.value = closerNode.value.slice(use);
      opener.length -= use;
      closer.length -= use;

      // Everything strictly between the two placeholders becomes the wrapped content.
      const inner = this.nodes.slice(opener.index + 1, closer.index);
      const wrapper: InlineNode =
        closer.char === "~"
          ? { type: "strikethrough", children: inner }
          : use === 2
            ? { type: "strong", children: inner }
            : { type: "emphasis", children: inner };

      const removed = closer.index - opener.index - 1;
      this.nodes.splice(opener.index + 1, removed, wrapper);

      // Re-index everything after the splice.
      const shift = removed - 1;
      for (const d of this.delimiters) if (d.index > opener.index) d.index -= shift;

      // Deactivate exhausted runs, and any openers we jumped over.
      for (let k = openerIdx + 1; k < closerIdx; k++) (delims[k] as Delimiter).active = false;
      if (opener.length === 0) opener.active = false;
      if (closer.length === 0) {
        closer.active = false;
        closerIdx++;
      }
    }
  }
}

/**
 * The "rule of 3": when a delimiter run can both open and close, an opener/closer pair whose
 * combined length is a multiple of 3 is rejected - unless both lengths are themselves
 * multiples of 3. It exists to make cases like `*foo**bar**baz*` parse the way people expect.
 */
function violatesRuleOfThree(opener: Delimiter, closer: Delimiter): boolean {
  if (!(opener.canClose || closer.canOpen)) return false;
  const sum = opener.length + closer.length;
  if (sum % 3 !== 0) return false;
  return opener.length % 3 !== 0 || closer.length % 3 !== 0;
}

/** Parse `(url "title")` starting at the "(". */
function parseInlineDestination(
  text: string,
  start: number,
): { url: string; title: string | undefined; end: number } | null {
  let i = start + 1;
  while (i < text.length && /\s/.test(text[i] as string)) i++;

  let url = "";
  if (text[i] === "<") {
    const close = text.indexOf(">", i + 1);
    if (close === -1) return null;
    url = text.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === "\\" && i + 1 < text.length) {
        url += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === "(") depth++;
      if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
      if (/\s/.test(ch)) break;
      url += ch;
      i++;
    }
  }

  while (i < text.length && /\s/.test(text[i] as string)) i++;

  let title: string | undefined;
  const quote = text[i];
  if (quote === '"' || quote === "'" || quote === "(") {
    const closeChar = quote === "(" ? ")" : quote;
    const close = text.indexOf(closeChar, i + 1);
    if (close !== -1) {
      title = text.slice(i + 1, close);
      i = close + 1;
    }
  }

  while (i < text.length && /\s/.test(text[i] as string)) i++;
  if (text[i] !== ")") return null;

  return { url, title, end: i + 1 };
}

/** Index of the "]" matching the "[" at `start`, or -1. */
function findMatchingBracket(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Strip Markdown syntax for contexts that need plain text (image alt attributes). */
function stripMarkup(text: string): string {
  return text.replace(/[*_`~]/g, "");
}

/** Collapse runs of text nodes and drop the empty ones emphasis processing leaves behind. */
function mergeAdjacentText(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.value === "") continue;
      const last = out[out.length - 1];
      if (last && last.type === "text") {
        last.value += node.value;
        continue;
      }
      out.push({ type: "text", value: node.value });
      continue;
    }
    if (node.type === "emphasis" || node.type === "strong" || node.type === "strikethrough") {
      out.push({ ...node, children: mergeAdjacentText(node.children) });
      continue;
    }
    if (node.type === "link") {
      out.push({ ...node, children: mergeAdjacentText(node.children) });
      continue;
    }
    out.push(node);
  }
  return out;
}
