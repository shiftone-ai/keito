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

/** The project a shared address names, with the server and credential it carries (a join link's), if any. */
function readAddress(hash: string): { project: string; server: string | null; token: string | null } | null {
  const m = ADDRESS.exec(hash);
  if (!m) return null;
  const given = new URLSearchParams(m[2] ?? '');
  return { project: m[1], server: given.get('server'), token: given.get('token') };
}

/** Keep a shared project's server and credential in this browser: its address alone then opens it (see joinInAddress). */
export const keepJoin = ({ project, server, token }: SharedJoin): void => localStorage.setItem(kept(project), JSON.stringify({ server, token }));

/**
 * The shared project the address names (#/s/<project>), with what joins it. A join link carries the
 * server and the credential (#/s/<project>?server=…&token=…): they are kept in this browser and taken
 * off the address, so the credential is not left in the history; later the address alone opens it.
 * Null for any other address, or a project this browser was never given a link to.
 */
export function joinInAddress(): SharedJoin | null {
  const address = readAddress(location.hash);
  if (!address) return null;
  const { project, server, token } = address;
  if (server && token) {
    keepJoin({ project, server, token });
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

/**
 * The shared project of a join link pasted into the app (where there is no address to open it in:
 * the desktop app), with its server and credential. Null for text that is no join link, a project's
 * address without them among it.
 */
export function readJoinLink(text: string): SharedJoin | null {
  const at = text.indexOf('#');
  const address = at < 0 ? null : readAddress(text.slice(at).trim());
  if (!address?.server || !address.token) return null;
  return { project: address.project, server: address.server, token: address.token };
}
