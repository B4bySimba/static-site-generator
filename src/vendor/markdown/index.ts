/**
 * Public API.
 *
 * The pipeline in one line:
 *
 *   source ──► front matter ──► BLOCK phase ──► AST ──► INLINE phase ──► AST ──► renderer
 */

import type { Document, Heading, LinkReference } from "./ast.js";
import { parseBlocks, type ParseContext } from "./block.js";
import { extractFrontMatter } from "./frontmatter.js";
import { renderHtml, type HtmlOptions } from "./render/html.js";
import { renderText, type TextOptions } from "./render/text.js";
import { createSlugCounter } from "./slug.js";
import { visit } from "./ast.js";

export * from "./ast.js";
export { extractFrontMatter, type FrontMatterResult } from "./frontmatter.js";
export { renderHtml, escapeHtml, defaultSanitizeUrl, renderNode, type HtmlOptions } from "./render/html.js";
export { renderText, type TextOptions } from "./render/text.js";
export { slugify, createSlugCounter, type SlugCounter } from "./slug.js";
export { decodeEntities, decodeAllEntities } from "./entities.js";
export { parseInlines } from "./inline.js";

export interface ParseOptions {
  /** Extract and strip a `---` front matter block. Default true. */
  frontMatter?: boolean;
}

/** Parse Markdown into an AST. */
export function parse(source: string, options: ParseOptions = {}): Document {
  let content = source;
  let data: Record<string, unknown> = {};

  if (options.frontMatter !== false) {
    const extracted = extractFrontMatter(source);
    content = extracted.content;
    data = extracted.data;
  }

  const context: ParseContext = {
    definitions: new Map<string, LinkReference>(),
    slugs: createSlugCounter(),
  };

  // Link reference definitions can appear AFTER the links that use them, so the block phase
  // runs once to collect them, then again to resolve. Two cheap passes beat a fix-up pass
  // over the finished tree.
  parseBlocks(content, { definitions: context.definitions, slugs: createSlugCounter() });
  const doc = parseBlocks(content, context);

  if (Object.keys(data).length > 0) doc.frontMatter = data;
  return doc;
}

/** Parse and render to HTML in one step. */
export function markdownToHtml(source: string, options: ParseOptions & HtmlOptions = {}): string {
  return renderHtml(parse(source, options), options);
}

/** Parse and render to plain text in one step. */
export function markdownToText(source: string, options: ParseOptions & TextOptions = {}): string {
  return renderText(parse(source, options), options);
}

export interface TocEntry {
  level: number;
  text: string;
  slug: string;
  children: TocEntry[];
}

/** Build a nested table of contents from a document's headings. */
export function buildToc(doc: Document, maxLevel = 3): TocEntry[] {
  const flat: TocEntry[] = [];

  visit(doc, {
    enter(node) {
      if (node.type !== "heading") return;
      const heading = node as Heading;
      if (heading.level > maxLevel) return;
      flat.push({
        level: heading.level,
        text: inlineText(heading),
        slug: heading.slug,
        children: [],
      });
    },
  });

  // Fold the flat list into a tree using a stack of open ancestors.
  const root: TocEntry[] = [];
  const stack: TocEntry[] = [];

  for (const entry of flat) {
    while (stack.length > 0 && (stack[stack.length - 1] as TocEntry).level >= entry.level) {
      stack.pop();
    }
    if (stack.length === 0) root.push(entry);
    else (stack[stack.length - 1] as TocEntry).children.push(entry);
    stack.push(entry);
  }

  return root;
}

/** Render a TOC as nested HTML lists. */
export function renderToc(entries: TocEntry[]): string {
  if (entries.length === 0) return "";
  const items = entries
    .map((e) => `<li><a href="#${e.slug}">${escapeText(e.text)}</a>${renderToc(e.children)}</li>`)
    .join("\n");
  return `<ul>\n${items}\n</ul>`;
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Concatenate the plain text of a node's inline children. */
export function inlineText(node: { children: Array<{ type: string; value?: string; children?: unknown[] }> }): string {
  let out = "";
  const walk = (nodes: Array<{ type: string; value?: string; children?: unknown[] }>): void => {
    for (const child of nodes) {
      if (child.type === "text" || child.type === "codeSpan") out += child.value ?? "";
      else if (Array.isArray(child.children)) {
        walk(child.children as Array<{ type: string; value?: string; children?: unknown[] }>);
      } else if (child.type === "image") out += "";
    }
  };
  walk(node.children);
  return out;
}
