# Design notes — Static Site Generator

## The vendoring decision

`src/vendor/markdown/` is a **verbatim copy** of project 08's `src/`, not an import.

The portfolio's rule is that every project stands alone: you can lift one folder out of the
repo and it still builds and runs. An `import "../markdown-parser/src"` breaks that
immediately, and also couples this generator's release cadence to the parser's.

So the duplication is the deliberate choice. `VENDORED.md` records the provenance, states
that there are no local modifications, and gives the one-line re-sync command — which is what
makes vendoring maintainable rather than a slow-motion fork.

## The template engine

Same architecture as the Markdown parser, for the same reason: **tokenize → tree → render**,
not regex substitution. `{% if %}` blocks nest, and a regex has no stack. A `{% for %}` inside
an `{% if %}` inside a `{% for %}` needs no special handling once you're walking a tree.

### Auto-escaping is the default

`{{ post.title }}` is escaped; `{{ post.title | safe }}` is not. Templates render
attacker-influenced data constantly — a title, a comment, a search query — and an engine that
escapes only when asked has the default exactly backwards. Being explicit about *unsafety* is
the whole point, and `| safe` makes that a visible decision at the call site.

`SafeString` is a branded wrapper rather than a plain string, so a value can't accidentally
look pre-escaped.

### Layout inheritance

`{% extends %}` walks the chain collecting blocks, child-wins, then renders the **root
parent**. Content outside a block in a child template is discarded — that is what makes
`{% extends %}` a layout rather than a concatenation, and it's asserted in a test.

Circular `extends` is detected rather than hanging.

### The loader is synchronous

`{% include %}` and `{% extends %}` resolve mid-render. Threading `async` through the renderer
would infect every node type — for a template engine reading small local files, that's a lot
of ceremony for no benefit. Stated here because it is a real constraint, not an oversight.

## Determinism

Two builds of the same input produce byte-identical output. There is a test that runs the
whole build twice into different directories and compares every file.

Three sources of non-determinism, each handled:

| Source | Fix |
|---|---|
| Timestamps (`<lastBuildDate>`) | The build clock is **injected**; `deterministic: true` pins it |
| Directory read order | Every list is explicitly sorted |
| `Map` iteration order | Tag names sorted before emitting tag pages |

A second test proves the determinism comes from pinning the clock rather than luck: two builds
with *different* injected clocks must differ, and only in the timestamp.

Why it matters: content-hashed filenames only work if identical content yields an identical
hash, which requires identical bytes. `style.4bc836f0.css` can be cached forever precisely
because a change produces a different name.

## The minifiers are conservative, on purpose

Both CSS and HTML minification are places where "collapse the whitespace" silently corrupts
output.

**CSS**: whitespace inside a string or `url()` is significant. `content: "a  b"` must keep its
two spaces. So string literals and `url()` contents are *stashed* before any transformation
and restored afterward.

**HTML**: worse, because whitespace between inline elements is **rendered**.
`<b>a</b> <i>b</i>` shows a space; removing it changes the page. So the minifier only collapses
whitespace runs that contain a newline — those came from source formatting — and never touches
`<pre>`, `<textarea>`, `<script>`, or `<style>`.

A minifier that saves 5% and corrupts one page in a hundred is a bad trade.

## Live reload over SSE, not WebSockets

Live reload is one-directional: the server says "reloaded", the browser refreshes.
Server-Sent Events is a plain `text/event-stream` HTTP response — no handshake, no framing,
no protocol to implement, and `EventSource` reconnects automatically. A WebSocket would be
strictly more machinery for a channel that never carries client→server traffic.

(Project 07 implements RFC 6455 in full, for when you genuinely need duplex.)

### Debouncing is not optional

Editors write in bursts: a single save can emit several `change` events, and some editors
write a temp file and rename over the target. Rebuilding per event means three builds per
save. A 100ms debounce coalesces the burst, and a `building`/`queued` pair ensures two builds
never overlap.

## Dev vs production builds

They differ deliberately:

| | Dev | Production |
|---|---|---|
| Drafts | included | excluded |
| Scheduled (future-dated) | included | excluded |
| Minification | off | on |
| Asset hashing | off | on |
| Caching | `no-store` | hashed names, cache forever |

You want to see what you're writing, and readable output when you view-source. Hashed
filenames in dev just make the URLs unstable for no benefit.

## The search index is a flat array, not an inverted index

For a blog with tens or low hundreds of posts, a linear scan in the browser is instant, and a
flat array is readable and trivially debuggable. An inverted index earns its complexity in the
thousands of documents.

The `bodyLimit` matters more than the structure: the index is downloaded by every visitor, so
capping body text is the difference between a 3 KB and a 300 KB download.

## What I skipped

- ⬜ **Responsive image handling** (generating multiple widths + `srcset`). It needs an image
  codec, which means a native dependency doing work unrelated to what this project teaches.
- ⬜ **Incremental rebuilds.** The dev server rebuilds everything on change. At this scale
  that's ~90ms, so a dependency graph would add real complexity for no felt benefit. It's the
  first thing to add if a site grows past a few hundred pages.
- ⬜ **JavaScript bundling.** A different project entirely.
- ⬜ **Full YAML front matter.** The vendored parser handles a practical subset (scalars,
  arrays, dates, booleans); full YAML is a famously large spec.
- ⬜ **Syntax highlighting.** The Markdown parser exposes a `highlight` hook; wiring a
  highlighter in is configuration, not construction.

## What production would add

Incremental rebuilds driven by a dependency graph; responsive image generation; a plugin API
around the build stages; i18n/multi-locale output; and a link checker that fails the build on
a dead internal link.
