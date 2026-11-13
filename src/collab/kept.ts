/**
 * The copy of a shared project kept on this device, so that the project opens again after a reload,
 * a restart or offline, with the edits made here that the server has not confirmed. Where it is kept
 * is the platform's (see DeviceStore); what is kept, and when it is written, is this module's.
 */
import * as Y from 'yjs';
import { isQuotaError } from '../platform/storage';
import type { LinkRefusal } from './refusals';

/** A shared project as this device keeps it. */
export interface KeptProject {
  /** The project's Yjs state as this device holds it, its edits not yet confirmed included. */
  state: Uint8Array;
  /** This device's edits the server has not confirmed stored, oldest first, by op id (as committed). */
  pending: Map<string, Uint8Array>;
  /**
   * Whether the server let this device edit the project (false once it turned it away). Once false,
   * the copy is left as it is, its unconfirmed edits unsent, for the user to take out or let go.
   */
  editable: boolean;
  /** Why the server turned the device away (see client.ts), while `editable` is false; absent in a copy turned away before it was kept. */
  refusal?: LinkRefusal;
}

/**
 * Where this device keeps its copies of shared projects, by key. `change` hands `edit` the copy kept
 * now and writes what it returns (null takes the copy off the device), as one write that no other
 * page's change of the same key comes between; it rejects when the write fails (the device full, its
 * storage blocked).
 */
export interface DeviceStore {
  load(key: string): Promise<KeptProject | null>;
  change(key: string, edit: (kept: KeptProject | null) => KeptProject | null): Promise<void>;
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
 * What is kept once this page's `held` is written over `kept`; null for nothing. Another page of the
 * project on this device may have written its own edits there: they are kept beside this page's, not
 * written over; and a page the server turned away (`refusal`) has the copy stay so, whatever a page
 * still open writes after, as long as it holds an edit not sent.
 */
function merged(kept: KeptProject | null, held: Held, refusal: LinkRefusal | null, confirmed: Set<string>): KeptProject | null {
  const pending = new Map([...(kept?.pending ?? [])].filter(([op]) => !confirmed.has(op)));
  for (const [op, update] of held.pending) pending.set(op, update);
  const editable = (kept?.editable ?? true) && !refusal;
  // Not kept turned away with nothing unsent: there is nothing in it to take out, and kept it would keep this device from keeping the project once let in again.
  if (!editable && !pending.size) return null;
  const state = kept ? Y.mergeUpdates([kept.state, held.state]) : held.state;
  return editable ? { state, pending, editable } : { state, pending, editable, refusal: refusal ?? kept?.refusal };
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
  let writing: Promise<void> | null = null;
  let dirty = false;
  /** Why the server turned this page away; null while it lets this page edit, as far as this page has heard. */
  let refusal: LinkRefusal | null = null;
  /** Ops confirmed here, to be taken out of the copy by the next write. */
  const confirmed = new Set<string>();
  /** What this page held when it stopped: written in place of what it holds no more. */
  let last: Held | null = null;

  async function write(): Promise<void> {
    if (!store) return;
    dirty = false;
    const held = last ?? hold();
    const gone = new Set(confirmed);
    let kept = true;
    try {
      await store.change(key, (copy) => {
        const next = merged(copy, held, refusal, gone);
        kept = !!next;
        return next;
      });
      gone.forEach((op) => confirmed.delete(op));
      if (!kept) [store, state, failure] = [null, 'none', null];
      else if (!dirty) [state, failure] = ['saved', null];
    } catch (e) {
      [state, failure] = ['failed', reasonOf(e)];
    }
    writing = dirty && store ? write() : null;
    notify();
  }

  function changed(): void {
    if (!store) return;
    dirty = true;
    if (writing) return;
    // Not said to be saving while failed: it is not kept until a write succeeds.
    if (state !== 'failed') state = 'saving';
    writing = write();
  }

  return {
    /**
     * The copy kept on the device, to open the project from; null for none, and for one that cannot
     * be read. A copy the server turned away comes back as it is (`editable` false), its edits
     * unsent, for the user to take out or let go (see discard); only the server, answering again,
     * says whether this device may edit. One turned away with nothing unsent is taken off the device.
     */
    async load(): Promise<KeptProject | null> {
      let kept: KeptProject | null;
      try {
        kept = (await store?.load(key)) ?? null;
      } catch (e) {
        [state, failure] = ['failed', reasonOf(e)];
        return null;
      }
      if (!kept || kept.editable || kept.pending.size) return kept;
      // Not left (kept so by an earlier version): it would keep this device from keeping the project once let in (see merged). Not told when it cannot be taken off: the next open tries again.
      await store?.change(key, (now) => (now && !now.editable && !now.pending.size ? null : now)).catch(() => {});
      return null;
    },
    changed,
    /**
     * The server turned this page away, for `reason`: the copy is kept as one not to open again as
     * editable (see load), so that edits the server refused are not taken offline either, nor sent.
     */
    refused(reason: LinkRefusal): void {
      refusal = reason;
      changed();
    },
    /**
     * Take a copy the server turned away off the device (its edits taken out, or let go), once the
     * write under way is done; one let in since, by another page, stays. Nothing is kept after.
     */
    async discard(): Promise<void> {
      const was = store;
      [store, state, failure] = [null, 'none', null];
      await writing;
      await was?.change(key, (kept) => (kept && !kept.editable ? null : kept));
      notify();
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
