/**
 * The copy of a shared project kept on this device, so that the project opens again after a reload,
 * a restart or offline, with the edits made here that the server has not confirmed. Where it is kept
 * is the platform's (see DeviceStore); what is kept, and when it is written, is this module's.
 */
import * as Y from 'yjs';
import { isQuotaError } from '../platform/storage';

/** A shared project as this device keeps it. */
export interface KeptProject {
  /** The project's Yjs state as this device holds it, its edits not yet confirmed included. */
  state: Uint8Array;
  /** This device's edits the server has not confirmed stored, oldest first, by op id (as committed). */
  pending: Map<string, Uint8Array>;
  /**
   * Whether the server let this device edit the project (false once it turned it away). Once false,
   * the copy is left as it is, its unconfirmed edits unsent.
   */
  editable: boolean;
}

/**
 * Where this device keeps its copies of shared projects, by key. `change` hands `edit` the copy kept
 * now and writes what it returns, as one write that no other page's change of the same key comes
 * between; it rejects when the write fails (the device full, its storage blocked).
 */
export interface DeviceStore {
  load(key: string): Promise<KeptProject | null>;
  change(key: string, edit: (kept: KeptProject | null) => KeptProject): Promise<void>;
}

/**
 * Whether what this page holds is kept on the device: `saved`, as it is now; `saving`, a write under
 * way; `failed`, the last write failed (and what is not confirmed lives only in this page);
 * `none`, this page keeps nothing (no device store).
 */
export type DeviceState = 'saved' | 'saving' | 'failed' | 'none';

/** What this page holds of the project, to be kept. */
type Held = Pick<KeptProject, 'state' | 'pending'>;

/** A failure to write as the user is told it. */
function reasonOf(e: unknown): string {
  if (isQuotaError(e)) return '端末の空き容量が足りません';
  return e instanceof Error ? e.message || e.name : String(e);
}

/**
 * What is kept once this page's `held` is written over `kept`. Another page of the project on this
 * device may have written its own edits there: they are kept beside this page's, not written over;
 * and a page the server turned away has the copy stay so, whatever a page still open writes after.
 */
function merged(kept: KeptProject | null, held: Held, editable: boolean, confirmed: Set<string>): KeptProject {
  const pending = new Map([...(kept?.pending ?? [])].filter(([op]) => !confirmed.has(op)));
  for (const [op, update] of held.pending) pending.set(op, update);
  return {
    state: kept ? Y.mergeUpdates([kept.state, held.state]) : held.state,
    pending,
    editable: (kept?.editable ?? true) && editable,
  };
}

/**
 * Keep the project `key` on the device as this page holds it (`hold` reads that). Each `changed`
 * writes it again, one write at a time: changes made during a write go in the next one. A failed
 * write stays failed until one succeeds: the next change tries again. `notify` is called whenever
 * `state` changes.
 */
export function keepCopy(device: DeviceStore | null, key: string, hold: () => Held, notify: () => void) {
  let store = device;
  let state: DeviceState = store ? 'saved' : 'none';
  let failure: string | null = null;
  let writing = false;
  let dirty = false;
  /** Whether the server lets this page edit the project, as far as this page has heard. */
  let editable = true;
  /** Ops confirmed here, to be taken out of the copy by the next write. */
  const confirmed = new Set<string>();
  /** What this page held when it stopped: written in place of what it holds no more. */
  let last: Held | null = null;

  async function write(): Promise<void> {
    if (!store) return;
    writing = true;
    dirty = false;
    const held = last ?? hold();
    const gone = new Set(confirmed);
    try {
      await store.change(key, (kept) => merged(kept, held, editable, gone));
      gone.forEach((op) => confirmed.delete(op));
      if (!dirty) [state, failure] = ['saved', null];
    } catch (e) {
      [state, failure] = ['failed', reasonOf(e)];
    }
    writing = false;
    if (dirty) void write();
    notify();
  }

  function changed(): void {
    if (!store) return;
    dirty = true;
    if (writing) return;
    // Not said to be saving while failed: it is not kept until a write succeeds.
    if (state !== 'failed') state = 'saving';
    void write();
  }

  return {
    /**
     * The copy kept on the device, to open the project from; null for none, for one that cannot be
     * read, and for one the server turned away. That one is left as it is, its edits unsent: this page
     * keeps no copy, and only the server, answering again, says whether this device may edit.
     */
    async load(): Promise<KeptProject | null> {
      let kept: KeptProject | null;
      try {
        kept = (await store?.load(key)) ?? null;
      } catch (e) {
        [state, failure] = ['failed', reasonOf(e)];
        return null;
      }
      if (kept?.editable) return kept;
      if (kept) [store, state] = [null, 'none'];
      return null;
    },
    changed,
    /**
     * The server turned this page away: the copy is kept as one not to open again (see load), so
     * that edits the server refused are not taken offline either.
     */
    refused(): void {
      editable = false;
      changed();
    },
    /** An op the server confirmed stored: it leaves the copy. */
    confirmed(op: string): void {
      confirmed.add(op);
      changed();
    },
    state: (): DeviceState => state,
    failure: (): string | null => failure,
    /** Write what this page holds once more, as it is now, and nothing after. */
    stop(): void {
      if (last) return;
      last = hold();
      changed();
    },
  };
}
