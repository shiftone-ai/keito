import type { TextSession } from '../model/target';
import { type TextField, type Typing, bindField } from '../ui/typing';

/** Whether `br` ends an editable: the last thing in it, there only so that an empty last line shows. */
function closing(el: HTMLElement, br: Node): boolean {
  for (let n: Node | null = br; n && n !== el; n = n.parentNode) if (n.nextSibling) return false;
  return true;
}

/** An editable's text, a line break for each <br> but one ending it; and where a point of it is in that text (-1 when not in it). */
function editableText(el: HTMLElement, point?: { node: Node; offset: number }): { text: string; at: number } {
  let text = '';
  let at = -1;
  const visit = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      if (n === point?.node) at = text.length + point.offset;
      text += (n as Text).data;
      return;
    }
    if (n.nodeName === 'BR') {
      if (!closing(el, n)) text += '\n';
      return;
    }
    n.childNodes.forEach((child, i) => {
      if (n === point?.node && i === point.offset) at = text.length;
      visit(child);
    });
    if (n === point?.node && point.offset >= n.childNodes.length) at = text.length;
  };
  visit(el);
  return { text, at };
}

/** An editable element as a TextField: its text nodes hold the text, a <br> ending it shows an empty last line. */
export function editableField(el: HTMLElement): TextField {
  return {
    read() {
      const { text } = editableText(el);
      const sel = window.getSelection();
      if (!sel?.anchorNode || !sel.focusNode || !el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return { text, range: [text.length, text.length] };
      const anchor = editableText(el, { node: sel.anchorNode, offset: sel.anchorOffset }).at;
      const focus = editableText(el, { node: sel.focusNode, offset: sel.focusOffset }).at;
      return { text, range: [anchor, focus] };
    },
    write(text, [anchor, focus]) {
      el.textContent = text;
      if (text.endsWith('\n')) el.appendChild(document.createElement('br'));
      if (document.activeElement !== el) return;
      const node = el.firstChild?.nodeType === Node.TEXT_NODE ? el.firstChild : null;
      const point = (i: number): [Node, number] => (node ? [node, Math.min(i, text.length)] : [el, 0]);
      window.getSelection()?.setBaseAndExtent(...point(anchor), ...point(focus));
    },
  };
}

/**
 * Keep an editable typed into the same as a shared text (see bindField). Line breaks, pastes and
 * drops go in as plain text (`oneLine`: line breaks as spaces); undo and redo are the session's,
 * since the browser's own knows nothing of what others typed.
 */
export function typeIntoEditable(el: HTMLElement, session: TextSession, options: { oneLine: boolean; typed?(): void; gone?(): void }): Typing {
  const typing = bindField(editableField(el), session, options);
  const plain = (text: string): string => {
    const lines = text.replace(/\r\n?/g, '\n');
    return options.oneLine ? lines.replace(/\n/g, ' ') : lines;
  };
  const before = (e: InputEvent): void => {
    if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
      e.preventDefault();
      typing.insert(plain('\n'));
    } else if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      if (e.inputType === 'historyUndo') typing.undo();
      else typing.redo();
    } else if (e.inputType === 'insertFromDrop' || e.inputType === 'deleteByDrag' || e.inputType.startsWith('format')) e.preventDefault();
  };
  const paste = (e: ClipboardEvent): void => {
    e.preventDefault();
    typing.insert(plain(e.clipboardData?.getData('text/plain') ?? ''));
  };
  // The browser's undo would not be asked for by the keys once it has nothing of its own to undo.
  const keys = (e: KeyboardEvent): void => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
    // With the IME on, the letter comes as "Process" (keyCode 229), as on the board (see App).
    const key = e.keyCode === 229 && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    e.preventDefault();
    if (key === 'y' || e.shiftKey) typing.redo();
    else typing.undo();
  };
  const input = (e: Event): void => typing.input((e as InputEvent).isComposing);
  const listening = new AbortController();
  const { signal } = listening;
  el.addEventListener('beforeinput', before, { signal });
  el.addEventListener('paste', paste, { signal });
  el.addEventListener('keydown', keys, { signal });
  el.addEventListener('input', input, { signal });
  el.addEventListener('compositionstart', typing.compositionStart, { signal });
  el.addEventListener('compositionend', typing.compositionEnd, { signal });
  return {
    ...typing,
    close() {
      listening.abort();
      typing.close();
    },
  };
}
