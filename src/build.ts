/**
 * The build pipeline.
 *
 * ## Determinism
 *
 * Two builds of the same input must produce byte-identical output. That is what makes
 * content-hashed filenames stable (so caches stay warm), makes deploys diffable, and makes
 * "did anything actually change?" answerable. Achieving it means being deliberate about:
 *
 *   - **Ordering.** Every list is explicitly sorted; directory read order is not stable.
 *   - **Timestamps.** A build clock is injected, so `<lastBuildDate>` doesn't make every
 *     build differ. Production passes the real clock; tests pass a fixed one.
 *
 * The `deterministic` option pins the clock, and there is a test that runs the whole build
 * twice and compares every output file.
 */

import { promises as fs, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { copyAssets, minifyHtml, rewriteAssetUrls, type AssetManifest } from "./assets.js";
import { loadContent, organize, paginate, type PageData } from "./content.js";
import {
  buildSearchIndex,
  render404,
  renderAtom,
  renderRobots,
  renderRss,
  renderSitemap,
  type SiteConfig,
} from "./feeds.js";
import { TemplateEngine } from "./template.js";

export interface BuildOptions {
  site: SiteConfig;
  /** Directory containing Markdown content. */
  contentDir: string;
  /** Directory containing templates. */
  templateDir: string;
  /** Directory containing static assets. */
  assetDir: string;
  outputDir: string;

  includeDrafts?: boolean;
  includeScheduled?: boolean;
  postsPerPage?: number;
  hashAssets?: boolean;
  minify?: boolean;
  /** Pin the clock so output is byte-stable. */
  deterministic?: boolean;
  now?: Date;
  /** Extra values available to every template. */
  globals?: Record<string, unknown>;
}

export interface StageTiming {
  name: string;
  ms: number;
  detail: string;
}

export interface BuildResult {
  pages: PageData[];
  /** Output path → byte length. */
  outputs: Map<string, number>;
  timings: StageTiming[];
  totalMs: number;
  assetManifest: AssetManifest;
}

export async function build(options: BuildOptions): Promise<BuildResult> {
  const timings: StageTiming[] = [];
  const outputs = new Map<string, number>();
  const started = process.hrtime.bigint();

  // A fixed clock in deterministic mode; otherwise the real one.
  const now = options.now ?? (options.deterministic ? new Date("2026-01-01T00:00:00.000Z") : new Date());

  const stage = async <T>(name: string, fn: () => Promise<T> | T, describe: (value: T) => string): Promise<T> => {
    const start = process.hrtime.bigint();
    const value = await fn();
    timings.push({
      name,
      ms: Number(process.hrtime.bigint() - start) / 1e6,
      detail: describe(value),
    });
    return value;
  };

  // --- 1. Clean ------------------------------------------------------------
  await stage(
    "clean",
    async () => {
      await fs.rm(options.outputDir, { recursive: true, force: true });
      await fs.mkdir(options.outputDir, { recursive: true });
    },
    () => options.outputDir,
  );

  // --- 2. Read content -----------------------------------------------------
  const pages = await stage(
    "content",
    () =>
      loadContent({
        contentDir: options.contentDir,
        includeDrafts: options.includeDrafts ?? false,
        includeScheduled: options.includeScheduled ?? false,
        now,
      }),
    (value) => `${value.length} pages`,
  );

  const collections = organize(pages);

  // --- 3. Assets (before templates, so the manifest exists for URL rewriting) ---
  const assetManifest = await stage(
    "assets",
    () =>
      copyAssets({
        sourceDir: options.assetDir,
        outputDir: join(options.outputDir, "assets"),
        hash: options.hashAssets ?? true,
        minifyCss: options.minify ?? true,
      }),
    (value) => `${value.count} files, ${formatBytes(value.bytes)}`,
  );

  // --- 4. Templates --------------------------------------------------------
  const engine = new TemplateEngine({
    loader: (name) => {
      // Synchronous by necessity: the template engine resolves {% include %} and
      // {% extends %} mid-render, and threading async through the renderer would infect
      // every node type for no benefit at this scale.
      const path = join(options.templateDir, name);
      return readTemplate(path, name);
    },
  });

  const globals: Record<string, unknown> = {
    site: options.site,
    collections: Object.fromEntries(collections.byCollection),
    tags: [...collections.byTag.keys()].sort(),
    tagCounts: Object.fromEntries([...collections.byTag].map(([tag, list]) => [tag, list.length])),
    allPages: collections.all,
    buildTime: now,
    ...options.globals,
  };

  const write = async (relativePath: string, contents: string): Promise<void> => {
    let output = contents;
    if (options.hashAssets ?? true) output = rewriteAssetUrls(output, assetManifest);
    if (options.minify ?? true) output = minifyHtml(output);

    const target = join(options.outputDir, relativePath);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, output, "utf8");
    outputs.set(relativePath, Buffer.byteLength(output));
  };

  // --- 5. Render pages -----------------------------------------------------
  await stage(
    "pages",
    async () => {
      for (const page of collections.all) {
        const template =
          typeof page.frontMatter["layout"] === "string" ? page.frontMatter["layout"] : "page.html";
        const html = engine.render(template, { ...globals, page });
        await write(page.outputPath, html);
      }
      return collections.all.length;
    },
    (count) => `${count} rendered`,
  );

  // --- 6. Index and pagination ---------------------------------------------
  await stage(
    "index",
    async () => {
      const posts = collections.byCollection.get("posts") ?? [];
      const paged = paginate(posts, options.postsPerPage ?? 5, "/");
      for (const page of paged) {
        const html = engine.render("index.html", { ...globals, pagination: page, posts: page.items });
        const path = page.number === 1 ? "index.html" : `page/${page.number}/index.html`;
        await write(path, html);
      }
      return paged.length;
    },
    (count) => `${count} page(s)`,
  );

  // --- 7. Tag pages ---------------------------------------------------------
  await stage(
    "taxonomies",
    async () => {
      // Sorted, so output order does not depend on Map insertion order.
      const tags = [...collections.byTag.keys()].sort();
      for (const tag of tags) {
        const tagged = collections.byTag.get(tag) as PageData[];
        const html = engine.render("tag.html", { ...globals, tag, posts: tagged });
        await write(`tags/${slugifyTag(tag)}/index.html`, html);
      }
      return tags.length;
    },
    (count) => `${count} tag page(s)`,
  );

  // --- 8. Feeds and metadata ------------------------------------------------
  await stage(
    "feeds",
    async () => {
      const posts = collections.byCollection.get("posts") ?? [];
      const files: Array<[string, string]> = [
        ["feed.xml", renderRss(options.site, posts, 20, now)],
        ["atom.xml", renderAtom(options.site, posts, 20, now)],
        ["sitemap.xml", renderSitemap(options.site, collections.all)],
        ["robots.txt", renderRobots(options.site)],
        ["404.html", render404(options.site)],
        ["search-index.json", JSON.stringify(buildSearchIndex(collections.all))],
      ];

      for (const [name, contents] of files) {
        const target = join(options.outputDir, name);
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.writeFile(target, contents, "utf8");
        outputs.set(name, Buffer.byteLength(contents));
      }
      return files.length;
    },
    (count) => `${count} files`,
  );

  const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { pages: collections.all, outputs, timings, totalMs, assetManifest };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function slugifyTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

/** A readable error when a template is missing, instead of a raw ENOENT. */
function readTemplate(path: string, name: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Template not found: ${name} (looked in ${path})`);
    }
    throw err;
  }
}
