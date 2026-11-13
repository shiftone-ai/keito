import * as Y from 'yjs';
import type { TextDelta } from '../model/delta';
import type { TextAt, TextSession } from '../model/target';
import { boardLines, boardNodes, liveBoard } from './boards';

/** How a text is typed into: under what origin, and as part of which history. */
export interface TypingContext {
  /** The origin of each change typed: what `history` tracks as this page's own edits. */
  origin: unknown;
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
  const listeners = new Set<(delta: TextDelta | null) => void>();
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
    if (!typing) listeners.forEach((hear) => hear(event.delta as TextDelta));
  };
  text.observe(heard);
  const check = (): void => {
    if (context.alive()) return;
    doc.off('afterTransaction', check);
    listeners.forEach((hear) => hear(null));
  };
  doc.on('afterTransaction', check);

  const open = (): boolean => !ended && context.alive();

  return {
    value: () => text.toString(),
    edit(delta) {
      if (!open() || !delta.length) return;
      typing = true;
      try {
        doc.transact(() => text.applyDelta(delta as never[]), origin);
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

/**
 * A text of a board typed by hand (see TextAt), as nodes.ts and lines.ts hold it; null for one not
 * there: its board deleted, its node or line taken off, or a field it has no text under.
 */
function boardText(ydoc: Y.Doc, board: string, at: TextAt): Y.Text | null {
  if (!liveBoard(ydoc, board)) return null;
  for (const part of [boardNodes(ydoc, board), boardLines(ydoc, board)]) {
    const item = part?.get(at.id);
    if (!(item instanceof Y.Map)) continue;
    const text = item.get(at.field);
    return text instanceof Y.Text ? text : null;
  }
  return null;
}

/**
 * Type into a text of a board (see boardText, openText): null when it is not there. `editing`:
 * whether the page still edits the project; typing ends once it does not.
 */
export function typeIntoBoard(ydoc: Y.Doc, board: string, at: TextAt, context: Omit<TypingContext, 'alive'> & { editing(): boolean }): TextSession | null {
  const text = context.editing() ? boardText(ydoc, board, at) : null;
  return text && openText(text, { ...context, alive: () => context.editing() && boardText(ydoc, board, at) === text });
}
