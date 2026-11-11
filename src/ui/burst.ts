import { useRef } from 'react';
import { useStore } from '../model/store';

/** How long a pause ends a burst of changes (ms). */
const PAUSE = 800;

/**
 * One undo step for a burst of changes from one control: a slider dragged, a colour picker
 * dragged round, a name typed. Call the returned function before each change and make the change
 * without recording it: the first of a burst keeps the board as it was.
 */
export function useBurst(): () => void {
  const last = useRef(0);
  return () => {
    const now = Date.now();
    if (now - last.current > PAUSE) useStore.getState().checkpoint();
    last.current = now;
  };
}

/**
 * One undo step for what is typed into a field between focusing it and leaving it (or pressing Enter
 * in a one-line field). The step ends there, and a shared board sends the change then.
 */
export function useFieldBurst(): { begin(): void; change(): void; end(): void } {
  const dirty = useRef(false);
  return {
    begin: () => void (dirty.current = false),
    change() {
      if (dirty.current) return;
      dirty.current = true;
      useStore.getState().checkpoint();
    },
    end() {
      if (!dirty.current) return;
      dirty.current = false;
      useStore.getState().commitOperation();
    },
  };
}
