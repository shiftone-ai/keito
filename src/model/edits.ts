import { pinComments } from './comments';
import { fingerprint, stillIn } from './history';
import { fitLegends } from './legend';
import type { State } from './store';
import type { Edits } from './target';
import type { Doc } from './types';

/** Undo steps kept for a board. */
const HISTORY = 100;

/** What the edits of a board of this machine's store need of the edit session. */
export interface EditsHost {
  get(): State;
  set(change: Partial<State> | ((s: State) => Partial<State>)): void;
  /** Start an operation on the board as it is (the session's checkpoint). */
  checkpoint(): void;
}

/** The undo steps of a board left for another tab, and where it was looked at. */
export type KeptSteps = Pick<State, 'past' | 'future' | 'view'>;

export interface LocalEdits extends Edits {
  /** The steps kept for a board shown again, if it is still the drawing it was left as; taken up once. */
  takeUp(doc: Doc): KeptSteps | null;
  /** Forget the steps of every board left. */
  clear(): void;
}

/**
 * The edits of a board of this machine's store. It takes every tool; its undo steps are the board as
 * it was before each operation. Those of a board left for another tab in this window are kept for
 * coming back to it, and taken up again only if the board is still the drawing it was (not changed
 * meanwhile from the command line, say), where those steps still apply.
 */
export function localEdits(host: EditsHost): LocalEdits {
  const kept = new Map<string, KeptSteps & { print: string }>();
  /** The redo steps the last operation's beginning cleared, with the steps it left: put back if it is called off. */
  let cleared: { past: Doc[]; future: Doc[] } | null = null;
  return {
    takes: () => true,
    edit(next, record) {
      if (record) host.checkpoint();
      host.set({ doc: fitLegends(pinComments(host.get().doc, next)) });
    },
    begin() {
      const s = host.get();
      const past = [...s.past.slice(-HISTORY), s.doc];
      cleared = { past, future: s.future };
      host.set({ past, future: [] });
    },
    // Nothing waits for the end: each edit is written as it is made (see autosave).
    end: () => {},
    drop() {
      const s = host.get();
      const doc = s.past.at(-1);
      if (!doc) return false;
      // Only while the steps are still the ones it left: after an undo or redo since, they belong to that.
      const future = cleared?.past === s.past ? cleared.future : s.future;
      cleared = null;
      host.set({ doc: { ...doc, revisions: s.doc.revisions }, past: s.past.slice(0, -1), future, selection: [], editing: null });
      return true;
    },
    // The board's history list is not part of the drawing: undo takes back drawing, never a kept state.
    // What was selected stays selected where it is still there, to try the next change on it.
    undo: () =>
      host.set((s) => {
        const doc = s.past[s.past.length - 1];
        return doc ? { doc: { ...doc, revisions: s.doc.revisions }, past: s.past.slice(0, -1), future: [s.doc, ...s.future], selection: stillIn(doc, s.selection), editing: null } : s;
      }),
    redo: () =>
      host.set((s) => {
        const doc = s.future[0];
        return doc ? { doc: { ...doc, revisions: s.doc.revisions }, past: [...s.past, s.doc], future: s.future.slice(1), selection: stillIn(doc, s.selection), editing: null } : s;
      }),
    keepSteps(was) {
      // The steps of an older state on screen are not the board's.
      if (!was.viewing) kept.set(was.doc.id, { past: was.past, future: was.future, view: was.view, print: fingerprint(was.doc) });
    },
    takeUp(doc) {
      const back = kept.get(doc.id);
      kept.delete(doc.id);
      return back && back.print === fingerprint(doc) ? back : null;
    },
    clear: () => kept.clear(),
    // The field typed into holds the text until it is written whole (see TextEditor in Canvas.tsx).
    typeInto: () => null,
  };
}
