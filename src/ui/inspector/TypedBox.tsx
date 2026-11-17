import { type KeyboardEvent, useLayoutEffect, useRef } from 'react';
import { useStore } from '../../model/store';
import type { TextAt, TextSession } from '../../model/target';
import { composing } from '../keys';
import { type TextField, type Typing, bindField } from '../typing';
import { hearTyping } from '../typingEvents';

type Box = HTMLInputElement | HTMLTextAreaElement;

/**
 * A text as a box shows it: a space for each character the box would leave out or put another for
 * (an input, a line break; a textarea, a carriage return), so that a place in what it shows is the
 * same place in the text.
 */
const shownIn = (oneLine: boolean, text: string): string => text.replace(oneLine ? /[\r\n]/g : /\r/g, ' ');

/** An input or a textarea as a TextField (see shownIn). */
function boxField(el: Box): TextField {
  const oneLine = el instanceof HTMLInputElement;
  return {
    read() {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      return { text: el.value, range: el.selectionDirection === 'backward' ? [end, start] : [start, end] };
    },
    write(text, [anchor, focus]) {
      el.value = shownIn(oneLine, text);
      el.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus), anchor > focus ? 'backward' : 'forward');
    },
  };
}

/**
 * A box of the inspector for a text of the board typed by hand (a name, a note), on a board that
 * takes such a text only as it is typed (see Edits.typeInto), never written whole. From its focus
 * until it is left, what is typed goes into the text letter by letter, what others type into it is
 * shown with the caret and the selection kept on what they were on, and a conversion under way (IME)
 * is left alone (see bindField). What is typed until the box is left (or Enter, in a box of one
 * line) is one step to undo; undo in the box takes back what was typed there. `lines`: one (an
 * input), or several, in a box of a fixed height or one that grows with them.
 */
export function TypedBox({ at, value, lines = 'one', placeholder }: { at: TextAt; value: string; lines?: 'one' | 'several' | 'grow'; placeholder?: string }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const typed = useRef<{ session: TextSession; typing: Typing; listening: AbortController } | null>(null);
  const shown = shownIn(lines === 'one', value);

  // Not while typed into: a value set here would put the caret at its end, and end a conversion under way.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !typed.current && el.value !== shown) el.value = shown;
  });

  /** Stop typing into the text: what was typed stays, one step to undo. */
  function close(): void {
    const was = typed.current;
    if (!was) return;
    typed.current = null;
    was.typing.flush();
    was.listening.abort();
    was.typing.close();
    was.session.end(true);
  }

  /** Type into the text from the box, which has the focus; a box whose text is not there takes nothing. */
  function open(): void {
    const el = ref.current;
    if (!el || typed.current) return;
    const s = useStore.getState();
    // Ended first: a burst of changes still under way (see useBurst) would otherwise be written after the typing, as a later step.
    s.commitOperation();
    const session = s.typeInto(at, false);
    el.readOnly = !session;
    if (!session) return;
    const field = boxField(el);
    field.write(session.value(), field.read().range);
    const listening = new AbortController();
    /** The text is no longer where it was: typed into where it is now (its device made one with another board's), if it is anywhere. */
    const gone = (): void => {
      close();
      open();
    };
    const typing = bindField(field, session, { gone });
    hearTyping(el, typing, listening.signal);
    typed.current = { session, typing, listening };
  }

  useLayoutEffect(
    () => () => {
      // Taken away while it has the focus (its port taken off by someone else, its node still selected): nothing
      // stays selected, or the keys that follow, meant for the text, would rename or delete that on the board.
      if (document.activeElement === ref.current) useStore.getState().select([]);
      close();
    },
    [],
  );

  const props = {
    ref,
    placeholder,
    onFocus: open,
    onBlur: close,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || lines !== 'one' || composing(e)) return;
      close();
      open();
    },
  };
  return lines === 'one' ? <input {...props} /> : <textarea className={lines === 'grow' ? 'wrap' : undefined} rows={lines === 'grow' ? 1 : 4} {...props} />;
}
