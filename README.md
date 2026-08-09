# Static Site Generator

A static site generator with a **template engine written from scratch**, an asset pipeline
with content hashing, feed/sitemap/search-index generation, and a dev server with live reload
over SSE. It replaces Eleventy, Hugo, and Jekyll.

The Markdown parser is a **vendored copy** of [project 08](../markdown-parser) - a real
directory of source, not an import - so this project stands alone.

Zero runtime dependencies.

## Quick start

```bash
pnpm install
pnpm test           # 53 tests, including a byte-for-byte determinism check
pnpm run example    # template engine, minifier, full build, determinism proof
pnpm run serve      # dev server on :4321 with live reload

node --import tsx src/cli.ts build --root examples/blog
```

Real output from a build of the bundled 6-post blog:

```
  clean            3.1 ms   /tmp/ssg-demo-Y5doxp
  content         44.1 ms   7 pages
  assets           2.9 ms   1 files, 2.2 KB
  pages           12.3 ms   7 rendered
  index            5.2 ms   2 page(s)
  taxonomies       6.0 ms   7 tag page(s)
  feeds            4.9 ms   6 files
  ────────────────────────────────────────────────
  total           91.6 ms   22 files, 52.0 KB
```

## Feature checklist

**Pipeline** - ✅ read content → front matter → **vendored** Markdown parser → templates →
`dist/` · ✅ per-stage timing · ✅ **deterministic builds** (verified byte-for-byte in a test)

**Template engine (from scratch)** - ✅ `{{ var }}` · ✅ filters with arguments, chainable
(18 built in) · ✅ `{% if %}/{% elif %}/{% else %}` with comparisons and `not` ·
✅ `{% for %}` with `loop.index/first/last/length` and `{% empty %}` · ✅ `{% include %}` ·
✅ `{% extends %}` + `{% block %}` layout inheritance, multi-level · ✅ `{# comments #}` ·
✅ **auto-escaping by default**, `| safe` to opt out · ✅ errors with template name and line

**Content** - ✅ collections from directory structure · ✅ tags/taxonomies with per-tag pages ·
✅ pagination · ✅ drafts · ✅ scheduled (future-dated) posts · ✅ heading slugs + TOC ·
✅ excerpts, word count, reading time

**Assets & output** - ✅ static copy with **content-hashed filenames** and reference rewriting ·
✅ conservative CSS + HTML minification · ✅ RSS + Atom · ✅ `sitemap.xml` · ✅ `robots.txt` ·
✅ per-tag pages · ✅ 404 page · ✅ client-side search index (JSON)

**Dev server** - ✅ file watching with debounce · ✅ live reload over **SSE** ·
✅ build errors shown as an in-page overlay · ✅ drafts visible · ✅ traversal-safe

**Example** - ✅ a real 6-post blog that actually builds

- ⬜ Responsive images - needs an image codec (a native dep unrelated to the lesson)
- ⬜ Incremental rebuilds - full rebuild is ~90ms here; see design.md
- ⬜ JS bundling, full YAML, syntax highlighting (the hook exists)

## Template syntax

```html
{% extends "base.html" %}

{% block content %}
  <h1>{{ page.title }}</h1>
  <time>{{ page.date | date:"MMMM DD, YYYY" }}</time>

  {% if page.tableOfContents %}{{ page.tocHtml | safe }}{% endif %}

  {% for post in posts %}
    <a href="{{ post.url }}">{{ post.title }}</a>
    <p>{{ post.excerpt | truncate:180 }}</p>
  {% empty %}
    <p>No posts yet.</p>
  {% endfor %}

  {{ page.content | safe }}   {# rendered Markdown is trusted; everything else is escaped #}
{% endblock %}
```

**Filters**: `safe` `escape` `upper` `lower` `capitalize` `trim` `length` `reverse` `join`
`first` `last` `default` `truncate` `slice` `date` `sort` `urlencode` `striptags` `json`.

## API reference

| Call | Description |
|---|---|
| `build(options)` | → `BuildResult` with `pages`, `outputs`, `timings`, `assetManifest` |
| `serve(options)` | → `DevServer` with `close()` and `rebuild()` |
| `new TemplateEngine({ loader, filters, autoescape })` | `render(name, ctx)`, `renderString(src, ctx)` |
| `loadContent`, `buildPage`, `organize`, `paginate` | The content pipeline |
| `copyAssets`, `minifyCss`, `minifyHtml`, `contentHash` | The asset pipeline |
| `renderRss`, `renderAtom`, `renderSitemap`, `buildSearchIndex` | Generated outputs |

CLI: `ssg build|serve [--root dir] [--port n] [--drafts] [--no-minify] [--deterministic]`.

## How it works

```
content/*.md ──► front matter ──► VENDORED markdown parser ──► PageData
                                                                  │
assets/* ──► hash + minify ──► manifest ────────────┐             │
                                                     ▼             ▼
templates/*.html ──► TEMPLATE ENGINE (tokenize → tree → render) ──► HTML
                                                     │
                                                     ├──► rewrite asset URLs
                                                     ├──► minify
                                                     └──► dist/
                                                            + feed.xml, atom.xml,
                                                              sitemap.xml, robots.txt,
                                                              404.html, search-index.json
```

Full reasoning - the vendoring decision, why the minifiers are conservative, why SSE beats
WebSockets for live reload, and how determinism is achieved - is in
[docs/design.md](docs/design.md).

## Design decisions & tradeoffs

- **Vendor, don't import.** Every project must stand alone. `VENDORED.md` records provenance
  and the re-sync command, which is what keeps vendoring from becoming a fork.
- **Auto-escaping on by default.** Templates render attacker-influenced data constantly; an
  engine that escapes only when asked has the default backwards.
- **Conservative minification.** Whitespace inside a CSS string, or between inline HTML
  elements, is *significant*. Saving 5% while corrupting one page in a hundred is a bad trade.
- **SSE for live reload.** One-directional channel, one-directional protocol. Project 07 does
  full WebSockets for when you need duplex.
- **Determinism is tested, not assumed.** Two builds, compared byte for byte.

## Benchmarks

The bundled 6-post blog, on this machine:

| Stage | Time |
|---|---|
| content (7 pages, Markdown → HTML) | 44 ms |
| pages (7 rendered) | 12 ms |
| taxonomies (7 tag pages) | 6 ms |
| feeds (6 files) | 5 ms |
| **total** | **~92 ms → 22 files, 52 KB** |

Most of the time is Markdown parsing, which is the expected shape. Two builds of this input
produce **byte-identical output** - asserted in the test suite.

## Known limitations

No responsive images, no incremental rebuilds, no JS bundling; front matter is a practical
YAML subset. See [docs/design.md](docs/design.md).

## Dependency justification

**Zero runtime dependencies.** The template engine, content pipeline, asset pipeline,
minifiers, feed generators, and dev server are all hand-written; the Markdown parser is a
vendored copy of project 08. Dev-only: `typescript`, `tsx`, `@types/node`. Deliberately
**not** used: `eleventy`, `hugo`, `jekyll`, `astro`, `nunjucks`, `liquidjs`, `handlebars`,
`ejs`, `marked`, `gray-matter`, `js-yaml`, `feed`, `chokidar`, `cssnano`, `html-minifier`,
`lunr`, `fuse.js`.
