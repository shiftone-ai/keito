import type { Typing } from './typing';

/**
 * Tell a typing what happens in the element it keeps (an editable, an input, a textarea) until
 * `signal` aborts: what is typed there, the IME's conversions, and undo and redo, which are the
 * typing's, since the browser's own knows nothing of what others typed.
 */
export function hearTyping(el: HTMLElement, typing: Typing, signal: AbortSignal): void {
  const history = (e: InputEvent): void => {
    if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return;
    e.preventDefault();
    if (e.inputType === 'historyUndo') typing.undo();
    else typing.redo();
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
  el.addEventListener('beforeinput', history, { signal });
  el.addEventListener('keydown', keys, { signal });
  el.addEventListener('input', (e) => typing.input((e as InputEvent).isComposing), { signal });
  el.addEventListener('compositionstart', typing.compositionStart, { signal });
  el.addEventListener('compositionend', typing.compositionEnd, { signal });
}
