/**
 * A template engine, written from scratch.
 *
 * Syntax (Jinja/Liquid-flavored):
 *
 *     {{ variable }}                interpolation, HTML-escaped by default
 *     {{ variable | filter }}       filters, chainable, with arguments
 *     {{ variable | safe }}         opt out of escaping
 *     {% if cond %}…{% else %}…{% endif %}
 *     {% for item in list %}…{% endfor %}
 *     {% include "partial.html" %}
 *     {% extends "layout.html" %}   layout inheritance
 *     {% block name %}…{% endblock %}
 *     {# a comment #}
 *
 * ## Why compile to an AST rather than regex-replace
 *
 * The same reason as the Markdown parser: `{% if %}` blocks nest, and a regex has no stack.
 * A template is tokenized, parsed into a tree of nodes, and then *rendered* by walking that
 * tree — so `{% for %}` inside `{% if %}` inside `{% for %}` needs no special handling.
 *
 * ## Auto-escaping is the default
 *
 * `{{ post.title }}` is escaped unless you write `| safe`. Templates render
 * attacker-influenced data constantly (a post title, a comment, a search query), and a
 * template engine that escapes only when asked has the default backwards. Being explicit
 * about *unsafety* is the whole point.
 */

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly templateName: string,
    readonly line?: number,
  ) {
    super(line === undefined ? `${message} (in ${templateName})` : `${message} (in ${templateName}, line ${line})`);
    this.name = "TemplateError";
  }
}

// --- AST ---------------------------------------------------------------------

type Node =
  | { kind: "text"; value: string }
  | { kind: "output"; expression: Expression; line: number }
  | { kind: "if"; branches: Array<{ condition: Expression | null; body: Node[] }>; line: number }
  | { kind: "for"; variable: string; indexVariable: string | null; iterable: Expression; body: Node[]; empty: Node[]; line: number }
  | { kind: "include"; name: string; line: number }
  | { kind: "block"; name: string; body: Node[]; line: number };

interface Expression {
  /** Dotted path, e.g. "post.meta.title". */
  path: string[];
  filters: Array<{ name: string; args: FilterArg[] }>;
  /** A literal, when the expression is a quoted string or a number. */
  literal?: string | number | boolean;
  /** Leading "not". */
  negated: boolean;
  /** A comparison, for `{% if a == b %}`. */
  comparison?: { operator: string; right: Expression };
}

type FilterArg = string | number | boolean;

// --- Tokenizing --------------------------------------------------------------

interface RawToken {
  type: "text" | "output" | "tag" | "comment";
  value: string;
  line: number;
}

function tokenize(source: string, templateName: string): RawToken[] {
  const tokens: RawToken[] = [];
  let pos = 0;
  let line = 1;

  const countLines = (text: string): void => {
    for (const ch of text) if (ch === "\n") line++;
  };

  while (pos < source.length) {
    const nextOutput = source.indexOf("{{", pos);
    const nextTag = source.indexOf("{%", pos);
    const nextComment = source.indexOf("{#", pos);

    const candidates = [nextOutput, nextTag, nextComment].filter((i) => i !== -1);
    if (candidates.length === 0) {
      const text = source.slice(pos);
      if (text) tokens.push({ type: "text", value: text, line });
      break;
    }

    const next = Math.min(...candidates);
    if (next > pos) {
      const text = source.slice(pos, next);
      tokens.push({ type: "text", value: text, line });
      countLines(text);
    }

    const [open, close, type] =
      next === nextOutput ? ["{{", "}}", "output" as const]
      : next === nextTag ? ["{%", "%}", "tag" as const]
      : ["{#", "#}", "comment" as const];

    const end = source.indexOf(close, next + 2);
    if (end === -1) {
      throw new TemplateError(`Unclosed ${open} … ${close}`, templateName, line);
    }

    const startLine = line;
    const inner = source.slice(next + 2, end);
    countLines(inner);
    if (type !== "comment") {
      tokens.push({ type, value: inner.trim(), line: startLine });
    }
    pos = end + 2;
  }

  return tokens;
}

