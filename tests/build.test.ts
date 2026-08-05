import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
  build,
  buildPage,
  buildSearchIndex,
  contentHash,
  escapeXml,
  listFiles,
  minifyCss,
  minifyHtml,
  organize,
  paginate,
  renderAtom,
  renderRss,
  renderSitemap,
  serve,
  type SiteConfig,
} from "../src/index.js";

const BLOG = resolve(import.meta.dirname, "..", "examples", "blog");

const SITE: SiteConfig = {
  title: "Test Site",
  description: "A & B <test>",
  url: "https://example.com",
  author: "Bruce",
};

const tempDirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "ssg-"));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
});

/** Read every file under a directory into a map, for comparison. */
async function readAll(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const file of await listFiles(root)) {
    out.set(file.slice(root.length), await fs.readFile(file, "utf8"));
  }
  return out;
}

const buildOptions = (outputDir: string) => ({
  site: SITE,
  contentDir: join(BLOG, "content"),
  templateDir: join(BLOG, "templates"),
  assetDir: join(BLOG, "assets"),
  outputDir,
});

// --- Content ---------------------------------------------------------------------

test("buildPage derives metadata from front matter and content", () => {
  const page = buildPage(
    `---
title: Hello World
date: 2026-03-15
tags: [a, b]
---

First paragraph here.

## A heading

More text.`,
    "posts/2026-03-15-hello-world.md",
  );

  assert.equal(page.title, "Hello World");
  assert.equal(page.date?.toISOString().slice(0, 10), "2026-03-15");
  assert.deepEqual(page.tags, ["a", "b"]);
  assert.equal(page.collection, "posts");
  assert.equal(page.slug, "hello-world", "the date prefix is stripped from the slug");
  assert.equal(page.url, "/posts/hello-world/");
  assert.equal(page.outputPath, "posts/hello-world/index.html");
  assert.equal(page.excerpt, "First paragraph here.");
  assert.match(page.content, /<h2 id="a-heading">A heading<\/h2>/);
  assert.equal(page.tableOfContents.length, 1);
  assert.ok(page.readingTime >= 1);
  assert.ok(page.wordCount > 0);
});

test("a title falls back to the first h1, then to the slug", () => {
  assert.equal(buildPage("# From Heading\n\ntext", "a.md").title, "From Heading");
  assert.equal(buildPage("just text", "my-post-name.md").title, "My Post Name");
});

test("front matter is stripped from the rendered body", () => {
  const page = buildPage("---\ntitle: X\n---\n\nBody text.", "a.md");
  assert.doesNotMatch(page.content, /title:/);
  assert.match(page.content, /Body text/);
});

test("drafts and scheduled posts are excluded by default", async () => {
  const pages = await import("../src/content.js").then((m) =>
    m.loadContent({ contentDir: join(BLOG, "content"), now: new Date("2026-08-06") }),
  );
  assert.ok(!pages.some((p) => p.draft), "no drafts in a production build");

  const withDrafts = await import("../src/content.js").then((m) =>
    m.loadContent({ contentDir: join(BLOG, "content"), includeDrafts: true, now: new Date("2026-08-06") }),
  );
  assert.ok(withDrafts.length > pages.length, "drafts appear when asked for");
});

test("organize groups by collection and tag, newest first", () => {
  const pages = [
    buildPage("---\ntitle: A\ndate: 2026-01-01\ntags: [x]\n---\nbody", "posts/a.md"),
    buildPage("---\ntitle: B\ndate: 2026-06-01\ntags: [x, y]\n---\nbody", "posts/b.md"),
    buildPage("---\ntitle: C\n---\nbody", "about.md"),
  ];
  const collections = organize(pages);

  assert.equal(collections.byCollection.get("posts")?.length, 2);
  assert.equal(collections.byCollection.get("pages")?.length, 1, "root files land in 'pages'");
  assert.equal(collections.byTag.get("x")?.length, 2);
  assert.equal(collections.byTag.get("y")?.length, 1);
  assert.equal(collections.all[0]?.title, "B", "newest first");
});

test("paginate splits and links pages", () => {
  const pages = paginate([1, 2, 3, 4, 5], 2, "/");
  assert.equal(pages.length, 3);
  assert.deepEqual(pages[0]?.items, [1, 2]);
  assert.equal(pages[0]?.url, "/", "page 1 lives at the base URL");
  assert.equal(pages[0]?.previousUrl, null);
  assert.equal(pages[0]?.nextUrl, "/page/2/");
  assert.equal(pages[1]?.previousUrl, "/", "page 2 links back to the base, not /page/1/");
  assert.equal(pages[2]?.nextUrl, null);

  assert.equal(paginate([], 5, "/").length, 1, "an empty list still yields one page");
  assert.throws(() => paginate([1], 0, "/"), RangeError);
});

