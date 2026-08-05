/**
 * End-to-end demo: build the example blog, show every stage, and demonstrate the template
 * engine, determinism, and the asset pipeline.
 *
 * Run: pnpm run example
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  build,
  buildSearchIndex,
  formatBytes,
  listFiles,
  minifyCss,
  TemplateEngine,
  type SiteConfig,
} from "../src/index.js";

const BLOG = resolve(import.meta.dirname, "blog");
const out = (s = "") => process.stdout.write(s + "\n");
const rule = (t: string) => out(`\n${"─".repeat(76)}\n${t}\n${"─".repeat(76)}`);

const SITE: SiteConfig = {
  title: "Built From Scratch",
  description: "Notes on rebuilding infrastructure to understand it.",
  url: "https://example.com",
  author: "Bruce",
  language: "en",
};

async function main(): Promise<void> {
  // ------------------------------------------------------------- template engine
  rule("1. The template engine");

  const engine = new TemplateEngine({
    loader: (name) => {
      const templates: Record<string, string> = {
        "layout.html": "<html><body>{% block content %}nothing{% endblock %}</body></html>",
        "card.html": "<li>{{ item.name }} ({{ item.count }})</li>",
      };
      return templates[name] ?? "";
    },
  });

  const examples: Array<[string, Record<string, unknown>]> = [
    ["{{ name | upper }}", { name: "hello" }],
    [`{{ d | date:"MMMM DD, YYYY" }}`, { d: new Date("2026-03-15T00:00:00Z") }],
    ["{% if n > 3 %}big{% else %}small{% endif %}", { n: 5 }],
    ["{% for x in items %}{{ loop.index }}.{{ x }} {% endfor %}", { items: ["a", "b", "c"] }],
    ["{% for x in items %}{{ x }}{% empty %}(none){% endfor %}", { items: [] }],
    ["{{ text | truncate:20 }}", { text: "a fairly long sentence that will be cut" }],
  ];
  for (const [source, context] of examples) {
    out(`  ${source.padEnd(52)} → ${engine.renderString(source, context)}`);
  }

  out("\n  Auto-escaping is ON by default:");
  const nasty = '<script>alert("xss")</script>';
  out(`    {{ v }}          → ${engine.renderString("{{ v }}", { v: nasty })}`);
  out(`    {{ v | safe }}   → ${engine.renderString("{{ v | safe }}", { v: nasty })}`);
  out("    ↑ escaping is the default; unsafety must be requested explicitly.");

  out("\n  Layout inheritance:");
  out(`    ${engine.renderString('{% extends "layout.html" %}{% block content %}overridden{% endblock %}')}`);

  // ------------------------------------------------------------------ minifier
  rule("2. The minifier is conservative on purpose");
  const css = `.a::after { content: "keep  these  spaces"; }\n.b { margin: 0.5em; /* c */ }`;
  out(`  before (${css.length} B): ${css.replace(/\n/g, " ")}`);
  const minified = minifyCss(css);
  out(`  after  (${minified.length} B): ${minified}`);
  out("  ↑ whitespace inside the string survived; a naive collapse would corrupt it.");

  // -------------------------------------------------------------------- build
  rule("3. Building the example blog");

  const output = await fs.mkdtemp(join(tmpdir(), "ssg-demo-"));
  const result = await build({
    site: SITE,
    contentDir: join(BLOG, "content"),
    templateDir: join(BLOG, "templates"),
    assetDir: join(BLOG, "assets"),
    outputDir: output,
  });

  for (const timing of result.timings) {
    out(`  ${timing.name.padEnd(12)} ${timing.ms.toFixed(1).padStart(7)} ms   ${timing.detail}`);
  }
  const bytes = [...result.outputs.values()].reduce((a, b) => a + b, 0);
  out(`  ${"─".repeat(48)}`);
  out(`  ${"total".padEnd(12)} ${result.totalMs.toFixed(1).padStart(7)} ms   ${result.outputs.size} files, ${formatBytes(bytes)}`);

  out("\n  Output tree:");
  const files = (await listFiles(output)).map((f) => f.slice(output.length + 1)).sort();
  for (const file of files) out(`    ${file}`);

  // --------------------------------------------------------------- asset hashing
  rule("4. Content-hashed assets");
  for (const [original, hashed] of result.assetManifest.map) {
    out(`  ${original}  →  ${hashed}`);
  }
  const index = await fs.readFile(join(output, "index.html"), "utf8");
  const reference = /href="(\/assets\/[^"]+)"/.exec(index)?.[1];
  out(`\n  and the HTML now references: ${reference}`);
  out("  ↑ hashed names can be cached forever, because a change produces a new name.");

  // ------------------------------------------------------------------- drafts
  rule("5. Drafts and scheduled posts");
  const production = result.pages.length;
  const withDrafts = await build({
    site: SITE,
    contentDir: join(BLOG, "content"),
    templateDir: join(BLOG, "templates"),
    assetDir: join(BLOG, "assets"),
    outputDir: await fs.mkdtemp(join(tmpdir(), "ssg-drafts-")),
    includeDrafts: true,
    includeScheduled: true,
  });
  out(`  production build: ${production} pages`);
  out(`  dev build:        ${withDrafts.pages.length} pages (drafts + scheduled included)`);

  // -------------------------------------------------------------- determinism
  rule("6. Determinism");
  const a = await fs.mkdtemp(join(tmpdir(), "ssg-a-"));
  const b = await fs.mkdtemp(join(tmpdir(), "ssg-b-"));
  const common = {
    site: SITE,
    contentDir: join(BLOG, "content"),
    templateDir: join(BLOG, "templates"),
    assetDir: join(BLOG, "assets"),
    deterministic: true,
  };
  await build({ ...common, outputDir: a });
  await build({ ...common, outputDir: b });

  const readAll = async (root: string): Promise<Map<string, string>> => {
    const map = new Map<string, string>();
    for (const file of await listFiles(root)) map.set(file.slice(root.length), await fs.readFile(file, "utf8"));
    return map;
  };
  const filesA = await readAll(a);
  const filesB = await readAll(b);
  const identical = [...filesA].every(([path, contents]) => filesB.get(path) === contents);
  out(`  two builds, ${filesA.size} files each`);
  out(`  byte-identical: ${identical}`);
  out("  ↑ achieved by injecting the clock and sorting every list explicitly.");

  // ------------------------------------------------------------- search index
  rule("7. The client-side search index");
  const searchIndex = buildSearchIndex(result.pages, 120);
  out(`  ${searchIndex.length} documents, ${formatBytes(Buffer.byteLength(JSON.stringify(searchIndex)))}`);
  const sample = searchIndex[0];
  if (sample) {
    out(`\n  sample entry:`);
    out(`    url:   ${sample.url}`);
    out(`    title: ${sample.title}`);
    out(`    tags:  ${sample.tags.join(", ")}`);
    out(`    body:  ${sample.body.slice(0, 80)}…`);
  }

  rule("8. The Markdown parser is VENDORED, not imported");
  out("  src/vendor/markdown/ is a verbatim copy of project 08's src/.");
  out("");
  out("  Why: the portfolio's rule is that every project stands alone — you can lift one");
  out("  folder out of the repo and it still builds. An import across project boundaries");
  out("  would break that, and couple this generator's releases to the parser's.");
  out("");
  out("  Duplication here is the deliberate choice. See src/vendor/markdown/VENDORED.md");
  out("  for provenance and the one-line re-sync command.");

  out(`\n  Try it live:  pnpm run serve   (then open http://localhost:4321)\n`);
  out("Demo complete.\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`Demo failed: ${String(err)}\n`);
  process.exit(1);
});
