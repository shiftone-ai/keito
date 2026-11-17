/**
 * How the edits this page made, which the server has not confirmed stored, are counted for the user:
 * by operation, as the user made them, not by edit, as they are sent (see protocol.ts). Typing into
 * one text, from opening it to ending the typing, is one operation however many edits it sends (one
 * for each change typed, see typing.ts); any other edit is an operation of its own.
 *
 * An edit's id says which operation it is part of, so that the count holds for the edits kept on this
 * device as well (see kept.ts): after a reload, and for those another page of the device kept there.
 */
import { uuid } from '../model/ids';
import type { TextSession } from '../model/target';

const SEPARATOR = '/';

/** How many operations the edits of the ids `ops` are; an id not made as part of a typing is an operation of its own. */
export const operationsOf = (ops: Iterable<string>): number => new Set(Array.from(ops, (op) => op.split(SEPARATOR, 1)[0])).size;

/** Names a page's edits as they are made, so that `operationsOf` counts those of one typing as one. */
export function editNames() {
  let typingNow: string | null = null;
  let typingOfLastEdit: string | null = null;

  function asPartOf(typing: string | null, make: () => void): void {
    const outer = typingNow;
    typingNow = typing;
    try {
      make();
    } finally {
      typingNow = outer;
    }
  }

  return {
    /** An id for an edit made now. */
    id(): string {
      typingOfLastEdit = typingNow;
      return typingNow ? `${typingNow}${SEPARATOR}${uuid()}` : uuid();
    },
    /**
     * Make an edit that is not typed (`make`): an operation of its own, unless it `joins` this page's
     * last edit and that was of a typing still under way (the box growing for what was typed), which
     * it is then part of.
     */
    edit(joins: boolean, make: () => void): void {
      asPartOf(joins ? typingOfLastEdit : null, make);
    },
    /** `session`, whose edits until it ends are one operation: what is typed, its undo and redo, and calling it off. */
    typing(session: TextSession): TextSession {
      const typing = uuid();
      return {
        ...session,
        edit: (delta) => asPartOf(typing, () => session.edit(delta)),
        undo: () => asPartOf(typing, session.undo),
        redo: () => asPartOf(typing, session.redo),
        end(keep) {
          asPartOf(typing, () => session.end(keep));
          if (typingOfLastEdit === typing) typingOfLastEdit = null;
        },
      };
    },
  };
}