// --- Assets ------------------------------------------------------------------------

test("content hashing is stable for identical content and differs otherwise", () => {
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
  assert.equal(contentHash("abc").length, 8);
});

test("minifyCss shrinks output but PRESERVES string and url() contents", () => {
  const css = `/* comment */
  body {
    color : red ;
    margin: 0.5em;
  }
  .a::after { content: "a  b"; }
  .b { background: url( /img/x.png ); }`;

  const minified = minifyCss(css);
  assert.ok(minified.length < css.length);
  assert.doesNotMatch(minified, /\/\*/, "comments removed");
  assert.match(minified, /body\{color:red/, "whitespace collapsed");
  assert.match(minified, /content:"a  b"/, "the two spaces inside the string survive");
  assert.match(minified, /url\( \/img\/x\.png \)/, "url() contents untouched");
  assert.match(minified, /margin:\.5em/, "leading zero dropped");
});

test("minifyHtml preserves pre/script/textarea content", () => {
  const html = `<div>
    <p>text</p>
    <pre>  indented
  code  </pre>
    <script>if (a  <  b) {}</script>
  </div>`;

  const minified = minifyHtml(html);
  assert.match(minified, /<pre>  indented\n  code  <\/pre>/, "pre content is byte-identical");
  assert.match(minified, /if \(a  <  b\) \{\}/, "script content untouched");
  assert.ok(minified.length < html.length);
});

test("asset URLs are rewritten to their hashed names", async () => {
  const output = await temp();
  const result = await build(buildOptions(output));

  const index = await fs.readFile(join(output, "index.html"), "utf8");
  const cssName = result.assetManifest.map.get("css/style.css") as string;
  assert.match(cssName, /style\.[0-9a-f]{8}\.css/, "the file got a content hash");
  assert.match(index, new RegExp(cssName.replace(/[.]/g, "\\.")), "and the HTML references it");
  assert.doesNotMatch(index, /"\/assets\/css\/style\.css"/, "the unhashed name is gone");
});

// --- Feeds ---------------------------------------------------------------------------

test("XML output escapes the five predefined entities", () => {
  assert.equal(escapeXml(`&<>"'`), "&amp;&lt;&gt;&quot;&apos;");

  const page = buildPage("---\ntitle: A & B <c>\ndate: 2026-01-01\n---\nbody", "posts/a.md");
  const rss = renderRss(SITE, [page], 20, new Date("2026-01-01"));
  assert.match(rss, /<title>A &amp; B &lt;c&gt;<\/title>/);
  assert.doesNotMatch(rss, /<title>A & B/, "a raw ampersand would make the feed invalid XML");
  assert.match(rss, /A &amp; B &lt;test&gt;/, "the site description is escaped too");
});

test("RSS uses RFC 822 dates and Atom uses ISO 8601", () => {
  const page = buildPage("---\ntitle: X\ndate: 2026-03-15T12:00:00Z\n---\nbody", "posts/x.md");
  const fixed = new Date("2026-01-01T00:00:00Z");

  assert.match(renderRss(SITE, [page], 20, fixed), /<pubDate>Sun, 15 Mar 2026 12:00:00 GMT<\/pubDate>/);
  assert.match(renderAtom(SITE, [page], 20, fixed), /<updated>2026-03-15T12:00:00\.000Z<\/updated>/);
});

test("sitemap lists every page with absolute URLs", () => {
  const pages = [
    buildPage("---\ntitle: A\ndate: 2026-01-01\n---\nb", "posts/a.md"),
    buildPage("---\ntitle: B\n---\nb", "about.md"),
  ];
  const sitemap = renderSitemap(SITE, pages);
  assert.match(sitemap, /<loc>https:\/\/example\.com\/posts\/a\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/example\.com\/about\/<\/loc>/);
  assert.equal((sitemap.match(/<url>/g) ?? []).length, 2);
});

test("the search index strips markup and caps body length", () => {
  const page = buildPage(
    "---\ntitle: T\n---\n# Heading\n\n```js\ncode block\n```\n\nSome **bold** text.",
    "a.md",
  );
  const [doc] = buildSearchIndex([page], 50);
  assert.equal(doc?.title, "T");
  assert.doesNotMatch(doc?.body ?? "", /```/, "code fences removed");
  assert.doesNotMatch(doc?.body ?? "", /\*\*/, "markdown punctuation removed");
  assert.ok((doc?.body.length ?? 0) <= 50, "body is capped");
});

// --- The full build --------------------------------------------------------------------

test("the example blog builds end to end", async () => {
  const output = await temp();
  const result = await build(buildOptions(output));

  assert.ok(result.pages.length >= 6, `built ${result.pages.length} pages`);
  assert.ok(!result.pages.some((p) => p.draft), "drafts excluded");

  const files = (await listFiles(output)).map((f) => f.slice(output.length + 1));
  for (const expected of [
    "index.html",
    "feed.xml",
    "atom.xml",
    "sitemap.xml",
    "robots.txt",
    "404.html",
    "search-index.json",
    "about/index.html",
  ]) {
    assert.ok(files.includes(expected), `missing ${expected}`);
  }
  assert.ok(files.some((f) => f.startsWith("posts/")), "post pages exist");
  assert.ok(files.some((f) => f.startsWith("tags/")), "tag pages exist");
  assert.ok(files.some((f) => f.startsWith("page/2/")), "pagination exists");
});

test("every stage is timed", async () => {
  const output = await temp();
  const result = await build(buildOptions(output));

  const names = result.timings.map((t) => t.name);
  assert.deepEqual(names, ["clean", "content", "assets", "pages", "index", "taxonomies", "feeds"]);
  assert.ok(result.timings.every((t) => t.ms >= 0));
  assert.ok(result.totalMs > 0);
});

test("BUILDS ARE DETERMINISTIC: two runs produce identical bytes", async () => {
  // The property that makes content hashes stable and deploys diffable.
  const first = await temp();
  const second = await temp();

  await build({ ...buildOptions(first), deterministic: true });
  await build({ ...buildOptions(second), deterministic: true });

  const a = await readAll(first);
  const b = await readAll(second);

  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), "the same files are produced");
  for (const [path, contents] of a) {
    assert.equal(contents, b.get(path), `contents differ for ${path}`);
  }
});

test("a non-deterministic build differs only in the timestamp", async () => {
  // Proves the determinism above comes from pinning the clock, not from luck.
  const first = await temp();
  const second = await temp();

  await build({ ...buildOptions(first), now: new Date("2026-01-01T00:00:00Z") });
  await build({ ...buildOptions(second), now: new Date("2027-06-15T00:00:00Z") });

  const a = await fs.readFile(join(first, "feed.xml"), "utf8");
  const b = await fs.readFile(join(second, "feed.xml"), "utf8");
  assert.notEqual(a, b, "the build clock reaches the feed");
  assert.match(a, /<lastBuildDate>[^<]*2026/);
  assert.match(b, /<lastBuildDate>[^<]*2027/);
});

test("a missing template produces a readable error", async () => {
  const output = await temp();
  const emptyTemplates = await temp();
  await assert.rejects(
    () => build({ ...buildOptions(output), templateDir: emptyTemplates }),
    /Template not found/,
  );
});

// --- Dev server --------------------------------------------------------------------------

test("the dev server serves pages and injects live reload", async () => {
  const output = await temp();
  const server = await serve({ ...buildOptions(output), port: 0, watchDirs: [] });
  const port = (server.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /Latest posts/);
    assert.match(html, /__livereload/, "the live-reload script is injected");
    assert.doesNotMatch(html, /<script>\s*<\/script>/);

    // Extensionless URLs resolve to index.html, as static hosts do.
    assert.equal((await fetch(`${base}/about`)).status, 200);
    assert.equal((await fetch(`${base}/about/`)).status, 200);

    // Non-HTML assets are served without injection.
    const feed = await fetch(`${base}/feed.xml`);
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get("content-type") ?? "", /xml/);
    assert.doesNotMatch(await feed.text(), /__livereload/);

    // Missing pages fall back to the generated 404.
    const missing = await fetch(`${base}/nope/`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /404/);

    // Dev never caches.
    assert.match(index.headers.get("cache-control") ?? "", /no-store/);
  } finally {
    await server.close();
  }
});

test("the dev server includes drafts", async () => {
  const output = await temp();
  const server = await serve({ ...buildOptions(output), port: 0, watchDirs: [] });
  try {
    const files = (await listFiles(output)).map((f) => f.slice(output.length + 1));
    assert.ok(files.some((f) => f.includes("draft-example")), "drafts are visible in dev");
  } finally {
    await server.close();
  }
});

test("the dev server refuses path traversal", async () => {
  const output = await temp();
  const server = await serve({ ...buildOptions(output), port: 0, watchDirs: [] });
  const port = (server.server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`);
    assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`);
  } finally {
    await server.close();
  }
});

test("rebuild() regenerates output", async () => {
  const output = await temp();
  const rebuilds: number[] = [];
  const server = await serve({
    ...buildOptions(output),
    port: 0,
    watchDirs: [],
    onRebuild: (_result, ms) => rebuilds.push(ms),
  });
  try {
    await server.rebuild();
    assert.ok(rebuilds.length >= 2, "the initial build plus the explicit one");
  } finally {
    await server.close();
  }
});
