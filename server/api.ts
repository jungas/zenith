/**
 * The whole API: two routes, because the client still deals in one state
 * blob. `GET` reads it, `PUT` replaces it under an optimistic-concurrency
 * check — see `server/db.ts` for why a version travels with every save.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StateStore } from './db.ts';

/** A request body larger than this is rejected before it is parsed. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Handles `/api/*`. Returns `true` if it handled the request, `false` if the
 * path is not one of ours (so the caller can 404 it).
 */
export async function handleApi(
  store: StateStore,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/api/health') {
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/state' && request.method === 'GET') {
    const row = store.read();
    sendJson(response, 200, {
      version: row?.version ?? 0,
      data: row ? JSON.parse(row.data) : null,
    });
    return true;
  }

  if (pathname === '/api/state' && request.method === 'PUT') {
    let body: { version?: unknown; data?: unknown };
    try {
      body = JSON.parse(await readBody(request));
    } catch {
      sendJson(response, 400, { error: 'Malformed JSON body' });
      return true;
    }
    if (typeof body.version !== 'number' || body.data === undefined) {
      sendJson(response, 400, { error: 'Expected { version: number, data: object }' });
      return true;
    }

    const result = store.write(JSON.stringify(body.data), body.version);
    if (!result.ok) {
      sendJson(response, 409, {
        error: 'Saved elsewhere since you last loaded — reload to see the latest.',
        version: result.current.version,
        data: JSON.parse(result.current.data),
      });
      return true;
    }
    sendJson(response, 200, { version: result.version });
    return true;
  }

  return false;
}
