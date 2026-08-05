/**
 * Content loading: read files, parse front matter, render Markdown, derive metadata.
 *
 * The Markdown parser is the VENDORED copy of project 08 (see src/vendor/markdown/
 * VENDORED.md). It's a copy rather than an import so this generator stands alone — you can
 * lift this folder out of the repo and it still builds.
 */

import { promises as fs } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { markdownToHtml, parse as parseMarkdown, buildToc, renderToc, type TocEntry } from "./vendor/markdown/index.js";

export interface PageData {
  /** Path relative to the content root, e.g. "posts/hello.md". */
  sourcePath: string;
  /** Output path relative to dist, e.g. "posts/hello/index.html". */
  outputPath: string;
  /** Site-absolute URL, e.g. "/posts/hello/". */
  url: string;
  /** Slug derived from the filename. */
  slug: string;
  /** Which collection this belongs to, from its top-level directory. */
  collection: string;

  title: string;
  date: Date | null;
  draft: boolean;
  tags: string[];
  /** Everything from the front matter, including keys we don't interpret. */
  frontMatter: Record<string, unknown>;

  /** Rendered HTML body. */
  content: string;
  /** Raw Markdown, before rendering. */
  raw: string;
  /** First paragraph or the explicit `excerpt` field. */
  excerpt: string;
  tableOfContents: TocEntry[];
  tocHtml: string;
  /** Approximate reading time in minutes. */
  readingTime: number;
  wordCount: number;
}

