/**
 * The development server: static file serving, file watching, incremental rebuilds, and live
 * reload over Server-Sent Events.
 *
 * ## Why SSE and not WebSockets
 *
 * Live reload is one-directional: the server says "reloaded", the browser refreshes. SSE is
 * a plain `text/event-stream` HTTP response - no handshake, no framing, no protocol
 * implementation, and automatic reconnection is built into `EventSource`. A WebSocket would
 * be strictly more machinery for a channel that never carries client→server traffic.
 * (Project 07 implements RFC 6455 in full, for when you genuinely need duplex.)
 *
 * ## Debouncing
 *
 * Editors write files in bursts - a save can produce several `change` events, and some write
 * a temp file and rename over the target. Rebuilding per event means rebuilding three times
 * per keystroke-save. A short debounce coalesces the burst into one rebuild.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { build, type BuildOptions, type BuildResult } from "./build.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Injected into every HTML response in dev; never written to disk. */
const LIVE_RELOAD_SCRIPT = `
<script>
(() => {
  const source = new EventSource("/__livereload");
  source.addEventListener("reload", () => location.reload());
  source.addEventListener("error", () => {
    // EventSource reconnects on its own; this only reports a build failure.
  });
  source.addEventListener("buildError", (event) => {
    const banner = document.getElementById("__build_error") || (() => {
      const el = document.createElement("pre");
      el.id = "__build_error";
      el.style.cssText = "position:fixed;inset:0;z-index:99999;margin:0;padding:2rem;" +
        "background:#1a1a19;color:#e66767;font:13px/1.6 ui-monospace,monospace;" +
        "white-space:pre-wrap;overflow:auto";
      document.body.appendChild(el);
      return el;
    })();
    banner.textContent = "Build failed\\n\\n" + JSON.parse(event.data);
  });
})();
</script>
`;

export interface ServeOptions extends BuildOptions {
  port?: number;
  host?: string;
  /** Milliseconds to coalesce filesystem events. */
  debounceMs?: number;
  /** Directories to watch. Defaults to content, templates, and assets. */
  watchDirs?: string[];
  onRebuild?: (result: BuildResult | Error, ms: number) => void;
}

export interface DevServer {
  server: Server;
  port: number;
  close(): Promise<void>;
  /** Force a rebuild (used by tests). */
  rebuild(): Promise<void>;
}

export async function serve(options: ServeOptions): Promise<DevServer> {
  const port = options.port ?? 4321;
  const host = options.host ?? "127.0.0.1";
  const debounceMs = options.debounceMs ?? 100;

  // Dev builds include drafts and scheduled posts, and skip minification - you want to see
  // what you are writing, and readable output when you view-source.
  const devOptions: BuildOptions = {
    ...options,
    includeDrafts: options.includeDrafts ?? true,
    includeScheduled: options.includeScheduled ?? true,
    minify: options.minify ?? false,
    hashAssets: options.hashAssets ?? false,
  };

  let lastError: Error | null = null;
  const clients = new Set<ServerResponse>();

  const runBuild = async (): Promise<void> => {
    const start = Date.now();
    try {
      const result = await build(devOptions);
      lastError = null;
      options.onRebuild?.(result, Date.now() - start);
      broadcast("reload", "");
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      options.onRebuild?.(lastError, Date.now() - start);
      broadcast("buildError", JSON.stringify(lastError.message));
    }
  };

  function broadcast(event: string, data: string): void {
    for (const client of clients) {
      try {
        client.write(`event: ${event}\ndata: ${data}\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  }

  await runBuild();

  const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal error");
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    // The live-reload channel.
    if (url.pathname === "/__livereload") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 1000\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    // Resolve the path, refusing anything that escapes the output directory.
    const root = resolve(devOptions.outputDir);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";

    let filePath = normalize(join(root, pathname));
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    // Extensionless URLs get /index.html, matching how static hosts behave.
    if (extname(filePath) === "") {
      filePath = join(filePath, "index.html");
    }

    let data: Buffer;
    try {
      data = await fs.readFile(filePath);
    } catch {
      // Fall back to the generated 404 page.
      try {
        data = await fs.readFile(join(root, "404.html"));
        res.statusCode = 404;
      } catch {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("404 Not Found");
        return;
      }
    }

    const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.setHeader("Content-Type", type);
    // Never cache in dev, or you spend an afternoon debugging a stale file.
    res.setHeader("Cache-Control", "no-store, must-revalidate");

    if (type.startsWith("text/html")) {
      let html = data.toString("utf8");
      if (lastError) {
        html = html.replace(
          "</body>",
          `<pre style="position:fixed;inset:0;z-index:99999;margin:0;padding:2rem;background:#1a1a19;color:#e66767;font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow:auto">Build failed\n\n${escapeForHtml(lastError.message)}</pre></body>`,
        );
      }
      html = html.includes("</body>")
        ? html.replace("</body>", `${LIVE_RELOAD_SCRIPT}</body>`)
        : html + LIVE_RELOAD_SCRIPT;
      res.end(html);
      return;
    }

    res.end(data);
  }

  await new Promise<void>((resolveListen) => server.listen(port, host, resolveListen));

  // --- Watching ------------------------------------------------------------
  const watchDirs = options.watchDirs ?? [options.contentDir, options.templateDir, options.assetDir];
  const watchers: FSWatcher[] = [];
  let debounceTimer: NodeJS.Timeout | undefined;
  let building = false;
  let queued = false;

  const scheduleRebuild = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void (async () => {
        // Never run two builds at once; if changes land mid-build, run once more after.
        if (building) {
          queued = true;
          return;
        }
        building = true;
        await runBuild();
        building = false;
        if (queued) {
          queued = false;
          scheduleRebuild();
        }
      })();
    }, debounceMs);
    debounceTimer.unref?.();
  };

  for (const dir of watchDirs) {
    try {
      const watcher = watch(dir, { recursive: true }, scheduleRebuild);
      watchers.push(watcher);
    } catch {
      // A missing directory is not fatal - a site may have no assets.
    }
  }

  return {
    server,
    port,
    async close(): Promise<void> {
      for (const watcher of watchers) watcher.close();
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolveClose, reject) =>
        server.close((err) => (err ? reject(err) : resolveClose())),
      );
    },
    rebuild: runBuild,
  };
}

function escapeForHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
