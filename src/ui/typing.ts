import { type TextDelta, deltaBetween, mapIndex, rebase } from '../model/delta';
import type { TextSession } from '../model/target';

/** What of a field's text is selected: where the selection began and where it ends (the caret), one place for a caret alone. */
export type TextRange = readonly [anchor: number, focus: number];

/** A field typed into, as plain text: what it shows and what of it is selected. */
export interface TextField {
  read(): { text: string; range: TextRange };
  /** Show `text`, with `range` selected. */
  write(text: string, range: TextRange): void;
}

/** A field kept the same as a text others type into too (see bindField), told what happens in it. */
export interface Typing {
  /** The field changed by itself (a letter typed, a deletion, a cut). `composing`: part of a conversion still under way (IME). */
  input(composing: boolean): void;
  compositionStart(): void;
  compositionEnd(): void;
  /** Put `text` in place of what is selected, as typed: a line break, what is pasted. */
  insert(text: string): void;
  undo(): void;
  redo(): void;
  /** Send what the field holds now. */
  flush(): void;
  /** Stop keeping the field with the text. */
  close(): void;
}

/** A selection once `delta` is made to the text: a caret stays before what is put in at it, a selection keeps out what is put in at its ends. */
function mapRange([anchor, focus]: TextRange, delta: TextDelta): TextRange {
  if (anchor === focus) {
    const at = mapIndex(anchor, delta, true);
    return [at, at];
  }
  const start = mapIndex(Math.min(anchor, focus), delta, false);
  const end = Math.max(start, mapIndex(Math.max(anchor, focus), delta, true));
  return anchor < focus ? [start, end] : [end, start];
}

/**
 * Keep a field the same as a text others type into too (see TextSession). What is typed goes in as
 * a change to the text (never the field's whole text in place of it); what others type is shown in
 * the field with the selection kept on what it was on. While the IME converts, the field is left
 * alone and what others type is held back, to be shown once the conversion is put down, which goes
 * where it was typed. `typed`: after a change typed is sent; `gone`: the text is no longer there.
 */
export function bindField(field: TextField, session: TextSession, on: { typed?(): void; gone?(): void } = {}): Typing {
  /** The text as the field shows it with every change typed there sent: what the next change is read against. */
  let shown = field.read().text;
  /** What others did to the text and the field does not show yet, in order, each a change to what the one before made of `shown`. */
  let unseen: TextDelta[] = [];
  let composing = false;
  /** A conversion just put down, sent once its last events are in (WebKit sends some after compositionend). */
  let ending: ReturnType<typeof setTimeout> | undefined;

  const settle = (): void => {
    clearTimeout(ending);
    ending = undefined;
  };

  /**
   * Send what was typed since `shown`, made to follow what others did meanwhile. Where both put
   * characters at one place, what was typed here goes first, as a caret stays before what others
   * put in at it (see mapRange): a conversion goes down right after what was typed before it.
   */
  function send(): void {
    const { text, range } = field.read();
    if (text === shown) return;
    let change = deltaBetween(shown, text, range[1]);
    unseen = unseen.map((heard) => {
      const after = rebase(change, heard, true);
      change = rebase(heard, change, false);
      return after;
    });
    shown = text;
    session.edit(change);
    on.typed?.();
  }

  /** Show what others did that the field does not show yet. */
  function show(): void {
    if (!unseen.length) return;
    let range = field.read().range;
    for (const heard of unseen) range = mapRange(range, heard);
    unseen = [];
    shown = session.value();
    field.write(shown, range);
  }

  /** Send what was typed, then show what others did. */
  const sync = (): void => {
    send();
    show();
  };

  const stop = session.listen((heard) => {
    if (!heard) return on.gone?.();
    unseen.push(heard);
    if (!composing && ending === undefined) sync();
  });

  function flush(): void {
    settle();
    send();
    if (!composing) show();
  }

  return {
    input(isComposing) {
      if (isComposing || composing) return;
      settle();
      sync();
    },
    compositionStart() {
      // The conversion just put down goes out now, but the field is not written once the next one is under way.
      if (ending !== undefined) {
        settle();
        send();
      }
      composing = true;
    },
    compositionEnd() {
      composing = false;
      settle();
      ending = setTimeout(() => {
        ending = undefined;
        sync();
      });
    },
    insert(text) {
      if (composing) return;
      settle();
      send();
      const [anchor, focus] = field.read().range;
      const from = Math.min(anchor, focus);
      const at = from + text.length;
      field.write(shown.slice(0, from) + text + shown.slice(Math.max(anchor, focus)), [at, at]);
      sync();
    },
    undo() {
      flush();
      session.undo();
    },
    redo() {
      flush();
      session.redo();
    },
    flush,
    close() {
      settle();
      stop();
    },
  };
}
