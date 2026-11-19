import { type TextDelta, deltaBetween, mapIndex, rebase } from '../model/delta';
import type { TextSession } from '../model/target';

/** What of a field's text is selected: where the selection began and where it ends (the caret), one place for a caret alone. */
export type TextRange = readonly [anchor: number, focus: number];

/**
 * A field typed into, as plain text: what it shows and what of it is selected. It shows a text
 * character for character (one it cannot show, as another: a place in what it shows is a place in
 * the text).
 */
export interface TextField {
  read(): { text: string; range: TextRange };
  /** Show `text`, with `range` selected. */
  write(text: string, range: TextRange): void;
}

/** Changes a field's owner may act on while typing (see bindField). */
export interface TypingEvents {
  typed?(): void;
  heard?(): void;
  gone?(): void;
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
  /**
   * Go on with `next`, a typing into the text where it is now, the one before being gone (see
   * bindField's `gone`): what the text holds there is shown as others' typing is, and what is typed
   * and not yet sent (a conversion under way) goes into it.
   */
  follow(next: TextSession): void;
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
 * where it was typed. `typed`: after a change typed is sent; `heard`: when another editor's change
 * arrives; `gone`: the text is no longer there (the field may then `follow` a typing into it elsewhere).
 */
export function bindField(field: TextField, first: TextSession, on: TypingEvents = {}): Typing {
  /** The typing the field is kept with: `first`, then one the field follows. */
  let session = first;
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
    field.write(session.value(), range);
    // Not the text itself: a character the field shows as another (a line break, on one line) is not one typed there.
    shown = field.read().text;
  }

  /** Send what was typed, then show what others did. */
  const sync = (): void => {
    send();
    show();
  };

  /** Take in what others did to the text, shown now unless a conversion is under way. */
  const hear = (heard: TextDelta | null, received = false): void => {
    if (!heard) return on.gone?.();
    if (received) on.heard?.();
    unseen.push(heard);
    if (!composing && ending === undefined) sync();
  };
  let stop = session.listen(hear);

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
    follow(next) {
      stop();
      session = next;
      stop = next.listen(hear);
      // In place of what was heard of the text before: all of that is in what the text holds now.
      unseen = [];
      hear(deltaBetween(shown, next.value(), 0));
    },
    close() {
      settle();
      stop();
    },
  };
}
