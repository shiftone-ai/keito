import type { Backend } from '../platform/storage';
import type { State, Tool } from './store';
import type { Doc } from './types';

/** An action on a board in this machine's store; `current` turns false once another board is on screen. */
export type StoreAction = (b: Backend, current: () => boolean) => Promise<void>;

/**
 * Where the board on screen is kept, chosen as it is put on screen: this machine's store (show) or a
 * shared project (openCollab). All the session does that depends on it goes through it, by what it
 * is for: editing the board, keeping its edits, the boards beside it, and what only this machine's
 * store keeps. Anything new that writes the board belongs here, not in a check of which board is on
 * screen.
 */
export interface Target {
  edits: Edits;
  saving: Saving;
  boards: Boards;
  /** What only this machine's store keeps of the board; null where the board is kept elsewhere. */
  local: LocalStore | null;
  /**
   * Said when the board is asked for what it does not take: an edit `edits.takes` turns away, or
   * something of this machine's store where it is kept elsewhere. null where it takes all of it.
   */
  refusal: string | null;
  /** Stop: nothing more of the board on screen is done through it. */
  close(): void;
}

/** Editing the board: what it takes, an edit, an operation's beginning, end or calling off, and undo. */
export interface Edits {
  /** Whether it takes a tool armed, or text typed in ('typing'). It tells the user nothing (see Target.refusal). */
  takes(what: Tool | 'typing'): boolean;
  /** An edit of the board (setDoc); `record` makes it an operation of its own. */
  edit(next: Doc, record: boolean): void;
  /** An operation begins on the board as it is now (checkpoint). */
  begin(): void;
  /** The operation under way has ended. */
  end(): void;
  /** Call off the last step, leaving it to no redo (dropStep): false when there is none. */
  drop(): boolean;
  undo(): void;
  redo(): void;
  /** The board is left for another (as it was before leaving): what is kept here for a return to it. */
  keepSteps(was: State): void;
}

/** Keeping the board's edits, and what leaving the board or closing the page waits for. */
export interface Saving {
  /** Write what is pending now; whether all of it is kept. */
  flush(): Promise<boolean>;
  /** ⌘S, or "もう一度" after a failed write: what is pending is written now (it is otherwise written by itself). */
  saveNow(): Promise<void>;
  /** Whether the board may be left: its edits kept, or the user letting go of the rest. */
  leave(): Promise<boolean>;
  /** The page is being closed: whether edits would be lost (the browser asks first). */
  closing(): boolean;
  /** The page is going (pagehide): what can still be written is. */
  exit(): void;
  /**
   * Something done alongside the board (a preset, a state of its history, opening another) failed:
   * the board is marked unsaved only if it is.
   */
  failed(): void;
}

/** The boards beside the board on screen (its tabs). */
export interface Boards {
  /** Open one: false when there is none of that id, which is then one of this machine's. */
  open(id: string): boolean;
  /** Delete one: false when there is none of that id, which is then one of this machine's. */
  remove(id: string): boolean;
  /** Show the board's address. */
  address(id: string): void;
}

/** What only this machine's store keeps of the board: its history, its project's other boards, its pictures, and what is written to it elsewhere. */
export interface LocalStore {
  /** Run an action on the board in the store (its history, its project). */
  run(fn: StoreAction): Promise<void>;
  /** Keep a picture for the board; the `src` an image node should hold. */
  keepImage(dataUrl: string): Promise<string>;
  /** The state on screen changed (an edit, another board shown …): what follows from it in the store. */
  changed(s: State, prev: State): void;
  /** Take in the board as the store has it now (written elsewhere meanwhile). */
  pickUp(): void;
  /** Read the other boards of its project, as the store has them. */
  readProject(): Promise<void>;
}
