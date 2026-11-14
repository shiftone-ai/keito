import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { sharedName } from '../collab/pictureRef';
import type { PictureStatus, PictureView, SharedPictures } from '../collab/pictures';
import { UI_FONT, measure } from '../model/text';
import type { ImageNode } from '../model/types';

/**
 * The pictures of the shared project on screen, and the zoom the board is drawn at, as the canvas
 * gives them (see ScreenPictures). Not from the app's store: the board is drawn for exports and
 * tests too, with neither.
 */
export const PictureSource = createContext<{ pictures: SharedPictures | null; zoom: number }>({ pictures: null, zoom: 1 });

/** A picture no project of this page has (a board of this machine holding one, an export): nothing to fetch it with. */
const NOWHERE: PictureView = { status: 'unreachable', url: null, reason: null };

/**
 * What a picture not shown as it stands is labelled with, and whether it is something to act on.
 * What is tried again by itself is said not to have happened yet (できていません), not to be impossible.
 */
const LABELS: Record<Exclude<PictureStatus, 'shown'>, { text: string; alarm: boolean }> = {
  unsent: { text: '未送信', alarm: false },
  sending: { text: '送信中', alarm: false },
  resending: { text: '再送中', alarm: false },
  failed: { text: '送信できていません', alarm: true },
  unkept: { text: '端末に保存できません', alarm: true },
  refused: { text: '共有できない画像です', alarm: true },
  loading: { text: '読み込み中', alarm: false },
  waiting: { text: '画像の到着待ち', alarm: false },
  unreachable: { text: '画像を取得できていません', alarm: true },
  denied: { text: '画像を開けません', alarm: true },
};

/** Drawn in colours of its own, not the page's styles: an export of the board has none of those. */
const CALM = { fill: '#f8fafc', badge: '#ffffff', edge: '#e2e8f0', ink: '#1e293b', sub: '#5b6b81' };
const ALARM_COLORS = { fill: '#fef2f2', badge: '#fef2f2', edge: '#b91c1c', ink: '#b91c1c', sub: '#b91c1c' };

const PICTURE = 'M3 4h14v12H3zM3 13l4-4 3 3 3-4 4 5M7 7.5h.01';
const UPLOAD = 'M6 9.5V3M3.5 5.5 6 3l2.5 2.5';
const ALARM = 'M6 3v4M6 9.2h.01';

/** The badge's size on screen, whatever the zoom. */
const BADGE = { pad: 6, height: 20, icon: 12, size: 11, inset: 6 };
const LINE = { fill: 'none', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/**
 * A picture of a shared project on its board: shown once its bytes are on this page, else its place
 * on the board and why it is not shown (not come yet, not fetched). One put on the board here and
 * not yet on the server is labelled with how its sending stands.
 */
export function SharedPicture({ n }: { n: ImageNode }) {
  const { pictures, zoom } = useContext(PictureSource);
  const name = sharedName(n.src) ?? '';
  const watch = useCallback((hear: () => void) => (pictures ? pictures.watch(name, hear) : () => {}), [pictures, name]);
  const view = useSyncExternalStore(watch, () => (pictures ? pictures.view(name) : NOWHERE), () => NOWHERE);
  const { x, y, w, h } = n;
  if (view.url) {
    const picture = <image href={view.url} x={x} y={y} width={w} height={h} preserveAspectRatio="xMidYMid meet" />;
    if (view.status === 'shown') return picture;
    const label = LABELS[view.status];
    const c = label.alarm ? ALARM_COLORS : CALM;
    const full = BADGE.pad * 2 + BADGE.icon + 4 + measure(label.text, `600 ${BADGE.size}px ${UI_FONT}`);
    // Wider than the picture on screen, it is shown as its icon alone (the words stay in its title).
    const words = full + BADGE.inset * 2 <= w * zoom;
    const bw = words ? full : BADGE.pad * 2 + BADGE.icon;
    return (
      <>
        {picture}
        <g className="picture-badge" transform={`translate(${x + BADGE.inset / zoom},${y + BADGE.inset / zoom}) scale(${1 / zoom})`}>
          <title>{view.reason ?? label.text}</title>
          <rect width={bw} height={BADGE.height} rx={BADGE.height / 2} fill={c.badge} stroke={c.edge} />
          <g transform={`translate(${BADGE.pad},${(BADGE.height - BADGE.icon) / 2})`} stroke={c.ink} {...LINE}>
            {label.alarm && <circle cx={6} cy={6} r={5.5} />}
            <path d={label.alarm ? ALARM : UPLOAD} />
          </g>
          {words && (
            <text x={BADGE.pad + BADGE.icon + 4} y={BADGE.height / 2 + BADGE.size * 0.36} fontSize={BADGE.size} fontWeight={600} fontFamily={UI_FONT} fill={c.ink}>
              {label.text}
            </text>
          )}
        </g>
      </>
    );
  }
  const label = LABELS[view.status === 'shown' ? 'loading' : view.status];
  const c = label.alarm ? ALARM_COLORS : CALM;
  // The glyph and the words shrink with a small picture, the words left out of one too small to read.
  const k = Math.min(1, w / 160, h / 90);
  const size = 12 * k;
  return (
    <g className="picture-state">
      {view.reason && <title>{view.reason}</title>}
      <rect x={x} y={y} width={w} height={h} rx={4} fill={c.fill} stroke={c.sub} strokeWidth={1.2} strokeDasharray="6 4" />
      <path d={PICTURE} transform={`translate(${x + w / 2 - 10 * k * 1.2},${y + h / 2 - (size >= 7 ? 26 : 12) * k}) scale(${1.2 * k})`} stroke={c.sub} {...LINE} strokeWidth={1.5} />
      {size >= 7 && (
        <text x={x + w / 2} y={y + h / 2 + 14 * k} fontSize={size} fontFamily={UI_FONT} textAnchor="middle" fill={c.sub}>
          {label.text}
        </text>
      )}
    </g>
  );
}
