import type { PictureBody, PictureDevice } from '../collab/pictures';

const DATABASE = 'keito-pictures';
/** Every picture kept, by key. */
const BODIES = 'bodies';
/** The keys of the pictures still to be sent. */
const UNSENT = 'unsent';

const result = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** A picture as read back; null for none, or for anything not in the form it is written in. */
function bodyOf(value: unknown): PictureBody | null {
  const v = value as Partial<PictureBody> | undefined;
  return v?.bytes instanceof Uint8Array && typeof v.type === 'string' ? { bytes: v.bytes, type: v.type } : null;
}

/**
 * This browser's IndexedDB as the device store of the pictures of shared projects: a database of
 * their own, apart from the projects' copies (see indexeddb.ts). A write is done once it is on disk
 * (durability 'strict'), not when the browser has it.
 */
function indexedDBPictures(): PictureDevice {
  let opened: Promise<IDBDatabase> | null = null;
  function open(): Promise<IDBDatabase> {
    if (opened) return opened;
    void navigator.storage?.persist?.().catch(() => false);
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(BODIES);
      request.result.createObjectStore(UNSENT);
    };
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

  /** Write to the stores named, as one transaction done once on disk. */
  async function write(stores: string[], work: (tx: IDBTransaction) => void): Promise<void> {
    const db = await open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite', { durability: 'strict' });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new DOMException('aborted', 'AbortError'));
      work(tx);
    });
  }

  return {
    async load(key) {
      const db = await open();
      return bodyOf(await result(db.transaction(BODIES, 'readonly').objectStore(BODIES).get(key)));
    },
    keep: (key, body, unsent) =>
      write([BODIES, UNSENT], (tx) => {
        tx.objectStore(BODIES).put({ bytes: body.bytes, type: body.type }, key);
        if (unsent) tx.objectStore(UNSENT).put(true, key);
      }),
    sent: (key) => write([UNSENT], (tx) => tx.objectStore(UNSENT).delete(key)),
    async unsent(prefix) {
      const db = await open();
      const keys = await result(db.transaction(UNSENT, 'readonly').objectStore(UNSENT).getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)));
      return keys.map(String);
    },
  };
}

/** Where this browser keeps the pictures of shared projects; null outside a browser (no IndexedDB). */
export const browserPictures: PictureDevice | null = typeof indexedDB === 'undefined' ? null : indexedDBPictures();