// --- Expression parsing --------------------------------------------------------

function parseExpression(source: string, templateName: string, line: number): Expression {
  let text = source.trim();

  let negated = false;
  if (text.startsWith("not ")) {
    negated = true;
    text = text.slice(4).trim();
  }

  // Split on "|" that is not inside quotes.
  const segments = splitOutsideQuotes(text, "|");
  const head = (segments.shift() ?? "").trim();

  const expression: Expression = { path: [], filters: [], negated };

  // A comparison in the head: a == b, a != b, a > b, …
  const comparisonMatch = /^(.*?)\s*(==|!=|>=|<=|>|<)\s*(.*)$/.exec(head);
  if (comparisonMatch) {
    const left = parseExpression(comparisonMatch[1] as string, templateName, line);
    expression.path = left.path;
    if (left.literal !== undefined) expression.literal = left.literal;
    expression.comparison = {
      operator: comparisonMatch[2] as string,
      right: parseExpression(comparisonMatch[3] as string, templateName, line),
    };
  } else {
    const literal = parseLiteral(head);
    if (literal !== undefined) expression.literal = literal;
    else expression.path = head.split(".").map((p) => p.trim()).filter(Boolean);
  }

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      expression.filters.push({ name: trimmed, args: [] });
      continue;
    }
    const name = trimmed.slice(0, colon).trim();
    const args = splitOutsideQuotes(trimmed.slice(colon + 1), ",")
      .map((a) => parseLiteral(a.trim()))
      .filter((a): a is FilterArg => a !== undefined);
    expression.filters.push({ name, args });
  }

  return expression;
}

function parseLiteral(text: string): string | number | boolean | undefined {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return undefined;
}

