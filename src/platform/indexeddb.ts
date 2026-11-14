import type { DeviceStore, KeptProject } from '../collab/kept';
import { refusalOf } from '../collab/refusals';

const DATABASE = 'keito-collab';
const PROJECTS = 'projects';

/** A copy as read back; null for none, or for anything not in the form it is written in. */
function copyOf(value: unknown): KeptProject | null {
  const v = value as Partial<KeptProject> | undefined;
  if (!(v?.state instanceof Uint8Array) || typeof v.editable !== 'boolean' || !(v.pending instanceof Map)) return null;
  const pending = new Map([...v.pending].filter(([op, update]) => typeof op === 'string' && update instanceof Uint8Array));
  return { state: v.state, pending, editable: v.editable, ...(typeof v.refusal === 'string' ? { refusal: refusalOf(v.refusal) } : {}) };
}

const result = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * This browser's IndexedDB as the device store of shared projects (one database for them all, a copy
 * per key). A write is done once it is on disk (durability 'strict'), not when the browser has it.
 * The browser is asked not to clear it to make room (persist), where it lets a page ask: an https or
 * localhost address.
 */
function indexedDBDevice(): DeviceStore {
  let opened: Promise<IDBDatabase> | null = null;
  function open(): Promise<IDBDatabase> {
    if (opened) return opened;
    void navigator.storage?.persist?.().catch(() => false);
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PROJECTS);
    opened = result(request).then(
      (db) => {
        // Not kept once the browser closes it (its storage cleared, a newer page upgrading it): every write would fail.
        db.onclose = () => void (opened = null);
        db.onversionchange = () => {
          db.close();
          opened = null;
        };
        return db;
      },
      (e: unknown) => {
        // Not kept failed: what blocked it (storage turned off for a while) may have passed by the next write.
        opened = null;
        throw e;
      },
    );
    return opened;
  }
  return {
    async load(key) {
      const db = await open();
      return copyOf(await result(db.transaction(PROJECTS, 'readonly').objectStore(PROJECTS).get(key)));
    },
    async change(key, edit) {
      const db = await open();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(PROJECTS, 'readwrite', { durability: 'strict' });
        let failure: unknown = null;
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(failure ?? tx.error ?? new DOMException('aborted', 'AbortError'));
        const projects = tx.objectStore(PROJECTS);
        const get = projects.get(key);
        get.onsuccess = () => {
          try {
            const next = edit(copyOf(get.result));
            if (next) projects.put(next, key);
            else projects.delete(key);
          } catch (e) {
            failure = e;
            tx.abort();
          }
        };
      });
    },
  };
}

/** Where this browser keeps shared projects; null outside a browser (no IndexedDB). */
export const browserDevice: DeviceStore | null = typeof indexedDB === 'undefined' ? null : indexedDBDevice();
