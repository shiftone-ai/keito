import * as Y from 'yjs';
import type { TextDelta } from '../model/delta';
import type { TextAt, TextSession } from '../model/target';
import { boardLines, boardNodes, liveBoard } from './boards';
import type { TextPlace, YMap } from './entries';
import { lineTextPlace } from './lines';
import { nodeTextPlace } from './nodes';

/** How a text is typed into: under what origin, and as part of which history. */
export interface TypingContext {
  /** The origin of each change typed: what `history` tracks as this page's own edits. */
  origin: unknown;
  /** Make a change typed as one transaction under `origin`, as the page's other edits of the board are made. */
  transact(write: () => void): void;
  /** Make a change under `origin` that is no step of `history`: sent as the page's edits are, never undone. */
  outsideHistory(write: () => void): void;
  /** The undo of the edits the typing is part of (a board's). */
  history: Y.UndoManager;
  /** The typing is part of the last step of `history`, else a step of its own. */
  joins: boolean;
  /** Whether the text is still there to type into: false once its node, line or board is gone. */
  alive(): boolean;
}

/**
 * Typing into a Y.Text (see TextSession): the changes go in as typed, under `origin`, and are one
 * step of `history` until the typing ends. Undo while typing takes back what was typed a burst at a
 * time; the step of `history` keeps up with it. Where the text is shown is the caller's.
 */
export function openText(text: Y.Text, context: TypingContext): TextSession {
  const { origin, history } = context;
  const doc = text.doc!;
  const listeners = new Set<Parameters<TextSession['listen']>[0]>();
  /** Set while a change typed here goes in: it is not told back as heard. */
  let typing = false;
  let ended = false;
  /** The step of `history` the typing is: the one it joins, else the one its first change makes. */
  let step = context.joins ? history.undoStack.at(-1) : undefined;
  if (!context.joins) history.stopCapturing();
  /** What was typed here, a burst at a time: its undo and redo are part of the step too. */
  const bursts = new Y.UndoManager(text, { trackedOrigins: new Set([origin]) });
  history.addTrackedOrigin(bursts);

  const added = ({ type, stackItem }: { type: 'undo' | 'redo'; stackItem: unknown }): void => {
    if (type === 'undo') step = stackItem as typeof step;
  };
  history.on('stack-item-added', added);
  const heard = (event: Y.YTextEvent): void => {
    if (!typing) listeners.forEach((hear) => hear(event.delta as TextDelta, !event.transaction.local));
  };
  text.observe(heard);
  const check = (): void => {
    if (context.alive()) return;
    doc.off('afterTransaction', check);
    listeners.forEach((hear) => hear(null, false));
  };
  doc.on('afterTransaction', check);

  const open = (): boolean => !ended && context.alive();

  return {
    value: () => text.toString(),
    edit(delta) {
      if (!open() || !delta.length) return;
      typing = true;
      try {
        context.transact(() => text.applyDelta(delta as never[]));
      } finally {
        typing = false;
      }
    },
    listen(hear) {
      listeners.add(hear);
      return () => void listeners.delete(hear);
    },
    undo() {
      if (open()) bursts.undo();
    },
    redo() {
      if (open()) bursts.redo();
    },
    end(keep) {
      if (ended) return;
      ended = true;
      listeners.clear();
      text.unobserve(heard);
      doc.off('afterTransaction', check);
      history.off('stack-item-added', added);
      history.removeTrackedOrigin(bursts);
      bursts.destroy();
      // Not undone when another step has come since: that would take back that one instead.
      if (!keep && step && history.undoStack.at(-1) === step && context.alive()) {
        history.undo();
        history.clear(false, true);
      }
      history.stopCapturing();
    },
  };
}

/** The text at a place, once there. */
function textAt(place: TextPlace | null): Y.Text | null {
  const text = place?.holder.get(place.key);
  return text instanceof Y.Text ? text : null;
}

/**
 * Typing into a text not there yet, which a board holds only once it is typed into (a name a legend
 * gives a row): the first thing typed here puts it at `place`, or someone else does meanwhile, and
 * the text then there is typed into (see openText). Opening it writes nothing. Two who put it there
 * at once, before either hears of the other, leave one text of the two: the one who put the other
 * there types what it held into the one left, so that nobody's letters go with it. Typing ends once
 * the text has no place, or the text typed into was someone else's and is no longer there.
 */
