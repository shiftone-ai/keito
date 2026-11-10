import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Whether a key goes to a control that acts on it (Space and Enter press a focused button) — one
 * reached from the keyboard. A button clicked with the mouse keeps the focus in Chrome (not in
 * WebKit): Space then pans and Enter edits, as anywhere on the board, rather than press it again.
 */
export function onControl(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement && (/^(BUTTON|A|SUMMARY)$/.test(t.tagName) || t.getAttribute('role') === 'button'))) return false;
  try {
    return t.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * ⌘⇧] and ⌘⇧[ (Ctrl+Shift on Windows), the keys other apps go to the next and the previous tab
 * with: 1, −1, or 0 for any other key. Told by the character, not by the key's place, which differs
 * on a Japanese keyboard; with ⌘ held, the character may come with Shift ({ }) or without.
 */
export function tabStep(e: KeyboardEvent): -1 | 0 | 1 {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return 0;
  if (e.key === '[' || e.key === '{') return -1;
  if (e.key === ']' || e.key === '}') return 1;
  return 0;
}

/** The hidden field that takes the IME's typing on a selected shape (Windows; see Canvas's ImeCatcher). */
export const isCatcher = (t: EventTarget | null): boolean => t instanceof HTMLElement && t.classList.contains('ime-catcher');

/**
 * Whether a key press belongs to the IME: still composing, or the Enter that confirms a
 * conversion. WebKit (Safari, and the macOS app's webview) ends the composition before that Enter
 * arrives, so it comes with isComposing false and keyCode 229 — and must not submit anything.
 */
export function composing(e: ReactKeyboardEvent | KeyboardEvent): boolean {
  const key = 'nativeEvent' in e ? e.nativeEvent : e;
  return key.isComposing || key.keyCode === 229;
}
