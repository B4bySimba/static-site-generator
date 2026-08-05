/**
 * Generated outputs that aren't pages: RSS/Atom, sitemap.xml, robots.txt, and a client-side
 * search index.
 *
 * All the XML is built by hand, which means escaping is a real concern: a post title
 * containing `&` or `<` produces invalid XML that feed readers reject outright. XML has no
 * error recovery — unlike HTML, a malformed feed is simply not a feed.
 */

import type { PageData } from "./content.js";

export interface SiteConfig {
  title: string;
  description: string;
  /** Absolute base URL, no trailing slash, e.g. "https://example.com". */
  url: string;
  author?: string;
  language?: string;
}

/** XML's five predefined entities. Attributes need all of them; text needs the first three. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function absolute(site: SiteConfig, path: string): string {
  return site.url.replace(/\/$/, "") + (path.startsWith("/") ? path : "/" + path);
}

/** RSS 2.0. Dates must be RFC 822, which is why toUTCString is used rather than ISO. */
export function renderRss(site: SiteConfig, pages: PageData[], limit = 20, now = new Date()): string {
  const items = pages
    .filter((p) => p.date !== null)
    .slice(0, limit)
    .map((page) => {
      const link = absolute(site, page.url);
      return `    <item>
      <title>${escapeXml(page.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <pubDate>${(page.date as Date).toUTCString()}</pubDate>
      <description>${escapeXml(page.excerpt)}</description>
${page.tags.map((t) => `      <category>${escapeXml(t)}</category>`).join("\n")}
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(site.title)}</title>
    <link>${escapeXml(site.url)}</link>
    <description>${escapeXml(site.description)}</description>
    <language>${escapeXml(site.language ?? "en")}</language>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(absolute(site, "/feed.xml"))}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

/** Atom 1.0. Dates are RFC 3339 (ISO 8601) here — the opposite of RSS. */
export function renderAtom(site: SiteConfig, pages: PageData[], limit = 20, now = new Date()): string {
  const dated = pages.filter((p) => p.date !== null).slice(0, limit);
  const updated = dated[0]?.date?.toISOString() ?? now.toISOString();

  const entries = dated
    .map((page) => {
      const link = absolute(site, page.url);
      return `  <entry>
    <title>${escapeXml(page.title)}</title>
    <link href="${escapeXml(link)}"/>
    <id>${escapeXml(link)}</id>
    <updated>${(page.date as Date).toISOString()}</updated>
    <summary>${escapeXml(page.excerpt)}</summary>
${page.tags.map((t) => `    <category term="${escapeXml(t)}"/>`).join("\n")}
  </entry>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(site.title)}</title>
  <subtitle>${escapeXml(site.description)}</subtitle>
  <link href="${escapeXml(absolute(site, "/atom.xml"))}" rel="self"/>
  <link href="${escapeXml(site.url)}"/>
  <id>${escapeXml(site.url)}/</id>
  <updated>${updated}</updated>
${site.author ? `  <author><name>${escapeXml(site.author)}</name></author>` : ""}
${entries}
</feed>
`;
}

export function renderSitemap(site: SiteConfig, pages: PageData[]): string {
  const urls = pages
    .map((page) => {
      const lastmod = page.date ? `\n    <lastmod>${page.date.toISOString().slice(0, 10)}</lastmod>` : "";
      return `  <url>
    <loc>${escapeXml(absolute(site, page.url))}</loc>${lastmod}
  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export function renderRobots(site: SiteConfig): string {
  return `User-agent: *
Allow: /

Sitemap: ${absolute(site, "/sitemap.xml")}
`;
}

export interface SearchDocument {
  url: string;
  title: string;
  excerpt: string;
  tags: string[];
  /** Lowercased, de-punctuated body text for matching. */
  body: string;
}

/**
 * A client-side search index.
 *
 * Deliberately a flat array of documents rather than an inverted index: for a blog with tens
 * or low hundreds of posts, a linear scan in the browser is instant, and the index is
 * readable and trivially debuggable. An inverted index earns its complexity in the thousands.
 * The `bodyLimit` caps how much text ships, since the index is downloaded by every visitor.
 */
export function buildSearchIndex(pages: PageData[], bodyLimit = 2000): SearchDocument[] {
  return pages.map((page) => ({
    url: page.url,
    title: page.title,
    excerpt: page.excerpt,
    tags: page.tags,
    body: page.raw
      .replace(/```[\s\S]*?```/g, " ")   // code blocks add noise, not signal
      .replace(/[#*_`>[\]()!-]/g, " ")   // Markdown punctuation
      .replace(/\s+/g, " ")
      .toLowerCase()
      .trim()
      .slice(0, bodyLimit),
  }));
}

/** A minimal 404 page, so the dev server and most hosts have something to serve. */
export function render404(site: SiteConfig): string {
  return `<!doctype html>
<html lang="${escapeXml(site.language ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found — ${escapeXml(site.title)}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 40rem; margin: 15vh auto; padding: 0 1.5rem; }
  h1 { font-size: 3rem; margin: 0; }
  p { color: #555; }
  a { color: #2a78d6; }
</style>
</head>
<body>
  <h1>404</h1>
  <p>That page doesn't exist.</p>
  <p><a href="/">Back to ${escapeXml(site.title)}</a></p>
</body>
</html>
`;
}
