# Vendored: markdown-parser (project 08)

This directory is a **copy** of project 08's `src/`, not an import.

## Why a copy

The portfolio's rule is that every project stands alone: you can lift one folder out of the
repo and it still builds and runs. An `import` across project boundaries would break that,
and would also couple this generator's release cadence to the parser's.

Duplication here is the deliberate choice, not an accident.

## Provenance

- Source: `projects/markdown-parser/src/`
- Vendored at: 2026-08-06
- Local modifications: **none** - this is a verbatim copy, which is what makes re-syncing
  a simple `cp -r`.

## Re-syncing

```bash
rm -rf src/vendor/markdown
cp -r ../markdown-parser/src src/vendor/markdown
```

The vendored parser's own tests live with the original project; this project's tests cover
how the generator *uses* it (front matter, heading slugs, TOC, code fences).
