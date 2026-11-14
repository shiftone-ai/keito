import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_PICTURE_BYTES, hashOf, pictureOfPath, typeOf } from '../../src/collab/pictureRef';
import { type Denial, type Need, authenticate, authorize } from './access';
import type { PictureStore } from './pictureStore';
import type { CollabStore } from './store';

/** What a project id must look like to be made a folder of (the ids `initProject` gives are UUIDs). */
const PROJECT = /^[A-Za-z0-9_-]{1,80}$/;

/** Why a request is answered with an error, as its JSON body says. */
type Failure = 'malformed' | 'mismatch' | 'too-large' | 'missing' | 'method' | 'failed';

// Any page may ask: an invite's secret, not the page's origin, is what lets a request in.
const CORS = { 'Access-Control-Allow-Origin': '*' };

function answer(response: ServerResponse, status: number, reason?: Failure | Denial): void {
  response.writeHead(status, { ...CORS, ...(reason ? { 'Content-Type': 'application/json' } : {}) });
  response.end(reason ? JSON.stringify({ reason }) : undefined);
}

/** The secret of `Authorization: Bearer <secret>`, or '' for none. */
const secretOf = (request: IncomingMessage): string => /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';

/** The body of a request, or null once it is larger than `limit`. */
async function bodyOf(request: IncomingMessage, limit: number): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The pictures of the shared projects over HTTP, on the collaboration server's own port: GET and PUT
 * `…/pictures/<project>/<name>` (see pictureAddress) with `Authorization: Bearer <invite secret>`.
 * Each request is let through by the one check every way into a project makes (access.ts): an
 * invite that may see the project, to fetch a picture of it, or change it, to send one. A picture is
 * looked for in the project asked for only, so the name of another project's picture, or a guessed
 * one, finds nothing without an invite to that project. Sent bytes are kept only under the name they
 * hash to. `arrived` is told of each picture newly kept. Resolves to whether the request was one for
 * a picture (and so answered).
 */
export function pictureRoutes(store: CollabStore, pictures: PictureStore, arrived: (project: string, name: string) => void) {
  /** The invite that may do `need` with `project`, or the denial answered. */
  function admit(request: IncomingMessage, response: ServerResponse, project: string, name: string, need: Need): boolean {
    const access = authorize(store, authenticate(store, secretOf(request)), project, need);
    if (access.ok) return true;
    console.warn(`[keito-collab] ${project}: picture ${name} refused (${access.denial})`);
    answer(response, 403, access.denial);
    return false;
  }

  async function put(request: IncomingMessage, response: ServerResponse, project: string, name: string): Promise<void> {
    if (Number(request.headers['content-length'] ?? 0) > MAX_PICTURE_BYTES) return answer(response, 413, 'too-large');
    const bytes = await bodyOf(request, MAX_PICTURE_BYTES);
    if (!bytes) {
      answer(response, 413, 'too-large');
      return void request.destroy();
    }
    if (createHash('sha256').update(bytes).digest('hex').slice(0, 24) !== hashOf(name)) return answer(response, 400, 'mismatch');
    // Checked again once the bytes are in: an invite revoked while they came keeps nothing.
    if (!admit(request, response, project, name, 'edit')) return;
    if ((await pictures.put(project, name, bytes)) === 'stored') arrived(project, name);
    answer(response, 204);
  }

  async function get(response: ServerResponse, project: string, name: string): Promise<void> {
    const bytes = await pictures.get(project, name);
    if (!bytes) return answer(response, 404, 'missing');
    response.writeHead(200, {
      ...CORS,
      'Content-Type': typeOf(name),
      'Content-Length': bytes.length,
      // The app keeps its own copy: a browser's cache would keep one beyond a revoke.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // Opened on its own (an SVG), it runs nothing.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    response.end(bytes);
  }

  return async function route(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const picture = pictureOfPath(new URL(request.url ?? '/', 'http://picture').pathname);
    if (!picture) return false;
    const { project, name } = picture;
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET, PUT', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
        response.end();
        return true;
      }
      if (request.method !== 'GET' && request.method !== 'PUT') {
        answer(response, 405, 'method');
        return true;
      }
      if (!PROJECT.test(project) || !hashOf(name)) {
        answer(response, 400, 'malformed');
        return true;
      }
      if (!admit(request, response, project, name, request.method === 'PUT' ? 'edit' : 'view')) return true;
      await (request.method === 'PUT' ? put(request, response, project, name) : get(response, project, name));
    } catch (e) {
      console.error(`[keito-collab] ${project}: picture ${name} not ${request.method === 'PUT' ? 'stored' : 'read'}: ${e instanceof Error ? e.message : String(e)}`);
      if (!response.headersSent) answer(response, 500, 'failed');
      else response.destroy();
    }
    return true;
  };
}