function openAbsent(doc: Y.Doc, place: () => TextPlace | null, context: Omit<TypingContext, 'alive'>): TextSession {
  type Typed = { session: TextSession; held: string; own: boolean };
  const listeners = new Set<Parameters<TextSession['listen']>[0]>();
  const tell = (delta: TextDelta | null, received = false): void => listeners.forEach((hear) => hear(delta, received));
  /** The typing into the text now there; `held`: what it holds, as last heard; `own`: put there here. */
  let typed: Typed | null = null;
  let ended = false;
  /** Set while the text is put there here: it is taken up where it is put, not as one heard of. */
  let putting = false;

  /**
   * Type into the text now there. `carried`: what the text it takes the place of held, which is
   * typed into it first; where it is typed into shows that and is told the rest as put in after it.
   */
  function take(text: Y.Text, carried: string, own: boolean): void {
    doc.off('afterTransaction', watch);
    const session = openText(text, { ...context, alive: () => textAt(place()) === text });
    const now: Typed = { session, held: '', own };
    typed = now;
    session.listen((delta, received) => {
      if (!delta) return lost(now);
      now.held = session.value();
      tell(delta, received);
    });
    const there = text.toString();
    if (carried) session.edit([{ insert: carried }]);
    now.held = session.value();
    if (there) tell([{ retain: carried.length }, { insert: there }], true);
  }

  /** The text typed into is no longer there: another has its place, or it has none. */
  function lost(was: Typed): void {
    typed = null;
    was.session.end(true);
    const text = textAt(place());
    // Not carried over by one who only typed into it: whoever put it there does, once.
    if (text && was.own) take(text, was.held, false);
    else tell(null);
  }

  /** Until a text is there: take up one someone else puts there, and tell when it has no place any more. */
  function watch(): void {
    if (putting) return;
    const text = textAt(place());
    if (text) take(text, '', false);
    else if (!place()) {
      doc.off('afterTransaction', watch);
      tell(null);
    }
  }
  doc.on('afterTransaction', watch);

  return {
    value: () => typed?.session.value() ?? '',
    edit(delta) {
      if (ended || !delta.length) return;
      const at = typed ? null : place();
      if (at && !at.holder.has(at.key)) {
        putting = true;
        // Not part of the step the typing is: undoing that would take the text off, with what others typed into it since.
        context.outsideHistory(() => at.holder.set(at.key, new Y.Text()));
        putting = false;
        const text = textAt(at);
        if (text) take(text, '', true);
      }
      if (!typed) return;
      typed.session.edit(delta);
      typed.held = typed.session.value();
    },
    listen(hear) {
      listeners.add(hear);
      return () => void listeners.delete(hear);
    },
    undo: () => typed?.session.undo(),
    redo: () => typed?.session.redo(),
    end(keep) {
      ended = true;
      doc.off('afterTransaction', watch);
      listeners.clear();
      typed?.session.end(keep);
      typed = null;
    },
  };
}

/**
 * Where a board holds a text typed by hand (see TextAt), there yet or not; null when what it is of
 * is not there: its board deleted, its node or line taken off, or no text of such a node or line.
 */
function textPlace(ydoc: Y.Doc, board: string, at: TextAt): TextPlace | null {
  if (!liveBoard(ydoc, board)) return null;
  const node = boardNodes(ydoc, board)?.get(at.id);
  if (node instanceof Y.Map) return nodeTextPlace(node as YMap, at);
  const line = boardLines(ydoc, board)?.get(at.id);
  return line instanceof Y.Map ? lineTextPlace(line as YMap, at) : null;
}

/**
 * Type into a text of a board (see textPlace, openText, openAbsent): null when it has no place, or
 * what is at its place is no text. `editing`: whether the page still edits the project; typing ends
 * once it does not.
 */
export function typeIntoBoard(ydoc: Y.Doc, board: string, at: TextAt, context: Omit<TypingContext, 'alive'> & { editing(): boolean }): TextSession | null {
  const place = (): TextPlace | null => (context.editing() ? textPlace(ydoc, board, at) : null);
  const now = place();
  if (!now) return null;
  const text = textAt(now);
  if (text) return openText(text, { ...context, alive: () => textAt(place()) === text });
  return now.holder.has(now.key) ? null : openAbsent(ydoc, place, context);
}