export interface LoadOptions {
  contentDir: string;
  /** Include pages marked `draft: true`. */
  includeDrafts?: boolean;
  /** Include pages dated in the future. */
  includeScheduled?: boolean;
  now?: Date;
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

/** Recursively list files under a directory. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }

  await walk(root);
  return out.sort();
}

export async function loadContent(options: LoadOptions): Promise<PageData[]> {
  const now = options.now ?? new Date();
  const files = await listFiles(options.contentDir);
  const pages: PageData[] = [];

  for (const file of files) {
    if (!MARKDOWN_EXTENSIONS.has(extname(file).toLowerCase())) continue;

    const source = await fs.readFile(file, "utf8");
    const page = buildPage(source, relative(options.contentDir, file));

    // Drafts and future-dated posts are excluded from production builds but available to the
    // dev server, which is the whole point of having both flags.
    if (page.draft && !options.includeDrafts) continue;
    if (page.date && page.date > now && !options.includeScheduled) continue;

    pages.push(page);
  }

  return pages;
}

export function buildPage(source: string, sourcePath: string): PageData {
  const doc = parseMarkdown(source);
  const frontMatter = doc.frontMatter ?? {};

  // Strip the front matter before rendering, or it would appear in the output.
  const body = stripFrontMatter(source);
  const content = markdownToHtml(source);

  const normalized = sourcePath.split(sep).join("/");
  const slug = slugFromPath(normalized, frontMatter);
  const collection = normalized.includes("/") ? (normalized.split("/")[0] as string) : "pages";

  const isIndex = basename(normalized, extname(normalized)) === "index";
  const dir = dirname(normalized) === "." ? "" : dirname(normalized) + "/";
  const outputPath = isIndex ? `${dir}index.html` : `${dir}${slug}/index.html`;
  const url = "/" + (isIndex ? dir : `${dir}${slug}/`);

  const words = body.split(/\s+/).filter(Boolean).length;
  const toc = buildToc(doc);

  return {
    sourcePath: normalized,
    outputPath,
    url,
    slug,
    collection,
    title: typeof frontMatter["title"] === "string" ? frontMatter["title"] : titleFromContent(doc, slug),
    date: toDate(frontMatter["date"]),
    draft: frontMatter["draft"] === true,
    tags: toStringArray(frontMatter["tags"]),
    frontMatter,
    content,
    raw: body,
    excerpt:
      typeof frontMatter["excerpt"] === "string" ? frontMatter["excerpt"] : excerptFrom(content),
    tableOfContents: toc,
    tocHtml: renderToc(toc),
    wordCount: words,
    // 200 wpm is the conventional average for silent reading of prose.
    readingTime: Math.max(1, Math.round(words / 200)),
  };
}

function stripFrontMatter(source: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(source);
  return match ? source.slice(match[0].length) : source;
}

function slugFromPath(path: string, frontMatter: Record<string, unknown>): string {
  if (typeof frontMatter["slug"] === "string" && frontMatter["slug"] !== "") {
    return frontMatter["slug"];
  }
  const name = basename(path, extname(path));
  // Strip a leading date, so "2026-01-15-hello-world.md" becomes "hello-world".
  return name.replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

function titleFromContent(doc: ReturnType<typeof parseMarkdown>, fallback: string): string {
  for (const node of doc.children) {
    if (node.type === "heading" && node.level === 1) {
      return node.children.map(inlineText).join("");
    }
  }
  return fallback.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function inlineText(node: { type: string; value?: string; children?: unknown[] }): string {
  if (node.type === "text" || node.type === "codeSpan") return node.value ?? "";
  if (Array.isArray(node.children)) {
    return (node.children as Array<{ type: string; value?: string; children?: unknown[] }>)
      .map(inlineText)
      .join("");
  }
  return "";
}

/** The first paragraph, tags stripped. */
function excerptFrom(html: string): string {
  const match = /<p>([\s\S]*?)<\/p>/.exec(html);
  if (!match) return "";
  return (match[1] as string)
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string" && value.trim() !== "") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// --- Collections and taxonomies --------------------------------------------------

export interface Collections {
  /** Pages grouped by their top-level directory. */
  byCollection: Map<string, PageData[]>;
  /** Pages grouped by tag. */
  byTag: Map<string, PageData[]>;
  all: PageData[];
}

export function organize(pages: PageData[]): Collections {
  const byCollection = new Map<string, PageData[]>();
  const byTag = new Map<string, PageData[]>();

  for (const page of pages) {
    const list = byCollection.get(page.collection) ?? [];
    list.push(page);
    byCollection.set(page.collection, list);

    for (const tag of page.tags) {
      const tagged = byTag.get(tag) ?? [];
      tagged.push(page);
      byTag.set(tag, tagged);
    }
  }

  // Newest first within every group; undated pages sort last.
  const byDateDesc = (a: PageData, b: PageData): number => {
    if (!a.date && !b.date) return a.title.localeCompare(b.title);
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.getTime() - a.date.getTime();
  };

  for (const list of byCollection.values()) list.sort(byDateDesc);
  for (const list of byTag.values()) list.sort(byDateDesc);

  return { byCollection, byTag, all: [...pages].sort(byDateDesc) };
}

export interface Page<T> {
  items: T[];
  number: number;
  total: number;
  url: string;
  previousUrl: string | null;
  nextUrl: string | null;
}

/** Split a list into pages, generating the URLs for each. */
export function paginate<T>(items: T[], perPage: number, baseUrl: string): Array<Page<T>> {
  if (perPage <= 0) throw new RangeError("perPage must be positive");

  const total = Math.max(1, Math.ceil(items.length / perPage));
  const pages: Array<Page<T>> = [];

  for (let i = 0; i < total; i++) {
    // Page 1 lives at the base URL; later pages at /page/2/ — the convention readers expect.
    const url = i === 0 ? baseUrl : `${baseUrl}page/${i + 1}/`;
    pages.push({
      items: items.slice(i * perPage, (i + 1) * perPage),
      number: i + 1,
      total,
      url,
      previousUrl: i === 0 ? null : i === 1 ? baseUrl : `${baseUrl}page/${i}/`,
      nextUrl: i === total - 1 ? null : `${baseUrl}page/${i + 2}/`,
    });
  }

  return pages;
}
