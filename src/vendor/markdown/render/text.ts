/**
 * Plain-text renderer — the second renderer, whose existence is the point: the AST is a
 * genuine intermediate representation, not an HTML string builder in disguise.
 *
 * Useful for search indexes, email fallbacks, reading-time estimates, and excerpts.
 */

import type { BlockNode, Document, InlineNode } from "../ast.js";

export interface TextOptions {
  /** Wrap paragraphs at this column. 0 disables wrapping. */
  width?: number;
  /** Render links as "text (url)" instead of just their text. */
  showUrls?: boolean;
  /** Bullet character for unordered lists. */
  bullet?: string;
}

export function renderText(doc: Document, options: TextOptions = {}): string {
  const width = options.width ?? 0;
  const showUrls = options.showUrls ?? false;
  const bullet = options.bullet ?? "-";

  function inlines(nodes: InlineNode[]): string {
    return nodes
      .map((node) => {
        switch (node.type) {
          case "text":
            return node.value;
          case "emphasis":
          case "strong":
          case "strikethrough":
            return inlines(node.children);
          case "codeSpan":
            return node.value;
          case "link":
            return showUrls ? `${inlines(node.children)} (${node.url})` : inlines(node.children);
          case "image":
            return node.alt;
          case "lineBreak":
            return node.hard ? "\n" : " ";
          case "htmlInline":
            return "";
          default:
            return "";
        }
      })
      .join("");
  }

  function wrap(text: string, indent = ""): string {
    if (width <= 0) return indent + text;
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if (line === "") line = word;
      else if ((line + " " + word).length + indent.length <= width) line += " " + word;
      else {
        lines.push(indent + line);
        line = word;
      }
    }
    if (line) lines.push(indent + line);
    return lines.join("\n");
  }

  function blocks(nodes: BlockNode[], depth = 0): string {
    const indent = "  ".repeat(depth);
    const parts: string[] = [];

    for (const node of nodes) {
      switch (node.type) {
        case "heading":
          // Keep the # markers: they carry the outline structure that plain text loses.
          parts.push(`${indent}${"#".repeat(node.level)} ${inlines(node.children)}`);
          break;
        case "paragraph":
          parts.push(wrap(inlines(node.children), indent));
          break;
        case "code":
          parts.push(
            node.value
              .split("\n")
              .map((l) => `${indent}    ${l}`)
              .join("\n"),
          );
          break;
        case "blockquote":
          parts.push(
            blocks(node.children, depth)
              .split("\n")
              .map((l) => `${indent}> ${l.trimStart()}`)
              .join("\n"),
          );
          break;
        case "list":
          node.children.forEach((item, index) => {
            const marker = node.ordered ? `${node.start + index}.` : bullet;
            const box = item.checked === null ? "" : item.checked ? "[x] " : "[ ] ";
            const body = blocks(item.children, depth + 1).trimStart();
            parts.push(`${indent}${marker} ${box}${body}`);
          });
          break;
        case "thematicBreak":
          parts.push(`${indent}${"-".repeat(Math.min(width || 40, 40))}`);
          break;
        case "table": {
          // A table is ONE part: its rows are joined with single newlines, because blocks are
          // separated by a blank line and rows are not.
          const header = node.header.map((c) => inlines(c));
          const lines = [
            indent + header.join(" | "),
            indent + header.map((h) => "-".repeat(Math.max(3, h.length))).join(" | "),
            ...node.rows.map((row) => indent + row.map((c) => inlines(c)).join(" | ")),
          ];
          parts.push(lines.join("\n"));
          break;
        }
        case "htmlBlock":
          break; // no sensible plain-text form
        default:
          break;
      }
    }

    return parts.join("\n\n");
  }

  return blocks(doc.children).trim() + "\n";
}
