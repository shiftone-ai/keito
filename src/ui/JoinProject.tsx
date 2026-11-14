import { useEffect, useId, useRef, useState } from 'react';
import { keepJoin, readJoinLink } from '../collab/join';
import { openCollab } from '../model/store';
import { composing } from './keys';

/**
 * Joining a shared project by its join link, pasted in: what opens it where there is no address to
 * open the link in (the desktop app). The window stays while the project cannot be opened, the user
 * told why (see openCollab), and closes once it is on screen, the link's credential kept for the
 * project's address to open it again (after ⌘R).
 */
export function JoinProject({ close }: { close: () => void }) {
  const [link, setLink] = useState('');
  const [wrong, setWrong] = useState(false);
  const [joining, setJoining] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const said = useId();
  // The field that takes the IME's typing on a selected shape lets go of the focus while this is open (see Canvas's ImeCatcher).
  useEffect(() => {
    window.dispatchEvent(new Event('keito:overlay'));
    return () => void window.dispatchEvent(new Event('keito:overlay'));
  }, []);

  async function join(): Promise<void> {
    const found = readJoinLink(link);
    setWrong(!found);
    if (!found || joining) return;
    setJoining(true);
    // Held on the field, not left on the page (where a click on 参加 puts it): the window's keys go on working.
    field.current?.focus();
    const opened = await openCollab(found);
    setJoining(false);
    if (!opened) {
      field.current?.select();
      return;
    }
    // Not kept before: a link turned away would take the place of the credential that opens the project now.
    keepJoin(found);
    close();
  }

  return (
    <div className="modal-bg" onPointerDown={close}>
      <div
        className="modal join-project"
        role="dialog"
        aria-modal="true"
        aria-label="共有案件に参加"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (composing(e)) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          } else if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
            e.preventDefault();
            void join();
          } else if (e.key === 'Tab') {
            // Kept within the window: behind it, the project menu would open under it and take the typing.
            e.preventDefault();
            const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled)')];
            const at = stops.indexOf(document.activeElement as HTMLElement);
            stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
          }
        }}
      >
        <header>
          <h2>共有案件に参加</h2>
          <button onClick={close} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span>参加リンク</span>
            <input
              ref={field}
              autoFocus
              value={link}
              aria-invalid={wrong}
              aria-describedby={wrong ? said : undefined}
              spellCheck={false}
              onChange={(e) => {
                setLink(e.target.value);
                setWrong(false);
              }}
            />
          </label>
          {wrong && (
            <p className="error" id={said} role="alert">
              参加リンクではありません（招待で受け取ったリンクを貼ってください）
            </p>
          )}
          <div className="join-project-actions">
            <button className="primary" disabled={!link.trim() || joining} onClick={() => void join()}>
              {joining ? '接続中…' : '参加'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
