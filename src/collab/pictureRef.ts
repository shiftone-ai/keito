/**
 * How a shared board refers to a picture, and where the picture's bytes are sent and fetched: what
 * the app (see pictures.ts), the collaboration server (see server/collab/pictureRoutes.ts), and
 * whatever moves a board's pictures into a shared project or out into an export, agree on.
 *
 * An image node of a shared board holds `shared:<name>` as its `src`, never the picture itself. The
 * name is the one assetOf (platform/storage.ts) gives the picture's bytes: the first 12 bytes of
 * their SHA-256 in hex and the kind of picture, which is also the name a board's folder on this
 * machine keeps the same picture under (its node's `asset:<name>`): one picture has one name on this
 * machine and in every shared project, and the bytes fetched by it are those it was made from. The
 * server keeps the bytes per project and gives them only to an invite to that project.
 */

const SHARED_PICTURE = 'shared:';

/** The kinds of picture a shared project keeps, by the extension of their names, as each is served. */
const PICTURE_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

const NAME = /^([0-9a-f]{24})\.(png|jpg|gif|webp|svg)$/;

/** The largest picture the server takes, as large as a board's folder on this machine takes. */
export const MAX_PICTURE_BYTES = 64 * 1024 * 1024;

export const isPictureName = (name: string): boolean => NAME.test(name);

/** The hash part of a picture's name (what its bytes must hash to), or null for no picture's name. */
export const hashOf = (name: string): string | null => NAME.exec(name)?.[1] ?? null;

/** The type a picture is served as, by its name. */
export const typeOf = (name: string): string => PICTURE_TYPES[NAME.exec(name)?.[2] ?? ''] ?? 'application/octet-stream';

export const sharedSrc = (name: string): string => SHARED_PICTURE + name;

/** The name of the picture a source refers to, or null for a source that is not a shared project's picture. */
export function sharedName(src: string): string | null {
  if (!src.startsWith(SHARED_PICTURE)) return null;
  const name = src.slice(SHARED_PICTURE.length);
  return isPictureName(name) ? name : null;
}

export const isSharedSrc = (v: unknown): v is string => typeof v === 'string' && sharedName(v) !== null;

/** Where a picture of a project is sent and fetched over HTTP: on the collaboration server's own address (ws:// as http://, wss:// as https://). */
export function pictureAddress(server: string, project: string, name: string): string {
  const url = new URL(server);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/pictures/${encodeURIComponent(project)}/${encodeURIComponent(name)}`;
  url.search = '';
  url.hash = '';
  return url.href;
}

/** The project and name a request for a picture asks for (see pictureAddress); null for a path that is no picture's. */
export function pictureOfPath(path: string): { project: string; name: string } | null {
  const m = /\/pictures\/([^/]+)\/([^/]+)$/.exec(path);
  if (!m) return null;
  try {
    return { project: decodeURIComponent(m[1]), name: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}