function splitOutsideQuotes(text: string, separator: string): string[] {
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
    if (ch === separator) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

// --- Parsing to a tree ----------------------------------------------------------

interface ParsedTemplate {
  nodes: Node[];
  /** Set when the template extends a layout. */
  extends: string | null;
  blocks: Map<string, Node[]>;
}

function parse(source: string, templateName: string): ParsedTemplate {
  const tokens = tokenize(source, templateName);
  let index = 0;
  let extendsName: string | null = null;
  const blocks = new Map<string, Node[]>();

  function parseNodes(stopTags: string[]): { nodes: Node[]; stoppedAt: string | null } {
    const nodes: Node[] = [];

    while (index < tokens.length) {
      const token = tokens[index] as RawToken;

      if (token.type === "text") {
        nodes.push({ kind: "text", value: token.value });
        index++;
        continue;
      }

      if (token.type === "output") {
        nodes.push({ kind: "output", expression: parseExpression(token.value, templateName, token.line), line: token.line });
        index++;
        continue;
      }

      // A tag.
      const parts = token.value.split(/\s+/);
      const keyword = parts[0] as string;

      if (stopTags.includes(keyword)) {
        return { nodes, stoppedAt: keyword };
      }

      index++;

      switch (keyword) {
        case "if": {
          const condition = parseExpression(token.value.slice(2), templateName, token.line);
          const branches: Array<{ condition: Expression | null; body: Node[] }> = [];
          let current = condition;

          for (;;) {
            const result = parseNodes(["elif", "else", "endif"]);
            branches.push({ condition: current, body: result.nodes });

            if (result.stoppedAt === "elif") {
              const elifToken = tokens[index] as RawToken;
              index++;
              current = parseExpression(elifToken.value.slice(4), templateName, elifToken.line);
              continue;
            }
            if (result.stoppedAt === "else") {
              index++;
              const elseBody = parseNodes(["endif"]);
              branches.push({ condition: null, body: elseBody.nodes });
              index++; // endif
              break;
            }
            if (result.stoppedAt === "endif") {
              index++;
              break;
            }
            throw new TemplateError("Unclosed {% if %}", templateName, token.line);
          }

          nodes.push({ kind: "if", branches, line: token.line });
          break;
        }

        case "for": {
          // {% for item in list %} or {% for i, item in list %}
          const match = /^for\s+([\w.]+)(?:\s*,\s*([\w.]+))?\s+in\s+(.+)$/.exec(token.value);
          if (!match) throw new TemplateError(`Malformed {% for %}: ${token.value}`, templateName, token.line);

          const first = match[1] as string;
          const second = match[2];
          const iterable = parseExpression(match[3] as string, templateName, token.line);

          const body = parseNodes(["empty", "endfor"]);
          let emptyBody: Node[] = [];
          if (body.stoppedAt === "empty") {
            index++;
            const result = parseNodes(["endfor"]);
            emptyBody = result.nodes;
          }
          index++; // endfor

          nodes.push({
            kind: "for",
            // With two names the FIRST is the index, matching "for i, item in list".
            variable: second ?? first,
            indexVariable: second ? first : null,
            iterable,
            body: body.nodes,
            empty: emptyBody,
            line: token.line,
          });
          break;
        }

        case "include": {
          const name = parseLiteral(token.value.slice(7).trim());
          if (typeof name !== "string") {
            throw new TemplateError(`{% include %} needs a quoted template name`, templateName, token.line);
          }
          nodes.push({ kind: "include", name, line: token.line });
          break;
        }

        case "extends": {
          const name = parseLiteral(token.value.slice(7).trim());
          if (typeof name !== "string") {
            throw new TemplateError(`{% extends %} needs a quoted template name`, templateName, token.line);
          }
          extendsName = name;
          break;
        }

        case "block": {
          const name = (parts[1] ?? "").trim();
          if (!name) throw new TemplateError("{% block %} needs a name", templateName, token.line);
          const body = parseNodes(["endblock"]);
          index++; // endblock
          blocks.set(name, body.nodes);
          nodes.push({ kind: "block", name, body: body.nodes, line: token.line });
          break;
        }

        default:
          throw new TemplateError(`Unknown tag {% ${keyword} %}`, templateName, token.line);
      }
    }

    return { nodes, stoppedAt: null };
  }

  const { nodes } = parseNodes([]);
  return { nodes, extends: extendsName, blocks };
}

// --- Filters -------------------------------------------------------------------

export type Filter = (value: unknown, ...args: FilterArg[]) => unknown;

/** A value marked safe skips escaping. A branded wrapper, so it can't be forged by accident. */
class SafeString {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const DEFAULT_FILTERS: Record<string, Filter> = {
  safe: (value) => new SafeString(String(value ?? "")),
  escape: (value) => escapeHtml(String(value ?? "")),
  upper: (value) => String(value ?? "").toUpperCase(),
  lower: (value) => String(value ?? "").toLowerCase(),
  capitalize: (value) => {
    const text = String(value ?? "");
    return text.charAt(0).toUpperCase() + text.slice(1);
  },
  trim: (value) => String(value ?? "").trim(),
  length: (value) => (Array.isArray(value) || typeof value === "string" ? value.length : 0),
  reverse: (value) => (Array.isArray(value) ? [...value].reverse() : String(value ?? "").split("").reverse().join("")),
  join: (value, separator = ", ") => (Array.isArray(value) ? value.join(String(separator)) : String(value ?? "")),
  first: (value) => (Array.isArray(value) ? value[0] : String(value ?? "")[0]),
  last: (value) => (Array.isArray(value) ? value[value.length - 1] : String(value ?? "").slice(-1)),
  default: (value, fallback = "") => (value === undefined || value === null || value === "" ? fallback : value),
  truncate: (value, length = 100, suffix = "…") => {
    const text = String(value ?? "");
    return text.length <= Number(length) ? text : text.slice(0, Number(length)).trimEnd() + String(suffix);
  },
  slice: (value, start = 0, end) => {
    const from = Number(start);
    const to = end === undefined ? undefined : Number(end);
    return Array.isArray(value) ? value.slice(from, to) : String(value ?? "").slice(from, to);
  },
  /** Format a date. Accepts a Date, an ISO string, or a timestamp. */
  date: (value, format = "YYYY-MM-DD") => {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return String(value ?? "");
    return formatDate(date, String(format));
  },
  /** Sort an array, optionally by a key. */
  sort: (value, key) => {
    if (!Array.isArray(value)) return value;
    const copy = [...value];
    if (key === undefined) return copy.sort();
    return copy.sort((a, b) => {
      const av = resolvePath(a, String(key).split("."));
      const bv = resolvePath(b, String(key).split("."));
      return av === bv ? 0 : (av as number) < (bv as number) ? -1 : 1;
    });
  },
  /** URL-encode. */
  urlencode: (value) => encodeURIComponent(String(value ?? "")),
  /** Strip HTML tags — for excerpts and meta descriptions. */
  striptags: (value) => String(value ?? "").replace(/<[^>]*>/g, ""),
  json: (value) => new SafeString(JSON.stringify(value)),
};

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDate(date: Date, format: string): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  // Longest tokens first, so YYYY is not eaten by YY.
  return format
    .replace(/YYYY/g, String(date.getUTCFullYear()))
    .replace(/MMMM/g, MONTHS[date.getUTCMonth()] as string)
    .replace(/MMM/g, (MONTHS[date.getUTCMonth()] as string).slice(0, 3))
    .replace(/MM/g, pad(date.getUTCMonth() + 1))
    .replace(/DDDD/g, DAYS[date.getUTCDay()] as string)
    .replace(/DDD/g, (DAYS[date.getUTCDay()] as string).slice(0, 3))
    .replace(/DD/g, pad(date.getUTCDate()))
    .replace(/HH/g, pad(date.getUTCHours()))
    .replace(/mm/g, pad(date.getUTCMinutes()))
    .replace(/ss/g, pad(date.getUTCSeconds()));
}

// --- Rendering --------------------------------------------------------------------

export interface TemplateEngineOptions {
  /** Resolve a template name to its source. */
  loader: (name: string) => string;
  filters?: Record<string, Filter>;
  /** Escape interpolations by default. Strongly recommended. */
  autoescape?: boolean;
}

export class TemplateEngine {
  private readonly cache = new Map<string, ParsedTemplate>();
  private readonly filters: Record<string, Filter>;
  private readonly autoescape: boolean;

  constructor(private readonly options: TemplateEngineOptions) {
    this.filters = { ...DEFAULT_FILTERS, ...options.filters };
    this.autoescape = options.autoescape ?? true;
  }

  /** Drop the compiled-template cache (the dev server calls this on every change). */
  clearCache(): void {
    this.cache.clear();
  }

  private load(name: string): ParsedTemplate {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const source = this.options.loader(name);
    const parsed = parse(source, name);
    this.cache.set(name, parsed);
    return parsed;
  }

  render(name: string, context: Record<string, unknown> = {}): string {
    const template = this.load(name);
    return this.renderTemplate(template, name, context);
  }

  /** Render a source string directly, without the loader. */
  renderString(source: string, context: Record<string, unknown> = {}, name = "<string>"): string {
    return this.renderTemplate(parse(source, name), name, context);
  }

  /**
   * Layout inheritance: if a template extends another, render the PARENT, substituting any
   * blocks the child overrides. Child content outside a block is discarded, which is what
   * makes `{% extends %}` a layout rather than a concatenation.
   */
  private renderTemplate(template: ParsedTemplate, name: string, context: Record<string, unknown>): string {
    if (template.extends === null) {
      return this.renderNodes(template.nodes, context, name, new Map());
    }

    const chainBlocks = new Map(template.blocks);
    let current = template;
    const seen = new Set<string>([name]);

    while (current.extends !== null) {
      if (seen.has(current.extends)) {
        throw new TemplateError(`Circular {% extends %} involving ${current.extends}`, name);
      }
      seen.add(current.extends);

      const parent = this.load(current.extends);
      // A child's blocks win; a parent's are the fallback.
      for (const [blockName, body] of parent.blocks) {
        if (!chainBlocks.has(blockName)) chainBlocks.set(blockName, body);
      }
      current = parent;
    }

    return this.renderNodes(current.nodes, context, name, chainBlocks);
  }

  private renderNodes(
    nodes: Node[],
    context: Record<string, unknown>,
    templateName: string,
    blocks: Map<string, Node[]>,
  ): string {
    let out = "";

    for (const node of nodes) {
      switch (node.kind) {
        case "text":
          out += node.value;
          break;

        case "output":
          out += this.renderOutput(node.expression, context, templateName, node.line);
          break;

        case "if": {
          for (const branch of node.branches) {
            if (branch.condition === null || truthy(this.evaluate(branch.condition, context, templateName, node.line))) {
              out += this.renderNodes(branch.body, context, templateName, blocks);
              break;
            }
          }
          break;
        }

        case "for": {
          const iterable = this.evaluate(node.iterable, context, templateName, node.line);
          const items = toArray(iterable);

          if (items.length === 0) {
            out += this.renderNodes(node.empty, context, templateName, blocks);
            break;
          }

          items.forEach((item, index) => {
            // A child scope, so loop variables don't leak or clobber the outer context.
            const scope: Record<string, unknown> = { ...context, [node.variable]: item };
            if (node.indexVariable) scope[node.indexVariable] = index;
            scope["loop"] = {
              index: index + 1,
              index0: index,
              first: index === 0,
              last: index === items.length - 1,
              length: items.length,
            };
            out += this.renderNodes(node.body, scope, templateName, blocks);
          });
          break;
        }

        case "include": {
          const included = this.load(node.name);
          out += this.renderNodes(included.nodes, context, node.name, blocks);
          break;
        }

        case "block": {
          // An overriding block from the inheritance chain wins over the parent's default.
          const override = blocks.get(node.name);
          out += this.renderNodes(override ?? node.body, context, templateName, blocks);
          break;
        }
      }
    }

    return out;
  }

  private renderOutput(
    expression: Expression,
    context: Record<string, unknown>,
    templateName: string,
    line: number,
  ): string {
    const value = this.evaluate(expression, context, templateName, line);

    if (value === undefined || value === null) return "";
    if (value instanceof SafeString) return value.value;

    const text = String(value);
    return this.autoescape ? escapeHtml(text) : text;
  }

  private evaluate(
    expression: Expression,
    context: Record<string, unknown>,
    templateName: string,
    line: number,
  ): unknown {
    let value: unknown =
      expression.literal !== undefined ? expression.literal : resolvePath(context, expression.path);

    for (const filter of expression.filters) {
      const fn = this.filters[filter.name];
      if (!fn) throw new TemplateError(`Unknown filter "${filter.name}"`, templateName, line);
      value = fn(value, ...filter.args);
    }

    if (expression.comparison) {
      const right = this.evaluate(expression.comparison.right, context, templateName, line);
      value = compare(value, expression.comparison.operator, right);
    }

    return expression.negated ? !truthy(value) : value;
  }
}

/** Walk a dotted path. Missing segments yield undefined rather than throwing. */
function resolvePath(root: unknown, path: string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof SafeString) return value.value !== "";
  return Boolean(value);
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === "object") {
    return Object.entries(value).map(([key, item]) => ({ key, value: item }));
  }
  return [value];
}

function compare(left: unknown, operator: string, right: unknown): boolean {
  switch (operator) {
    case "==": return left === right;
    case "!=": return left !== right;
    case ">": return (left as number) > (right as number);
    case "<": return (left as number) < (right as number);
    case ">=": return (left as number) >= (right as number);
    case "<=": return (left as number) <= (right as number);
    default: return false;
  }
}

export { SafeString };
