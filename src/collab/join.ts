import type { SharedJoin } from './client';

const kept = (project: string): string => `keito:collab:${project}`;
const ADDRESS = /^#\/s\/([\w-]+)(?:\?(.*))?$/;

/** The address (hash) that opens a shared project. */
export const sharedAddress = (project: string): string => `#/s/${project}`;

/** Put a shared project's address in the URL, in place of the one there (no new history entry). */
export function showSharedAddress(project: string): void {
  const address = sharedAddress(project);
  if (location.hash !== address) history.replaceState(null, '', `${location.pathname}${location.search}${address}`);
}

/**
 * The shared project the address names (#/s/<project>), with what joins it. A join link carries the
 * server and the credential (#/s/<project>?server=…&token=…): they are kept in this browser and taken
 * off the address, so the credential is not left in the history; later the address alone opens it.
 * Null for any other address, or a project this browser was never given a link to.
 */
export function joinInAddress(): SharedJoin | null {
  const m = ADDRESS.exec(location.hash);
  if (!m) return null;
  const [, project, query] = m;
  const given = new URLSearchParams(query ?? '');
  const server = given.get('server');
  const token = given.get('token');
  if (server && token) {
    localStorage.setItem(kept(project), JSON.stringify({ server, token }));
    showSharedAddress(project);
  }
  try {
    const v: unknown = JSON.parse(localStorage.getItem(kept(project)) ?? 'null');
    const join = v as Partial<SharedJoin> | null;
    return typeof join?.server === 'string' && typeof join.token === 'string' ? { project, server: join.server, token: join.token } : null;
  } catch {
    return null;
  }
}
