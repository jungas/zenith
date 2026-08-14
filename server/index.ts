/**
 * Zenith's server: static files plus the `/api/state` blob, in one process.
 *
 * Routing is entirely `#hash`-based on the client (see `src/router.ts`), so
 * there is no history-mode fallback to do here — every real path either is a
 * file under the repo root or is a 404.
 *
 * Run directly as TypeScript — Node strips the types, same as the old
 * `tools/serve.ts` this replaces.
 */

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StateStore } from './db.ts';
import { handleApi } from './api.ts';
import { serveStatic, serveIndexWithBackendFlag } from './static.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = resolve(ROOT, process.env.DATA_DIR || 'data');
const DB_PATH = resolve(DATA_DIR, 'zenith.db');

const store = new StateStore(DB_PATH);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    handleApi(store, request, response, pathname).then((handled) => {
      if (!handled) response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }, (error: unknown) => {
      console.error('API request failed', error);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Server error');
    });
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end('Method not allowed');
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    serveIndexWithBackendFlag(ROOT, request, response);
    return;
  }

  const handled = serveStatic(ROOT, pathname, request, response);
  if (!handled) response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Zenith running at http://${HOST}:${PORT}`);
  console.log(`Data stored at ${DB_PATH}`);
  console.log('Press Ctrl+C to stop.');
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
