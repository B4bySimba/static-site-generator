#!/usr/bin/env node
/**
 * CLI: `build` and `serve`.
 *
 *   ssg build [--drafts] [--no-minify] [--deterministic]
 *   ssg serve [--port 4321]
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build, formatBytes } from "./build.js";
import { serve } from "./serve.js";
import type { SiteConfig } from "./feeds.js";

interface Config {
  site: SiteConfig;
  contentDir: string;
  templateDir: string;
  assetDir: string;
  outputDir: string;
  postsPerPage?: number;
}

function loadConfig(root: string): Config {
  const path = join(root, "site.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`No site.json found in ${root}`);
  }
  const parsed = JSON.parse(raw) as Partial<Config> & { site?: SiteConfig };

  return {
    site: parsed.site ?? { title: "Site", description: "", url: "http://localhost:4321" },
    contentDir: resolve(root, parsed.contentDir ?? "content"),
    templateDir: resolve(root, parsed.templateDir ?? "templates"),
    assetDir: resolve(root, parsed.assetDir ?? "assets"),
    outputDir: resolve(root, parsed.outputDir ?? "dist"),
    ...(parsed.postsPerPage !== undefined ? { postsPerPage: parsed.postsPerPage } : {}),
  };
}

const out = (s = "") => process.stdout.write(s + "\n");

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const flag = (name: string): boolean => args.includes(`--${name}`);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };

  const root = resolve(value("root") ?? process.cwd());

  switch (command) {
    case "build": {
      const config = loadConfig(root);
      const result = await build({
        ...config,
        includeDrafts: flag("drafts"),
        includeScheduled: flag("scheduled"),
        minify: !flag("no-minify"),
        deterministic: flag("deterministic"),
      });

      out("");
      for (const timing of result.timings) {
        out(`  ${timing.name.padEnd(12)} ${timing.ms.toFixed(1).padStart(7)} ms   ${timing.detail}`);
      }
      const bytes = [...result.outputs.values()].reduce((a, b) => a + b, 0);
      out(`  ${"─".repeat(46)}`);
      out(`  ${"total".padEnd(12)} ${result.totalMs.toFixed(1).padStart(7)} ms   ${result.outputs.size} files, ${formatBytes(bytes)}`);
      out("");
      return 0;
    }

    case "serve": {
      const config = loadConfig(root);
      const server = await serve({
        ...config,
        port: Number(value("port") ?? 4321),
        onRebuild: (result, ms) => {
          if (result instanceof Error) out(`  ✗ build failed in ${ms}ms: ${result.message}`);
          else out(`  ✓ rebuilt ${result.outputs.size} files in ${ms}ms`);
        },
      });

      out(`\n  Dev server on http://localhost:${server.port}`);
      out(`  Watching content, templates, and assets. Ctrl-C to stop.\n`);

      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
          void server.close().then(() => process.exit(0));
        });
      }
      return -1; // keep running
    }

    default:
      out(`ssg - a static site generator

Usage:
  ssg build [options]     Build the site into dist/
  ssg serve [options]     Dev server with watch and live reload

Options:
  --root <dir>       Project root (default: cwd)
  --port <n>         Dev server port (default: 4321)
  --drafts           Include pages marked draft: true
  --scheduled        Include future-dated pages
  --no-minify        Skip CSS/HTML minification
  --deterministic    Pin the build clock for byte-stable output
`);
      return command === "help" ? 0 : 1;
  }
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((err: unknown) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
