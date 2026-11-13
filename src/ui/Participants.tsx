import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { type Me, myself } from '../collab/me';
import { COLORS, type Color, NAME_MAX } from '../collab/presence';
import { type CollabState, useStore } from '../model/store';
import { composing } from './keys';

/** The most faces shown on the button; the rest are counted. */
const FACES = 4;
/** Each colour as the screen names it. */
const COLOR_NAMES: Record<Color, string> = { '#c2410c': 'オレンジ', '#15803d': '緑', '#7e22ce': '紫', '#be185d': 'ピンク', '#0e7490': '青緑', '#a16207': '黄土色' };
/** The colour an arrow key moves to, from the one picked. */
const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Someone in the project: the first letter of their name, in their colour. */
function Face({ name, color, away }: { name: string; color: string; away?: boolean }) {
  return (
    // Hollow while away: dimmed, its letter would be too faint to read.
    <span className={`face${away ? ' away' : ''}`} style={away ? { color, borderColor: color } : { background: color }} aria-hidden="true">
      {[...name.trim()][0] ?? ''}
    </span>
  );
}

/**
 * Who is in the shared project on screen, over the board's lower right corner: this page's user first,
 * then the others (hollow while on another board). Opened, it lists them with the board each is on,
 * and this user picks the name and colour they show themselves by, kept as it closes.
 */
export function Participants({ collab }: { collab: CollabState }) {
  const peers = useStore((s) => s.peers);
  const board = useStore((s) => s.doc.id);
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<Me>(myself);
  const pill = useRef<HTMLButtonElement>(null);
  const colors = useRef<HTMLDivElement>(null);
  const titleOf = (id: string): string => collab.boards.find((b) => b.id === id)?.title ?? '';
  const introduce = (next: Me): void => setMe(collab.introduce(next));
  // Not only as the name field is left: WebKit does not tell a field taken off the page that it is left.
  const close = (): void => {
    introduce(me);
    setOpen(false);
  };

  // Said when it opens or closes: the field that takes the IME's typing on a selected shape lets go
  // of the focus while it is open (see Canvas's ImeCatcher).
  useEffect(() => void window.dispatchEvent(new Event('keito:overlay')), [open]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (composing(e)) return;
      if (e.key === 'Escape') {
        // Caught before the page's keys: those would let go of the selection as well.
        e.stopPropagation();
        e.preventDefault();
        close();
        pill.current?.focus();
        return;
      }
      // Other shortcuts (⌘S …) and Tab still work, and keys in the menu go to it; any other key stays
      // out of the board behind it (Delete would remove what is selected there).
      if (e.metaKey || e.ctrlKey || e.key === 'Tab' || (e.target instanceof Element && e.target.closest('.participants-menu'))) return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  const stepColor = (e: ReactKeyboardEvent): void => {
    const step = STEPS[e.key];
    if (!step) return;
    e.preventDefault();
    const at = (COLORS.indexOf(me.color as Color) + step + COLORS.length) % COLORS.length;
    introduce({ ...me, color: COLORS[at] });
    colors.current?.querySelectorAll('button')[at]?.focus();
  };

  const tip = [`${me.name}（自分）`, ...peers.map((p) => `${p.name}（${titleOf(p.board)}）`)].join('、');
  return (
    <div className="participants">
      <button ref={pill} className="faces" onClick={() => (open ? close() : setOpen(true))} aria-expanded={open} aria-label={`参加者 ${peers.length + 1} 人`} data-tip={open ? undefined : tip}>
        <Face name={me.name} color={me.color} />
        {peers.slice(0, FACES).map((p) => (
          <Face key={p.id} name={p.name} color={p.color} away={p.board !== board} />
        ))}
        {peers.length > FACES && <span className="face more">+{peers.length - FACES}</span>}
      </button>
      {open && (
        <>
          <div className="project-menu-bg" onPointerDown={close} />
          {/* Keys typed here stay here: on the board behind it, Delete would remove what is selected. */}
          <div className="participants-menu" role="dialog" aria-label="参加者" onKeyDown={(e) => e.stopPropagation()}>
            <div className="participants-head">自分の表示名と色</div>
            <div className="participant me">
              <Face name={me.name} color={me.color} />
              <input
                aria-label="表示名"
                value={me.name}
                maxLength={NAME_MAX}
                autoFocus
                onChange={(e) => setMe({ ...me, name: e.target.value })}
                onBlur={() => introduce(me)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !composing(e)) e.currentTarget.blur();
                }}
              />
            </div>
            <div ref={colors} className="participant-colors" role="radiogroup" aria-label="色" onKeyDown={stepColor}>
              {COLORS.map((color) => (
                <button key={color} role="radio" aria-checked={me.color === color} tabIndex={me.color === color ? 0 : -1} aria-label={COLOR_NAMES[color]} title={COLOR_NAMES[color]} className={me.color === color ? 'on' : ''} style={{ background: color }} onClick={() => introduce({ ...me, color })} />
              ))}
            </div>
            {peers.length > 0 && (
              <ul>
                {peers.map((p) => (
                  <li key={p.id} className="participant">
                    <Face name={p.name} color={p.color} away={p.board !== board} />
                    <span className="name">{p.name}</span>
                    <small>{titleOf(p.board)}</small>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
