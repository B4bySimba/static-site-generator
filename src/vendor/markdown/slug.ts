/**
 * Heading slugs for anchor links, using GitHub's algorithm: lowercase, strip anything that
 * isn't a word character/space/hyphen, then spaces to hyphens.
 *
 * Duplicates get a numeric suffix (`overview`, `overview-1`, `overview-2`), which is why a
 * counter has to be threaded through the parse - slug uniqueness is a document-level
 * property, not a per-heading one.
 */

export type SlugCounter = Map<string, number>;

export function createSlugCounter(): SlugCounter {
  return new Map();
}

export function slugify(text: string, counter?: SlugCounter): string {
  const base =
    text
      .trim()
      .toLowerCase()
      // Drop inline markup characters so "## `code` heading" slugs cleanly.
      .replace(/[*_`~]/g, "")
      // Keep letters (including non-ASCII), digits, spaces and hyphens.
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "section";

  if (!counter) return base;

  const seen = counter.get(base) ?? 0;
  counter.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}
