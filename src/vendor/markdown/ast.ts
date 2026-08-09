/**
 * The AST.
 *
 * The whole design rests on one decision: **parse to a tree, then render the tree**. A
 * regex-substitution Markdown converter - the classic "match a pair of asterisks and swap in
 * `<strong>`" approach - cannot express nesting, cannot tell a `*` inside a code span from an
 * emphasis marker, and has no place to hang extensions. A tree can do all three.
 *
 * Nodes are plain data. Everything that consumes them - the HTML renderer, the plain-text
 * renderer, the TOC builder, a user's own visitor - is just a function over this shape.
 */

export type Node = BlockNode | InlineNode;

export type BlockNode =
  | Document
  | Heading
  | Paragraph
  | CodeBlock
  | BlockQuote
  | List
  | ListItem
  | ThematicBreak
  | Table
  | HtmlBlock;

export type InlineNode =
  | Text
  | Emphasis
  | Strong
  | Strikethrough
  | CodeSpan
  | Link
  | Image
  | LineBreak
  | HtmlInline;

export interface Document {
  type: "document";
  children: BlockNode[];
  /** Parsed YAML-ish front matter, when present. */
  frontMatter?: Record<string, unknown>;
}

export interface Heading {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: InlineNode[];
  /** URL-safe slug, filled in by the parser for anchors and the TOC. */
  slug: string;
}

export interface Paragraph {
  type: "paragraph";
  children: InlineNode[];
}

export interface CodeBlock {
  type: "code";
  /** Info string after the fence, e.g. "ts" or "js title=x". Empty for indented code. */
  info: string;
  /** The first word of the info string - the language. */
  lang: string;
  value: string;
  fenced: boolean;
}

export interface BlockQuote {
  type: "blockquote";
  children: BlockNode[];
}

export interface List {
  type: "list";
  ordered: boolean;
  start: number;
  /** A list is "loose" when any item is separated by a blank line; loose items wrap in <p>. */
  loose: boolean;
  children: ListItem[];
}

export interface ListItem {
  type: "listItem";
  children: BlockNode[];
  /** null when this isn't a task list item. */
  checked: boolean | null;
}

export interface ThematicBreak {
  type: "thematicBreak";
}

export type TableAlign = "left" | "center" | "right" | null;

export interface Table {
  type: "table";
  align: TableAlign[];
  header: InlineNode[][];
  rows: InlineNode[][][];
}

export interface HtmlBlock {
  type: "htmlBlock";
  value: string;
}

export interface Text {
  type: "text";
  value: string;
}

export interface Emphasis {
  type: "emphasis";
  children: InlineNode[];
}

export interface Strong {
  type: "strong";
  children: InlineNode[];
}

export interface Strikethrough {
  type: "strikethrough";
  children: InlineNode[];
}

export interface CodeSpan {
  type: "codeSpan";
  value: string;
}

export interface Link {
  type: "link";
  url: string;
  title: string | undefined;
  children: InlineNode[];
}

export interface Image {
  type: "image";
  url: string;
  title: string | undefined;
  alt: string;
}

export interface LineBreak {
  type: "lineBreak";
  hard: boolean;
}

export interface HtmlInline {
  type: "htmlInline";
  value: string;
}

/** A link reference definition: `[label]: /url "title"`. */
export interface LinkReference {
  url: string;
  title: string | undefined;
}

// --- Traversal ------------------------------------------------------------------

/** Nodes that have children (used by the visitor to know where to recurse). */
export function childrenOf(node: Node): Node[] {
  switch (node.type) {
    case "document":
    case "paragraph":
    case "heading":
    case "blockquote":
    case "list":
    case "listItem":
    case "emphasis":
    case "strong":
    case "strikethrough":
    case "link":
      return node.children as Node[];
    case "table":
      return [...node.header.flat(), ...node.rows.flat(2)];
    default:
      return [];
  }
}

export interface Visitor {
  /** Called on entry. Return false to skip this node's children. */
  enter?(node: Node, parent: Node | undefined): void | boolean;
  leave?(node: Node, parent: Node | undefined): void;
}

/** Depth-first walk. The extension point for anything that inspects a document. */
export function visit(node: Node, visitor: Visitor, parent?: Node): void {
  const descend = visitor.enter ? visitor.enter(node, parent) : undefined;
  if (descend !== false) {
    for (const child of childrenOf(node)) visit(child, visitor, node);
  }
  visitor.leave?.(node, parent);
}
