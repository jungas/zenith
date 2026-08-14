/**
 * Static file serving, lifted from the old dev-only `tools/serve.ts` — same
 * containment and MIME logic, now shared by dev and the production container.
 */

import type { Stats } from 'node:fs';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves `pathname` from under `root`, containing every request inside it.
 * Returns `true` if it handled the request (including 403/404), `false` if
 * the caller should try something else.
 */
export function serveStatic(
  root: string,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  { cache = false }: { cache?: boolean } = {},
): boolean {
  let target = join(root, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(root)) {
    response.writeHead(403).end('Forbidden');
    return true;
  }

  let stats: Stats;
  try {
    stats = statSync(target);
    if (stats.isDirectory()) {
      target = join(target, 'index.html');
      stats = statSync(target);
    }
  } catch {
    return false;
  }

  const headers: Record<string, string | number> = {
    'Content-Type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stats.size,
    'Cache-Control': cache ? 'public, max-age=3600' : 'no-cache, no-store, must-revalidate',
    'Service-Worker-Allowed': '/',
  };

  if (request.method === 'HEAD') {
    response.writeHead(200, headers).end();
    return true;
  }

  response.writeHead(200, headers);
  createReadStream(target).pipe(response);
  return true;
}

/**
 * `index.html` is checked in backend-neutral, so a static host (GitHub Pages,
 * a double-clicked `file://`) falls back to localStorage on its own — see the
 * comment in the file itself. This server *does* have `/api/state`, so it
 * tells the client that by injecting one script into `<head>` before sending
 * it, rather than shipping a second copy of the file.
 */
export function serveIndexWithBackendFlag(root: string, request: IncomingMessage, response: ServerResponse): void {
  const source = readFileSync(join(root, 'index.html'), 'utf8');
  const flag = "<script>window.__ZENITH_BACKEND__ = 'server';</script>";
  const injected = source.includes('<head>') ? source.replace('<head>', `<head>\n    ${flag}`) : flag + source;
  const body = Buffer.from(injected, 'utf8');
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Service-Worker-Allowed': '/',
  };
  if (request.method === 'HEAD') {
    response.writeHead(200, headers).end();
    return;
  }
  response.writeHead(200, headers);
  response.end(body);
}
